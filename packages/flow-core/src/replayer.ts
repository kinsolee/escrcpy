import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FlowDevice, RatioPoint, Selector } from '@escrcpy/flow-device'
import { isImageTarget, isPointTarget, isSelectorTarget } from './schema.js'
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
  reportDir?: string
  now?: () => number
  device: ReplayDevice
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
  error?: string
  context?: { screenshot?: string, xml?: string }
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
  const values = resolveVars(flow, options.vars ?? {})
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
  }
  try {
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
        await settle(runtimeOptions.settleMs!)
        if (step.expect)
          await assertExpect(step.expect, runtimeOptions.device, runtimeOptions.serial, values, runtimeOptions, now)
      }
      catch (error) {
        stepReport.status = step.optional ? 'skipped' : 'failed'
        stepReport.error = error instanceof Error ? error.message : String(error)
        stepReport.context = await saveContext(runtimeOptions, step.id, report.steps.length + 1)
        report.steps.push({ ...stepReport, durationMs: now() - started })
        if (!step.optional)
          throw error
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
  await perform(step, resolved, device, serial, values, options)
  return { locatorIndex: resolved?.index, interrupts }
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
      const elapsedMs = now() - started
      const remaining = Math.max(0, timeoutMs - elapsedMs)
      const result = await device.waitFor(serial, target, { timeoutMs: Math.min(remaining, options.pollIntervalMs ?? 500), intervalMs: 0 })
      if (result.found)
        return { target, index: index + 1, result }
      lastError = `Target ${index + 1} did not match within ${timeoutMs}ms`
    }
    const elapsedMs = now() - started
    if (elapsedMs >= timeoutMs)
      throw new ReplayError(lastError, { targets })
    await settle(Math.min(options.pollIntervalMs ?? 500, timeoutMs - elapsedMs))
  }
}

async function perform(step: FlowStep, resolved: ResolvedTarget | undefined, device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions): Promise<void> {
  const args = renderValue(step.with ?? {}, values) as Record<string, unknown>
  switch (step.do) {
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
      return
    case 'sleep':
      await settle(numberArg(args.duration_ms) ?? numberArg(args.ms) ?? 0)
      return
    case 'app_start':
      if (args.restart)
        await shellCommand(device, serial, `am force-stop ${quote(String(args.package ?? ''))}`)
      if (args.activity)
        await shellCommand(device, serial, `am start -n ${quote(`${args.package}/${args.activity}`)}`)
      else
        await shellCommand(device, serial, `monkey -p ${quote(String(args.package ?? ''))} -c android.intent.category.LAUNCHER 1`)
      return
    case 'app_stop':
      await shellCommand(device, serial, `am force-stop ${quote(String(args.package ?? ''))}`)
      return
    case 'open_url':
      await shellCommand(device, serial, `am start -a android.intent.action.VIEW -d ${quote(String(args.url ?? ''))}`)
      return
    case 'shell':
      await shellCommand(device, serial, String(args.command ?? ''))
      return
    case 'scroll_until':
    case 'scroll':
      if (resolved)
        return
      throw new ReplayError(`${step.do} requires a target in M2`)
    case 'assert':
      return
    default:
      throw new ReplayError(`Unsupported flow action: ${step.do}`)
  }
}

async function assertExpect(expect: NonNullable<FlowStep['expect']>, device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions, now: () => number): Promise<void> {
  if (expect.visible) {
    const targets = Array.isArray(expect.visible) ? expect.visible : [expect.visible]
    await resolveTarget(targets, device, serial, values, options, now)
  }
  if (expect.app && device.foregroundApp) {
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

async function probeTarget(targets: Target[], device: ReplayDevice, serial: string, values: Record<string, unknown>, options: ReplayOptions): Promise<boolean> {
  for (const raw of targets) {
    const target = renderTarget(raw, values)
    if (isPointTarget(target))
      return true
    if (isImageTarget(target))
      continue
    const result = await device.waitFor(serial, target, { timeoutMs: 0, intervalMs: 0 })
    if (result.found)
      return true
  }
  return false
}

async function shellCommand(device: ReplayDevice, serial: string, command: string): Promise<void> {
  if (!device.shell)
    throw new ReplayError('This flow action requires the replay device shell capability')
  await device.shell(serial, command)
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
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('\'', '\'\\\'\'')
  return `'${escaped}'`
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
