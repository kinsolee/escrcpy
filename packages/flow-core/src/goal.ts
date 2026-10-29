import type { z } from 'zod'
import {
  attemptsToSteps,
  buildPatch,
  captureHints,
  describeAttempt,
  describeHint,
  executeHealAction,
  HEAL_PROBE_MS,
  HEAL_TOOLS,
  healActionSchema,
  HealError,
  healPatchSchema,
  normalizeTarget,
  parseLooseJson,
} from './heal.js'
import type { HealAttempt, HealElementHint, HealLlmClient, HealLogger, HealPatch } from './heal.js'
import type { ReplayDevice } from './replayer.js'
import type { FlowScript, FlowStep } from './schema.js'

/**
 * Goal-driven recovery: when replay fails outright, an agent explores the device
 * toward the flow's goal description (free navigation within the same action
 * whitelist as step healing), then proposes a patch that repairs or adapts the
 * original recorded script so the next replay survives the drift.
 */

export interface GoalDecision {
  thought?: string
  done: boolean
  reason?: string
  action?: HealActionLike
}

type HealActionLike = z.infer<typeof healActionSchema>

/** Models return `{done, reason}` or `{thought, done:false, action}` — action shapes match step healing. */
export function parseGoalDecision(text: string): GoalDecision {
  const value = parseLooseJson(text) as Record<string, unknown> | null
  if (!value || typeof value !== 'object')
    throw new HealError('目标决策不是 JSON')
  const done = value.done === true
  const thought = typeof value.thought === 'string' ? value.thought : undefined
  const reason = typeof value.reason === 'string' ? value.reason : undefined
  if (done)
    return { thought, done: true, reason }
  let raw = value.action
  if (typeof raw === 'string')
    raw = { tool: raw, target: normalizeTarget(value.target), with: value.with }
  else if (raw && typeof raw === 'object')
    raw = { ...(raw as Record<string, unknown>), target: normalizeTarget((raw as { target?: unknown }).target) }
  const checked = healActionSchema.safeParse(raw)
  if (!checked.success)
    throw new HealError(`动作不在白名单内或格式无效: ${JSON.stringify(raw)?.slice(0, 120) ?? '(缺少 action)'}`)
  return { thought, done: false, action: checked.data }
}

export function buildGoalPrompt(ctx: {
  goal: string
  flow: FlowScript
  error?: string
  context?: string
  visible?: HealElementHint[]
  attempted?: HealAttempt[]
}): string {
  const lines: string[] = []
  lines.push('你是 Android 自动化的目标执行助手。脚本回放已经失败,请在设备上自主探索操作,直到完成下面的任务目标。')
  lines.push('')
  lines.push('## 任务目标')
  lines.push(ctx.goal)
  lines.push('')
  lines.push('## 背景')
  lines.push(`- 流程名称: ${ctx.flow.name}`)
  if (ctx.flow.description)
    lines.push(`- 流程描述: ${ctx.flow.description}`)
  if (ctx.context)
    lines.push(`- ${ctx.context}`)
  lines.push(`- 失败信息: ${ctx.error ?? '(未提供)'}`)
  lines.push('')
  lines.push('## 当前屏幕可见元素')
  const visible = ctx.visible ?? []
  if (!visible.length)
    lines.push('(未获取到屏幕信息)')
  else
    visible.forEach((hint, index) => lines.push(`${index + 1}. ${describeHint(hint)}`))
  lines.push('')
  lines.push('## 已执行动作')
  const attempted = ctx.attempted ?? []
  if (!attempted.length)
    lines.push('(尚未执行)')
  else
    attempted.forEach((attempt, index) => lines.push(`${index + 1}. ${describeAttempt(attempt)}`))
  lines.push('')
  lines.push('## 规则')
  lines.push('- 每次只返回一个 JSON 对象,严格二选一:')
  lines.push('  继续执行: {"thought":"简短想法","done":false,"action":{"tool":"tap","target":[…],"with":{…}}}')
  lines.push('  目标达成: {"thought":"简短想法","done":true,"reason":"判定目标达成的依据"}')
  lines.push(`- tool 只允许:${HEAL_TOOLS.join('、')};禁止 shell、open_url、app_stop 等白名单之外的动作`)
  lines.push('- target 用 selector(resource_id/text/content_desc/class_name/exact/index)或比例坐标 point:[x,y];input_text 用 with.text,key 用 with.key,swipe 用 with.from/with.to(比例坐标),app_start 用 with.package')
  lines.push('- done:true 必须以真实屏幕状态为依据;不确定就继续执行,禁止猜测式完成')
  lines.push('- 只输出 JSON 本身,不要输出解释、Markdown 或代码块')
  return lines.join('\n')
}

export const DEFAULT_MAX_GOAL_ACTIONS = 30

export interface GoalRunOptions {
  goal: string
  flow: FlowScript
  serial: string
  device: ReplayDevice
  client: HealLlmClient
  /** Cap on exploration actions. Default 30. */
  maxActions?: number
  /** How long one action's target lookup waits. Default `HEAL_PROBE_MS`. */
  probeMs?: number
  logger?: HealLogger
  /** The replay error that triggered recovery. */
  error?: string
  /** Extra guidance, e.g. which step broke. */
  context?: string
}

export interface GoalRunResult {
  achieved: boolean
  actions: HealAttempt[]
  /** Executed (successful) actions as flow steps. */
  steps: FlowStep[]
  reason?: string
  durationMs: number
}

