import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { withTimeout } from '@escrcpy/flow-device'
import { shellEscape, validateShellCommand } from '@escrcpy/shared'
import type { FlowDevice, RatioPoint, Selector } from '@escrcpy/flow-device'
import { extractRows } from './extract.js'
import type { ExtractedRow, ExtractSpec } from './extract.js'
import { buildPatch, runHealAgent, writePatch } from './heal.js'
import type { HealLlmClient, HealLogger } from './heal.js'
import { isImageTarget, isPointTarget, isSelectorTarget } from './schema.js'
import { writeXlsx } from './xlsx.js'
import type { FlowInterrupt, FlowScript, FlowStep, Target } from './schema.js'

export interface ReplayDevice {
  waitFor: FlowDevice['waitFor']
  tap: FlowDevice['tap']
  longPress?: FlowDevice['longPress']
  inputText: FlowDevice['inputText']
  key: FlowDevice['key']
  swipe: FlowDevice['swipe']
  screenshot?: FlowDevice['screenshot']
  snapshot?: FlowDevice['snapshot']
  foregroundApp?: FlowDevice['foregroundApp']
  shell?: (serial: string, command: string) => Promise<string>
}

export interface ReplayOptions {
  serial: string
  vars?: Record<string, unknown>
  timeoutMs?: number
  settleMs?: number
  pollIntervalMs?: number
  shellTimeoutMs?: number
  reportDir?: string
  /** Where `extract` steps write their `output` files. Defaults to `reportDir`. */
  outputDir?: string
  now?: () => number
  device: ReplayDevice
  /** Path of the flow YAML being replayed; heal patches are written beside it. */
  flowPath?: string
  /** L2 self-heal hook for failed steps with an `expect`; disabled unless provided. */
  heal?: HealOptions
}

export interface HealOptions {
  client: HealLlmClient
  /** Cap on heal actions per failed step. Defaults to the heal agent's own limit. */
  maxActions?: number
  /** Compile healed actions into a patch file beside `flowPath`. */
  writePatch?: boolean
  /** Progress and patch-path log; healing stays silent without it. */
  logger?: HealLogger
}

export type RunStatus = 'completed' | 'failed'
export type StepStatus = 'passed' | 'failed' | 'skipped'

export interface StepReport {
  id: string
  status: StepStatus
  durationMs: number
  locatorIndex?: number
  drift: boolean
  interrupts: number
  /** Set when the L2 heal agent recovered this step after a failure. */
  healed?: boolean
  error?: string
  context?: { screenshot?: string, xml?: string }
}

export interface StepOutput {
  rows: ExtractedRow[]
  /** Path of the file written by the step's `output`, when one was requested. */
  file?: string
}

export interface RunReport {
  version: 1
  flow: string
  serial: string
  status: RunStatus
  startedAt: number
  endedAt: number
  durationMs: number
  steps: StepReport[]
  /** Data produced by `extract` steps, keyed by step id. */
  outputs?: Record<string, StepOutput>
  /** Path of the replayed flow YAML, when the caller provided one; lets `flow heal` find it. */
  flowPath?: string
  error?: string
}

export class ReplayError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'ReplayError'
  }
}

