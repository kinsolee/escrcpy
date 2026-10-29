import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { extractElements } from '@escrcpy/flow-device'
import type { RatioPoint, Snapshot } from '@escrcpy/flow-device'
import type { Expect, FlowScript, FlowStep, Target } from './schema.js'
import { flowSchema, isImageTarget, isPointTarget, stepSchema, targetListSchema } from './schema.js'
import { replayFlow } from './replayer.js'
import type { ReplayDevice } from './replayer.js'
import { readFlow } from './yaml.js'

/**
 * L2 self-heal agent (design 5.5). When a replay step fails, an LLM is shown the
 * flow context, the failure and the current screen, and may drive the device with
 * a small whitelisted action set until the step's expect holds again. A
 * successful run compiles into a reviewable patch; flow files are never modified
 * until the caller applies the patch and writes the flow explicitly.
 */

export const HEAL_TOOLS = ['tap', 'wait_for', 'input_text', 'key', 'swipe', 'app_start'] as const

export type HealTool = typeof HEAL_TOOLS[number]

/** One whitelisted device action the heal model may pick. `shell`, `open_url` and `app_stop` are deliberately absent. */
export interface HealAction {
  tool: HealTool
  target?: Target[]
  with?: Record<string, unknown>
}

export const healActionSchema = z.object({
  tool: z.enum(HEAL_TOOLS),
  target: targetListSchema.optional(),
  with: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

/** Compact screen element for the prompt: label fields plus a pixel bounds box. */
export interface HealElementHint {
  text?: string
  contentDesc?: string
  /** Tail segment of the resource id, e.g. `settings` for `com.example:id/settings`. */
  resourceId?: string
  bounds: [number, number, number, number]
}

/** One heal round: the action the model chose (when usable), its reason, and any error. */
export interface HealAttempt {
  action?: HealAction
  reason?: string
  error?: string
}

export interface HealPromptContext {
  flow: FlowScript
  step: FlowStep
  /** The replay error that triggered healing. */
  error?: string
  visible?: HealElementHint[]
  attempted?: HealAttempt[]
}

export const MAX_HEAL_HINTS = 40

/** The agent-facing screen summary: labeled elements in reading order, capped at `limit`. */
export function healHints(snapshot: Snapshot, limit = MAX_HEAL_HINTS): HealElementHint[] {
  return extractElements(snapshot.tree).slice(0, limit).map((element) => {
    const hint: HealElementHint = { bounds: [element.bounds.x, element.bounds.y, element.bounds.width, element.bounds.height] }
    if (element.text)
      hint.text = element.text
    if (element.contentDesc)
      hint.contentDesc = element.contentDesc
    if (element.resourceId)
      hint.resourceId = shortResourceId(element.resourceId)
    return hint
  })
}

function shortResourceId(resourceId: string): string {
  return resourceId.split('/').at(-1) || resourceId
}

export function buildHealPrompt(ctx: HealPromptContext): string {
  const { flow, step } = ctx
  const lines: string[] = []
  lines.push('你是 Android 自动化流程的自愈助手。下面的流程步骤回放失败了,请用最少的动作让这一步的期望(expect)重新成立。')
  lines.push('')
  lines.push('## 流程')
  lines.push(`- 名称: ${flow.name}`)
  if (flow.description)
    lines.push(`- 描述: ${flow.description}`)
  lines.push('')
  lines.push('## 失败步骤')
  lines.push(`- 步骤 id: ${step.id}`)
  if (step.intent)
    lines.push(`- intent: ${step.intent}`)
  lines.push(`- 动作: ${step.do}`)
  if (step.target?.length)
    lines.push(`- 原始定位符(按优先级): ${step.target.map(target => JSON.stringify(target)).join(' 或 ')}`)
  if (step.with)
    lines.push(`- 参数: ${JSON.stringify(step.with)}`)
  lines.push(`- 期望(expect): ${JSON.stringify(step.expect ?? null)}`)
  lines.push('')
  lines.push('## 失败错误')
  lines.push(ctx.error ?? '(未提供)')
  lines.push('')
  lines.push('## 当前屏幕可见元素')
  const visible = ctx.visible ?? []
  if (!visible.length) {
    lines.push('(未获取到屏幕信息)')
  }
  else {
    for (const [index, hint] of visible.entries())
      lines.push(`${index + 1}. ${describeHint(hint)}`)
  }
  lines.push('')
  lines.push('## 已尝试的自愈动作')
  const attempted = ctx.attempted ?? []
  if (!attempted.length) {
    lines.push('(尚未尝试)')
  }
  else {
    for (const [index, attempt] of attempted.entries())
      lines.push(`${index + 1}. ${describeAttempt(attempt)}`)
  }
  lines.push('')
  lines.push('## 规则')
  lines.push('- 每次只返回一个动作,严格按 JSON 返回:{"action":{"tool":"tap","target":[…],"with":{…}},"reason":"简短原因"}')
  lines.push(`- tool 只允许:${HEAL_TOOLS.join('、')};禁止 shell、open_url、app_stop 等白名单之外的动作`)
  lines.push('- target 用 selector(resource_id/text/content_desc/class_name/exact/index)或比例坐标 point:[x,y];input_text 用 with.text,key 用 with.key,swipe 用 with.from/with.to(比例坐标),app_start 用 with.package')
  lines.push('- 只输出 JSON 本身,不要输出解释、Markdown 或代码块')
  return lines.join('\n')
}

function describeHint(hint: HealElementHint): string {
  const parts: string[] = []
  if (hint.text)
    parts.push(`text="${hint.text}"`)
  if (hint.contentDesc)
    parts.push(`contentDesc="${hint.contentDesc}"`)
  if (hint.resourceId)
    parts.push(`id="${hint.resourceId}"`)
  parts.push(`bounds=[${hint.bounds.join(', ')}]`)
  return parts.join(' ')
}

function describeAttempt(attempt: HealAttempt): string {
  if (!attempt.action)
    return `无效响应(${attempt.error ?? '被拒绝'})`
  const { action } = attempt
  const detail = [
    `tool=${action.tool}`,
    ...(action.target?.length ? [`target=${JSON.stringify(action.target)}`] : []),
    ...(action.with ? [`with=${JSON.stringify(action.with)}`] : []),
  ].join(' ')
  return `${detail}${attempt.reason ? `,原因: ${attempt.reason}` : ''}${attempt.error ? `(执行失败: ${attempt.error})` : ''}`
}

export class HealError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'HealError'
  }
}