/** Explores the device toward `goal`; stops at `done:true` or the action budget. */
export async function runGoalAgent(options: GoalRunOptions): Promise<GoalRunResult> {
  const { goal, flow, serial, device, client } = options
  const maxActions = options.maxActions ?? DEFAULT_MAX_GOAL_ACTIONS
  const probeMs = options.probeMs ?? HEAL_PROBE_MS
  const log = options.logger ?? (() => {})
  const attempts: HealAttempt[] = []
  const started = Date.now()
  for (let index = 1; index <= maxActions; index++) {
    const visible = await captureHints(device, serial, log)
    let decision: GoalDecision
    try {
      const completeText = client.completeText
      if (!completeText)
        throw new HealError('goal agent needs a client with completeText')
      decision = parseGoalDecision(await completeText(buildGoalPrompt({
        goal,
        flow,
        ...(options.error !== undefined ? { error: options.error } : {}),
        ...(options.context !== undefined ? { context: options.context } : {}),
        ...(visible !== undefined ? { visible } : {}),
        attempted: attempts,
      })))
    }
    catch (error) {
      attempts.push({ error: errorMessage(error) })
      log(`goal ${index}/${maxActions}: decision rejected — ${errorMessage(error)}`)
      continue
    }
    if (decision.done) {
      log(`goal: achieved — ${decision.reason ?? decision.thought ?? ''}`)
      return { achieved: true, actions: attempts, steps: attemptsToSteps(attempts), reason: decision.reason ?? decision.thought, durationMs: Date.now() - started }
    }
    const action = decision.action
    if (!action) {
      attempts.push({ reason: decision.thought, error: '未提供 action 或 done' })
      continue
    }
    try {
      await executeHealAction(action, flow, device, serial, probeMs)
    }
    catch (error) {
      attempts.push({ action, reason: decision.thought, error: errorMessage(error) })
      log(`goal ${index}/${maxActions}: ${action.tool} failed — ${errorMessage(error)}`)
      continue
    }
    attempts.push({ action, reason: decision.thought })
    log(`goal ${index}/${maxActions}: ${action.tool} executed${decision.thought ? ` — ${decision.thought}` : ''}`)
  }
  return { achieved: false, actions: attempts, steps: attemptsToSteps(attempts), reason: `已达到动作上限 ${maxActions}`, durationMs: Date.now() - started }
}

export function buildGoalPatchPrompt(ctx: {
  flow: FlowScript
  step: FlowStep
  journal: HealAttempt[]
  goal: string
}): string {
  const lines: string[] = []
  lines.push('你是 Android 自动化脚本的修复助手。原脚本回放失败后,目标执行助手已经通过探索完成了任务。请根据探索记录,为失败步骤生成一个补丁,让原脚本下次能通过。')
  lines.push('')
  lines.push('## 任务目标')
  lines.push(ctx.goal)
  lines.push('')
  lines.push('## 原流程')
  lines.push(`- 名称: ${ctx.flow.name}`)
  lines.push('')
  lines.push('## 失败步骤(原样)')
  lines.push(JSON.stringify(ctx.step))
  lines.push('')
  lines.push('## 探索记录(实际验证过的操作)')
  const executed = ctx.journal.filter(attempt => attempt.action && !attempt.error)
  if (!executed.length)
    lines.push('(无)')
  else
    executed.forEach((attempt, index) => lines.push(`${index + 1}. ${describeAttempt(attempt)}`))
  lines.push('')
  lines.push('## 规则')
  lines.push('- 输出一个 JSON 补丁对象,格式: {"stepId":"失败步骤id","mode":"replace" 或 "insert-before","steps":[…]}')
  lines.push('- replace 表示用 steps 整体替换失败步骤;insert-before 表示在失败步骤前插入 steps(用于补前置动作)')
  lines.push('- steps 是流程步骤数组,元素格式与原流程 steps 相同: id(必填且唯一)/do/target/with/expect/intent/settle')
  lines.push(`- do 只允许:${HEAL_TOOLS.join('、')}(或流程原步骤的 do)`)
  lines.push('- 定位符优先使用探索记录中验证过的 resource_id/text,其次才用比例坐标')
  lines.push('- steps 尽量精简:能一步修复就不要生成多步')
  lines.push('- 只输出 JSON 本身,不要输出解释、Markdown 或代码块')
  return lines.join('\n')
}

export interface GoalPatchOptions {
  flow: FlowScript
  stepId: string
  journal: HealAttempt[]
  client: HealLlmClient
  goal?: string
}

/**
 * Patch proposal for the failed step: the model reviews the exploration journal and
 * suggests locator/step fixes; anything it cannot express falls back to compiling the
 * executed actions mechanically. Undefined when the journal has nothing executed.
 */
export async function proposeGoalPatch(options: GoalPatchOptions): Promise<HealPatch | undefined> {
  const { flow, stepId, journal, client } = options
  const step = flow.steps.find(item => item.id === stepId)
  if (!step)
    throw new HealError(`Unknown step id: ${stepId}`)
  const executed = journal.filter(attempt => attempt.action && !attempt.error)
  if (!executed.length)
    return undefined
  const completeText = client.completeText
  if (completeText) {
    try {
      const text = await completeText(buildGoalPatchPrompt({
        flow,
        step,
        journal,
        goal: options.goal ?? flow.description ?? flow.name,
      }))
      const checked = healPatchSchema.safeParse(parseLooseJson(text))
      if (checked.success && checked.data.stepId === stepId)
        return checked.data
    }
    catch (error) {
      // Fall back to the mechanical patch below.
      void error
    }
  }
  return buildPatch(flow, stepId, journal)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