export async function replayFlow(flow: FlowScript, options: ReplayOptions): Promise<RunReport> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const runtimeOptions: ReplayOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? flow.defaults.timeout ?? 8_000,
    settleMs: options.settleMs ?? flow.defaults.settle ?? 300,
    pollIntervalMs: options.pollIntervalMs ?? flow.defaults.pollInterval ?? 500,
  }
  const report: RunReport = {
    version: 1,
    flow: flow.name,
    serial: options.serial,
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    steps: [],
    ...(options.flowPath ? { flowPath: options.flowPath } : {}),
  }
  try {
    const values = resolveVars(flow, options.vars ?? {})
    for (const step of flow.steps) {
      const started = now()
      const stepReport: StepReport = { id: step.id, status: 'passed', durationMs: 0, drift: false, interrupts: 0 }
      try {
        const result = await executeStep(flow, step, runtimeOptions.device, runtimeOptions.serial, values, runtimeOptions, now)
        if (result.locatorIndex !== undefined) {
          stepReport.locatorIndex = result.locatorIndex
          stepReport.drift = result.locatorIndex > 1
        }
        stepReport.interrupts = result.interrupts
        if (result.output)
          (report.outputs ??= {})[step.id] = result.output
        await settle(step.settle ?? runtimeOptions.settleMs!)
        if (step.expect) {
          try {
            await assertExpect(step.expect, runtimeOptions.device, runtimeOptions.serial, values, runtimeOptions, now)
          }
          catch (error) {
            const handled = await handleInterrupts(flow.interrupts, runtimeOptions.device, runtimeOptions.serial, values, runtimeOptions, now)
            stepReport.interrupts += handled
            if (!handled)
              throw error
            await assertExpect(step.expect, runtimeOptions.device, runtimeOptions.serial, values, runtimeOptions, now)
          }
        }
      }
      catch (error) {
        stepReport.status = step.optional ? 'skipped' : 'failed'
        stepReport.error = error instanceof Error ? error.message : String(error)
        stepReport.context = await saveContext(runtimeOptions, step.id, report.steps.length + 1)
        if (!step.optional && runtimeOptions.heal && step.expect && await healStep(flow, step, stepReport, runtimeOptions)) {
          stepReport.status = 'passed'
          stepReport.healed = true
          stepReport.error = undefined
        }
        else {
          report.steps.push({ ...stepReport, durationMs: now() - started })
          if (!step.optional)
            throw error
        }
      }
      if (stepReport.status === 'passed')
        report.steps.push({ ...stepReport, durationMs: now() - started })
    }
  }
  catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
  }
  report.endedAt = now()
  report.durationMs = report.endedAt - report.startedAt
  if (options.reportDir) {
    await mkdir(options.reportDir, { recursive: true })
    await writeFile(join(options.reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  }
  return report
}

export const runFlow = replayFlow

interface ExecutionResult {
  locatorIndex?: number
  interrupts: number
  output?: StepOutput
}

async function executeStep(flow: FlowScript, step: FlowStep, device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions, now: () => number): Promise<ExecutionResult> {
  let interrupts = 0
  let resolved: ResolvedTarget | undefined
  if (step.target?.length) {
    try {
      resolved = await resolveTarget(step.target, device, serial, values, options, now)
    }
    catch (error) {
      const handled = await handleInterrupts(flow.interrupts, device, serial, values, options, now)
      interrupts = handled
      if (!handled)
        throw error
      resolved = await resolveTarget(step.target, device, serial, values, options, now)
    }
  }
  const output = await perform(step, resolved, device, serial, values, options)
  return { locatorIndex: resolved?.index, interrupts, ...(output ? { output } : {}) }
}

interface ResolvedTarget {
  target: Target
  index: number
  result?: Awaited<ReturnType<FlowDevice['waitFor']>>
}

async function resolveTarget(targets: Target[], device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions, now: () => number): Promise<ResolvedTarget> {
  const started = now()
  const timeoutMs = options.timeoutMs ?? 8_000
  let lastError = 'No target matched'
  while (true) {
    for (const [index, raw] of targets.entries()) {
      const target = renderTarget(raw, values)
      if (isImageTarget(target))
        throw new ReplayError('Image targets are not implemented in M2', { target })
      if (isPointTarget(target))
        return { target, index: index + 1 }
      let result: Awaited<ReturnType<FlowDevice['waitFor']>>
      try {
        // One attempt per target per pass: a waitFor holding the whole remaining
        // timeout would starve every backup locator of its turn.
        result = await device.waitFor(serial, target, { timeoutMs: 0, intervalMs: 0 })
      }
      catch (error) {
        // A failing dump (animated screen) must not abort the whole wait while
        // backup locators still have time left; keep them in the race.
        lastError = error instanceof Error ? error.message : String(error)
        continue
      }
      if (result.found)
        return { target, index: index + 1, result }
      lastError = `Target ${index + 1} did not match`
    }
    const elapsedMs = now() - started
    if (elapsedMs >= timeoutMs)
      throw new ReplayError(`${lastError} within ${timeoutMs}ms`, { targets })
    await settle(Math.min(options.pollIntervalMs ?? 500, timeoutMs - elapsedMs))
  }
}

async function perform(step: FlowStep, resolved: ResolvedTarget | undefined, device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions): Promise<StepOutput | void> {
  const args = renderValue(step.with ?? {}, values) as Record<string, unknown>
  switch (step.do) {
    case 'extract':
      return performExtract(args, device, serial, options)
    case 'tap':
      if (!resolved)
        throw new ReplayError('tap requires target')
      if (isPointTarget(resolved.target))
        await device.tap(serial, toPoint(resolved.target.point))
      else if (!isSelectorTarget(resolved.target))
        throw new ReplayError('Image targets are not implemented in M2', { target: resolved.target })
      else if (resolved.result)
        await device.tap(serial, resolved.target, { snapshot: resolved.result.snapshot.id })
      else
        await device.tap(serial, resolved.target)
      return
    case 'long_press':
      if (!resolved || !device.longPress)
        throw new ReplayError('long_press requires target and a longPress device capability')
      if (isImageTarget(resolved.target))
        throw new ReplayError('Image targets are not implemented in M2', { target: resolved.target })
      await device.longPress(serial, isPointTarget(resolved.target) ? toPoint(resolved.target.point) : resolved.target, { durationMs: numberArg(args.duration_ms) })
      return
    case 'input_text':
      await device.inputText(serial, String(args.text ?? ''))
      return
    case 'key':
      await device.key(serial, (args.key ?? args.keycode) as string | number)
      return
    case 'swipe': {
      const from = asPoint(args.from)
      const to = asPoint(args.to)
      await device.swipe(serial, from, to, numberArg(args.duration_ms) ?? 300)
      return
    }
    case 'wait_for':
      if (!resolved)
        throw new ReplayError('wait_for requires a target')
      return
    case 'sleep':
      await settle(numberArg(args.duration_ms) ?? numberArg(args.ms) ?? 0)
      return
    case 'app_start':
      if (args.restart)
        await shellCommand(device, serial, `am force-stop ${quote(String(args.package ?? ''))}`, options.shellTimeoutMs)
      if (args.activity)
        await shellCommand(device, serial, `am start -n ${quote(`${args.package}/${args.activity}`)}`, options.shellTimeoutMs)
      else
        await shellCommand(device, serial, `monkey -p ${quote(String(args.package ?? ''))} -c android.intent.category.LAUNCHER 1`, options.shellTimeoutMs)
      return
    case 'app_stop':
      await shellCommand(device, serial, `am force-stop ${quote(String(args.package ?? ''))}`, options.shellTimeoutMs)
      return
    case 'open_url':
      await shellCommand(device, serial, `am start -a android.intent.action.VIEW -d ${quote(String(args.url ?? ''))}`, options.shellTimeoutMs)
      return
    case 'shell':
      await shellCommand(device, serial, String(args.command ?? ''), options.shellTimeoutMs)
      return
    case 'scroll_until':
    case 'scroll':
      throw new ReplayError(`${step.do} is not implemented in M2`)
    case 'assert':
      if (!step.target && !step.expect)
        throw new ReplayError('assert requires a target or expect')
      return
    default:
      throw new ReplayError(`Unsupported flow action: ${step.do}`)
  }
}

async function performExtract(args: Record<string, unknown>, device: ReplayDevice, serial: string, options: ReplayOptions): Promise<StepOutput> {
  if (!device.snapshot)
    throw new ReplayError('extract requires the replay device snapshot capability')
  if (!args.columns || typeof args.columns !== 'object')
    throw new ReplayError('extract requires with.columns')
  const snapshot = await device.snapshot(serial)
  let rows: ExtractedRow[]
  try {
    rows = extractRows(snapshot.tree, args as unknown as ExtractSpec)
  }
  catch (error) {
    throw new ReplayError(error instanceof Error ? error.message : String(error))
  }
  const output: StepOutput = { rows }
  if (typeof args.output === 'string' && args.output) {
    const baseDir = resolve(options.outputDir ?? options.reportDir ?? '.')
    const file = resolve(baseDir, args.output)
    const rel = relative(baseDir, file)
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new ReplayError(`extract output must stay inside ${baseDir}`, { output: args.output })
    const columns = Object.keys(args.columns as object).map(key => ({ key }))
    if (file.toLowerCase().endsWith('.xlsx')) {
      await writeXlsx(file, columns, rows, typeof args.sheet === 'string' ? args.sheet : undefined)
    }
    else {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
    }
    output.file = file
  }
  return output
}

async function assertExpect(expect: NonNullable<FlowStep['expect']>, device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions, now: () => number): Promise<void> {
  if (expect.visible) {
    const targets = Array.isArray(expect.visible) ? expect.visible : [expect.visible]
    await resolveTarget(targets, device, serial, values, options, now)
  }
  if (expect.app) {
    if (!device.foregroundApp)
      throw new ReplayError('Expected app assertion requires foregroundApp capability')
    const app = await device.foregroundApp(serial)
    if (!app || app.package !== expect.app.package || (expect.app.activity && app.activity !== expect.app.activity))
      throw new ReplayError(`Expected app ${expect.app.package}, got ${app?.package ?? 'none'}`)
  }
}

async function handleInterrupts(interrupts: FlowInterrupt[], device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions, now: () => number): Promise<number> {
  let handled = 0
  for (const interrupt of interrupts) {
    const targets = Array.isArray(interrupt.when) ? interrupt.when : [interrupt.when]
    try {
      const found = await probeTarget(targets, device, serial, values, options)
      if (!found)
        continue
      const step: FlowStep = { id: 'interrupt', do: interrupt.do, target: interrupt.target ?? targets, with: interrupt.with }
      const resolved = await resolveTarget(step.target!, device, serial, values, { ...options, timeoutMs: 0 }, now)
      await perform(step, resolved, device, serial, values, options)
      handled++
    }
    catch {
      // An interrupt is best effort; the original step remains authoritative.
    }
  }
  return handled
}

/**
 * L2 hook for a failed non-optional step with an `expect`: let the heal agent drive the
 * device until the expect holds again, then optionally emit a reviewable patch beside the
 * flow file. Returns false (keeping the original failure) whenever healing gives up.
 */
async function healStep(flow: FlowScript, step: FlowStep, stepReport: StepReport, options: ReplayOptions): Promise<boolean> {
  const heal = options.heal!
  const log = heal.logger ?? (() => {})
  log(`heal: step ${step.id} failed — ${stepReport.error}`)
  const result = await runHealAgent({
    flow,
    step,
    serial: options.serial,
    device: options.device,
    client: heal.client,
    ...(heal.maxActions !== undefined ? { maxActions: heal.maxActions } : {}),
    logger: log,
    error: stepReport.error,
  })
  if (!result.healed) {
    log(`heal: gave up on step ${step.id} — ${result.reason ?? 'expect never held'}`)
    return false
  }
  if (heal.writePatch) {
    try {
      if (!options.flowPath) {
        log('heal: writePatch needs ReplayOptions.flowPath; skipping the patch file')
      }
      else {
        const path = await writePatch(options.flowPath, buildPatch(flow, step.id, result.actions))
        log(`heal: patch written to ${path}`)
      }
    }
    catch (error) {
      // The step recovered; a patch failure must not turn the run back into a failure.
      log(`heal: patch write failed — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return true
}

async function probeTarget(targets: Target[], device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions): Promise<boolean> {
  // A 0ms probe samples a single frame and misses popups that are still rendering;
  // borrow the poll cadence, bounded to a short window, so `when` gets a fair check.
  const intervalMs = options.pollIntervalMs ?? 500
  const probeMs = Math.min(Math.max(intervalMs, 300), 1_000)
  for (const raw of targets) {
    const target = renderTarget(raw, values)
    if (isPointTarget(target))
      return true
    if (isImageTarget(target))
      continue
    const result = await device.waitFor(serial, target, { timeoutMs: probeMs, intervalMs })
    if (result.found)
      return true
  }
  return false
}

async function shellCommand(device: ReplayDevice, serial: string, command: string, timeoutMs = 15_000): Promise<void> {
  if (!device.shell)
    throw new ReplayError('This flow action requires the replay device shell capability')
  try {
    validateShellCommand(command)
    await withTimeout(device.shell(serial, command), timeoutMs, 'shell command')
  }
  catch (error) {
    if (error instanceof ReplayError)
      throw error
    throw new ReplayError(error instanceof Error ? error.message : String(error), { command })
  }
}

function resolveVars(flow: FlowScript, supplied: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = { ...supplied }
  for (const [name, definition] of Object.entries(flow.vars)) {
    if (values[name] === undefined && definition.default !== undefined)
      values[name] = definition.default
    if (definition.required && values[name] === undefined)
      throw new ReplayError(`Missing required flow variable: ${name}`)
  }
  return values
}

function renderTarget(target: Target, values: Record<string, unknown>): Target {
  if (isPointTarget(target) || isImageTarget(target))
    return target
  return renderValue(target, values) as Selector
}

function renderValue(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([\w.-]+)\}\}/g, (_, name: string) => values[name] === undefined ? `{{${name}}}` : String(values[name]))
  }
  if (Array.isArray(value))
    return value.map(item => renderValue(item, values))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, values)]))
  return value
}

function toPoint(value: [number, number]): RatioPoint {
  return { x: value[0], y: value[1] }
}

function asPoint(value: unknown): RatioPoint {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number')
    throw new ReplayError('Expected a ratio point as [x, y]')
  return { x: value[0], y: value[1] }
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function quote(value: string): string {
  return `'${shellEscape(value)}'`
}

async function saveContext(options: ReplayOptions, id: string, index: number): Promise<StepReport['context']> {
  if (!options.reportDir)
    return undefined
  const context: StepReport['context'] = {}
  await mkdir(options.reportDir, { recursive: true })
  const prefix = `step-${String(index).padStart(2, '0')}`
  if (options.device.screenshot) {
    try {
      const screenshot = await options.device.screenshot(options.serial)
      const path = join(options.reportDir, `${prefix}.jpg`)
      await writeFile(path, screenshot.data)
      context.screenshot = path
    }
    catch {
      // Keep the report useful when the device cannot capture a screenshot.
    }
  }
  if (options.device.snapshot) {
    try {
      const snapshot = await options.device.snapshot(options.serial)
      const path = join(options.reportDir, `${prefix}.xml`)
      await writeFile(path, snapshot.xml, 'utf8')
      context.xml = path
    }
    catch {
      // Snapshot capture is diagnostic and must not hide the original failure.
    }
  }
  void id
  return Object.keys(context).length ? context : undefined
}

async function settle(ms: number): Promise<void> {
  if (ms > 0)
    await new Promise(resolve => setTimeout(resolve, ms))
}