export interface HealDecision {
  action: HealAction
  reason: string
}

/** Any model backend that turns a heal prompt into one decision. */
export interface HealLlmClient {
  complete: (prompt: string) => Promise<HealDecision>
}

export interface HealLlmEnv {
  FLOW_LLM_BASE_URL?: string
  FLOW_LLM_API_KEY?: string
  FLOW_LLM_MODEL?: string
  /** `messages` (Anthropic style, default) or `responses` (OpenAI Responses style). */
  FLOW_LLM_API_TYPE?: string
}

/** Reads the `FLOW_LLM_*` env vars; undefined means healing has no model configured. */
export function createEnvLlmClient(env: HealLlmEnv = process.env): HealLlmClient | undefined {
  const baseUrl = env.FLOW_LLM_BASE_URL?.trim().replace(/\/+$/, '')
  const apiKey = env.FLOW_LLM_API_KEY?.trim()
  const model = env.FLOW_LLM_MODEL?.trim()
  if (!baseUrl || !apiKey || !model)
    return undefined
  const apiType = env.FLOW_LLM_API_TYPE === 'responses' ? 'responses' : 'messages'
  return {
    async complete(prompt) {
      const request = apiType === 'responses'
        ? { url: `${baseUrl}/v1/responses`, body: JSON.stringify({ model, input: prompt }) }
        : { url: `${baseUrl}/v1/messages`, body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }) }
      let response: Response
      try {
        response = await fetch(request.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${apiKey}`,
            ...(apiType === 'messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {}),
          },
          body: request.body,
        })
      }
      catch (error) {
        throw new HealError(`LLM request failed: ${errorMessage(error)}`, { url: request.url })
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new HealError(`LLM request returned ${response.status}: ${detail.slice(0, 200)}`, { url: request.url, status: response.status })
      }
      const data: unknown = await response.json()
      const text = apiType === 'responses' ? responsesText(data) : messagesText(data)
      return parseHealDecision(text)
    },
  }
}

/** Parses `{action, reason}` from model output, tolerating code fences and stray prose around the JSON. */
export function parseHealDecision(text: string): HealDecision {
  const value = parseLooseJson(text) as { action?: unknown, reason?: unknown, target?: unknown, with?: unknown }
  let action = value.action
  if (typeof action === 'string')
    action = { tool: action, target: normalizeTarget(value.target), with: value.with }
  else if (action && typeof action === 'object')
    action = { ...(action as Record<string, unknown>), target: normalizeTarget((action as { target?: unknown }).target) }
  const checked = healActionSchema.safeParse(action)
  if (!checked.success) {
    const described = action && typeof action === 'object' && typeof (action as { tool?: unknown }).tool === 'string'
      ? (action as { tool: string }).tool
      : JSON.stringify(action)?.slice(0, 120)
    throw new HealError(`动作不在自愈白名单内或格式无效: ${described ?? '(缺少 action)'}`)
  }
  return { action: checked.data, reason: typeof value.reason === 'string' ? value.reason : '' }
}

/** Models often return a single target object instead of a one-element list. */
function normalizeTarget(target: unknown): unknown {
  return target && typeof target === 'object' && !Array.isArray(target) ? [target] : target
}

function parseLooseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const stripped = (fenced ? fenced[1] : text).trim()
  try {
    return JSON.parse(stripped)
  }
  catch {
    // Fall through and try the outermost JSON object in prose-wrapped output.
  }
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1))
    }
    catch {
      // Let the caller report the raw text.
    }
  }
  throw new HealError(`LLM response is not valid JSON: ${text.slice(0, 200)}`)
}

function messagesText(data: unknown): string {
  const content = (data as { content?: unknown }).content
  const block = Array.isArray(content) ? content.find(item => typeof (item as { text?: unknown })?.text === 'string') : undefined
  const text = (block as { text?: string } | undefined)?.text
  if (!text)
    throw new HealError('LLM messages response has no text content')
  return text
}

function responsesText(data: unknown): string {
  const value = data as { output_text?: unknown, output?: unknown }
  if (typeof value.output_text === 'string' && value.output_text)
    return value.output_text
  const output = Array.isArray(value.output) ? value.output : []
  const parts = output.flatMap(item => Array.isArray((item as { content?: unknown }).content) ? (item as { content: Array<{ text?: string }> }).content : [])
    .map(item => item?.text)
    .filter((text): text is string => typeof text === 'string')
  if (!parts.length)
    throw new HealError('LLM responses output has no text')
  return parts.join('')
}

export type HealLogger = (message: string) => void

export interface RunHealOptions {
  flow: FlowScript
  step: FlowStep
  serial: string
  device: ReplayDevice
  client: HealLlmClient
  /** Cap on heal actions per run. Default 8. */
  maxActions?: number
  /** How long one expect probe or target lookup waits. Default `HEAL_PROBE_MS`. */
  probeMs?: number
  logger?: HealLogger
  /** The replay error that triggered healing, shown to the model in the first prompt. */
  error?: string
}

export interface HealResult {
  healed: boolean
  actions: HealAttempt[]
  /** Executed (successful) heal actions as flow steps, ready for a patch. */
  steps: FlowStep[]
  /** Why healing gave up, when `healed` is false. */
  reason?: string
}

export const DEFAULT_MAX_HEAL_ACTIONS = 8

/**
 * How long one expect probe or target lookup waits before moving on.
 * Must outlast a single UI dump — uiautomator takes ~2.2s per snapshot —
 * or every probe times out before the first snapshot lands.
 */
const HEAL_PROBE_MS = 5000

export async function runHealAgent(options: RunHealOptions): Promise<HealResult> {
  const { flow, step, serial, device, client } = options
  const maxActions = options.maxActions ?? DEFAULT_MAX_HEAL_ACTIONS
  const probeMs = options.probeMs ?? HEAL_PROBE_MS
  const log = options.logger ?? (() => {})
  const attempts: HealAttempt[] = []
  const steps = () => attemptsToSteps(attempts)
  for (let index = 1; index <= maxActions; index++) {
    const visible = await captureHints(device, serial, log)
    let decision: HealDecision
    try {
      decision = await client.complete(buildHealPrompt({ flow, step, error: options.error, visible, attempted: attempts }))
    }
    catch (error) {
      attempts.push({ error: errorMessage(error) })
      log(`heal ${index}/${maxActions}: decision rejected — ${errorMessage(error)}`)
      continue
    }
    const checked = healActionSchema.safeParse(decision.action)
    if (!checked.success) {
      attempts.push({ reason: decision.reason, error: `动作不在自愈白名单内或格式无效: ${JSON.stringify(decision.action).slice(0, 120)}` })
      log(`heal ${index}/${maxActions}: action rejected — ${attempts.at(-1)!.error}`)
      continue
    }
    const action = checked.data
    try {
      await executeHealAction(action, flow, device, serial, probeMs)
    }
    catch (error) {
      attempts.push({ action, reason: decision.reason, error: errorMessage(error) })
      log(`heal ${index}/${maxActions}: ${action.tool} failed — ${errorMessage(error)}`)
      continue
    }
    attempts.push({ action, reason: decision.reason })
    log(`heal ${index}/${maxActions}: ${action.tool} executed${decision.reason ? ` — ${decision.reason}` : ''}`)
    if (await expectSatisfied(step.expect, device, serial, log, probeMs)) {
      log(`heal: expect of step ${step.id} is satisfied`)
      return { healed: true, actions: attempts, steps: steps() }
    }
  }
  return { healed: false, actions: attempts, steps: steps(), reason: `未能在 ${maxActions} 个动作内让步骤 ${step.id} 的期望成立` }
}

async function captureHints(device: ReplayDevice, serial: string, log: HealLogger): Promise<HealElementHint[] | undefined> {
  if (!device.snapshot)
    return undefined
  try {
    return healHints(await device.snapshot(serial))
  }
  catch (error) {
    log(`heal: snapshot failed — ${errorMessage(error)}`)
    return undefined
  }
}

/** Whether the step's expect holds right now; a step without expect counts as satisfied. */
async function expectSatisfied(expect: Expect | undefined, device: ReplayDevice, serial: string, log: HealLogger, probeMs: number = HEAL_PROBE_MS): Promise<boolean> {
  if (!expect)
    return true
  if (expect.visible && !(await visibleSatisfied(expect.visible, device, serial, probeMs)))
    return false
  if (expect.app) {
    if (!device.foregroundApp) {
      log('heal: expect.app needs the replay device foregroundApp capability')
      return false
    }
    try {
      const app = await device.foregroundApp(serial)
      return !!app && app.package === expect.app.package && (!expect.app.activity || app.activity === expect.app.activity)
    }
    catch (error) {
      log(`heal: foregroundApp failed — ${errorMessage(error)}`)
      return false
    }
  }
  return true
}

async function visibleSatisfied(visible: Exclude<Expect['visible'], undefined>, device: ReplayDevice, serial: string, probeMs: number = HEAL_PROBE_MS): Promise<boolean> {
  const targets = Array.isArray(visible) ? visible : [visible]
  for (const target of targets) {
    if (isPointTarget(target))
      return true
    if (isImageTarget(target))
      continue
    try {
      const result = await device.waitFor(serial, target, { timeoutMs: probeMs, intervalMs: 0 })
      if (result.found)
        return true
    }
    catch {
      // A failed dump means the target cannot be confirmed yet; try the next locator.
    }
  }
  return false
}

async function executeHealAction(action: HealAction, flow: FlowScript, device: ReplayDevice, serial: string, probeMs: number = HEAL_PROBE_MS): Promise<void> {
  const args = action.with ?? {}
  switch (action.tool) {
    case 'tap':
      await healTap(action.target, device, serial, probeMs)
      return
    case 'wait_for':
      await healWaitFor(action.target, device, serial, probeMs)
      return
    case 'input_text':
      await device.inputText(serial, String(args.text ?? ''))
      return
    case 'key':
      await device.key(serial, (args.key ?? args.keycode) as string | number)
      return
    case 'swipe':
      await device.swipe(serial, ratioPoint(args.from), ratioPoint(args.to), numberArg(args.duration_ms) ?? 300)
      return
    case 'app_start':
      await healAppStart(args, flow, device, serial)
  }
}

async function healTap(targets: Target[] | undefined, device: ReplayDevice, serial: string, probeMs: number = HEAL_PROBE_MS): Promise<void> {
  if (!targets?.length)
    throw new HealError('tap requires target')
  for (const target of targets) {
    if (isImageTarget(target))
      continue
    if (isPointTarget(target)) {
      await device.tap(serial, ratioToPoint(target.point))
      return
    }
    const result = await device.waitFor(serial, target, { timeoutMs: probeMs, intervalMs: 0 })
    if (result.found) {
      await device.tap(serial, target, { snapshot: result.snapshot.id })
      return
    }
  }
  throw new HealError('tap found no target on the current screen', { targets })
}

async function healWaitFor(targets: Target[] | undefined, device: ReplayDevice, serial: string, probeMs: number = HEAL_PROBE_MS): Promise<void> {
  if (!targets?.length)
    throw new HealError('wait_for requires target')
  for (const target of targets) {
    if (isPointTarget(target))
      return
    if (isImageTarget(target))
      continue
    const result = await device.waitFor(serial, target, { timeoutMs: probeMs, intervalMs: 0 })
    if (result.found)
      return
  }
  throw new HealError('wait_for found no target', { targets })
}

/** Runs app_start through the replayer so shell quoting, validation and timeouts stay in one place. */
async function healAppStart(args: Record<string, unknown>, flow: FlowScript, device: ReplayDevice, serial: string): Promise<void> {
  if (!args.package)
    throw new HealError('app_start requires with.package')
  const report = await replayFlow(
    { version: 1, name: flow.name, vars: {}, defaults: {}, interrupts: [], steps: [{ id: 'heal-app-start', do: 'app_start', with: args }] },
    { serial, device, settleMs: 0 },
  )
  if (report.status !== 'completed')
    throw new HealError(report.error ?? 'app_start failed')
}

function attemptsToSteps(attempts: HealAttempt[]): FlowStep[] {
  const executed = attempts.filter(attempt => attempt.action && !attempt.error)
  return executed.map((attempt, index) => healActionStep(attempt.action!, attempt.reason, `heal-${index + 1}`))
}

function healActionStep(action: HealAction, reason: string | undefined, id: string): FlowStep {
  return {
    id,
    ...(reason ? { intent: reason } : {}),
    do: action.tool,
    ...(action.target?.length ? { target: action.target } : {}),
    ...(action.with ? { with: action.with } : {}),
  }
}

function ratioPoint(value: unknown): RatioPoint {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number')
    throw new HealError('Expected a ratio point as [x, y]')
  return { x: value[0], y: value[1] }
}

function ratioToPoint(point: [number, number]): RatioPoint {
  return { x: point[0], y: point[1] }
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const healPatchSchema = z.object({
  /** The failed step this patch heals. */
  stepId: z.string().min(1),
  mode: z.enum(['insert-before', 'replace']),
  steps: z.array(stepSchema).min(1),
})

export type HealPatch = z.infer<typeof healPatchSchema>

/**
 * Compiles executed heal actions into a reviewable patch. When the last healed
 * action matches the failed step's own action, the patch replaces that step;
 * otherwise the actions only prepared the screen and are inserted before it.
 */
export function buildPatch(flow: FlowScript, stepId: string, actions: HealAttempt[]): HealPatch {
  const step = flow.steps.find(step => step.id === stepId)
  if (!step)
    throw new HealError(`Unknown step id: ${stepId}`)
  const steps = attemptsToSteps(actions)
  if (!steps.length)
    throw new HealError('No executed heal actions to patch')
  const lastTool = actions.filter(attempt => attempt.action && !attempt.error).at(-1)!.action!.tool
  return { stepId, mode: lastTool === step.do ? 'replace' : 'insert-before', steps }
}

/** Writes `<dir>/<name>.flow.yaml.patch-<n>.yaml`; `n` defaults to the existing patch count + 1. */
export async function writePatch(flowPath: string, patch: HealPatch, n?: number): Promise<string> {
  const dir = dirname(flowPath)
  const base = basename(flowPath)
  const index = n ?? (await countPatches(dir, base)) + 1
  const path = join(dir, `${base}.patch-${index}.yaml`)
  await writeFile(path, stringifyYaml(healPatchSchema.parse(patch), { indent: 2, lineWidth: 120 }), 'utf8')
  return path
}

async function countPatches(dir: string, base: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch {
    return 0
  }
  const pattern = new RegExp(`^${escapeRegExp(base)}\\.patch-\\d+\\.yaml$`)
  return entries.filter(name => pattern.test(name)).length
}

/** Reads the flow and the patch file, and returns the merged flow without writing it. */
export async function applyPatch(flowPath: string, patchPath: string): Promise<FlowScript> {
  const flow = await readFlow(flowPath)
  const patch = healPatchSchema.parse(parseYaml(await readFile(patchPath, 'utf8')))
  return mergePatch(flow, patch)
}

export function mergePatch(flow: FlowScript, patch: HealPatch): FlowScript {
  const index = flow.steps.findIndex(step => step.id === patch.stepId)
  if (index === -1)
    throw new HealError(`Patch targets unknown step id: ${patch.stepId}`)
  const steps = patch.mode === 'replace'
    ? [...flow.steps.slice(0, index), ...patch.steps, ...flow.steps.slice(index + 1)]
    : [...flow.steps.slice(0, index), ...patch.steps, ...flow.steps.slice(index)]
  return flowSchema.parse({ ...flow, steps })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
