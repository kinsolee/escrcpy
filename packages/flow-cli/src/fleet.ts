import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import adbkit from '@devicefarmer/adbkit'
// 'yaml' is the parser @escrcpy/flow-core already ships inside this workspace; fleet adds no new dependency.
import { parse as parseYaml } from 'yaml'
import type { FlowScript, ReplayOptions, RunReport } from '@escrcpy/flow-core'
import { readFlow, replayFlow } from '@escrcpy/flow-core'
import type { DeviceLease, DeviceLeaseOptions } from '@escrcpy/flow-device'
import { createDeviceLease, LeaseBusyError } from '@escrcpy/flow-device'

export const FLEET_MANIFEST_VERSION = 1
/** Holder recorded in device leases while a fleet task owns the device. */
export const FLEET_HOLDER = 'flow-fleet'

const DEFAULT_REPORT_ROOT = 'reports'
const DEFAULT_BUSY_POLL_MS = 1_000

export interface FleetManifestFlow {
  /** Flow YAML path, relative to the manifest unless absolute. */
  flow: string
  /** One entry per run; the flow runs once per entry. Missing or empty means a single empty group. */
  vars?: Array<Record<string, unknown>>
}

export interface FleetManifest {
  version: number
  flows: FleetManifestFlow[]
  /** Explicit serials, or `auto` to take every online device at dispatch time. */
  devices: string[] | 'auto'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDevices(value: unknown): string[] | 'auto' {
  if (value === 'auto')
    return 'auto'
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Fleet manifest needs devices: auto or a non-empty serial list')
  const serials = value.map((serial, index) => {
    if (typeof serial !== 'string' || !serial.trim())
      throw new Error(`devices[${index}] must be a non-empty serial string`)
    return serial
  })
  // A repeated serial would start two workers competing for the same lease.
  return [...new Set(serials)]
}

export function parseFleetManifest(source: string): FleetManifest {
  let value: unknown
  try {
    value = parseYaml(source)
  }
  catch (error) {
    throw new Error(`Invalid fleet manifest YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(value))
    throw new Error('Fleet manifest must be a YAML mapping')
  if (value.version !== FLEET_MANIFEST_VERSION)
    throw new Error(`Unsupported fleet manifest version: ${String(value.version)}; expected ${FLEET_MANIFEST_VERSION}`)
  if (!Array.isArray(value.flows) || value.flows.length === 0)
    throw new Error('Fleet manifest needs a non-empty flows list')
  const flows: FleetManifestFlow[] = value.flows.map((entry: unknown, index: number) => {
    if (!isPlainObject(entry) || typeof entry.flow !== 'string' || !entry.flow.trim())
      throw new Error(`flows[${index}] needs a flow YAML path string`)
    if (entry.vars !== undefined) {
      if (!Array.isArray(entry.vars))
        throw new Error(`flows[${index}].vars must be a list of variable groups`)
      entry.vars.forEach((group: unknown, groupIndex: number) => {
        if (!isPlainObject(group))
          throw new Error(`flows[${index}].vars[${groupIndex}] must be a mapping of variable names to values`)
      })
    }
    return { flow: entry.flow, ...(entry.vars !== undefined ? { vars: entry.vars as Array<Record<string, unknown>> } : {}) }
  })
  return { version: FLEET_MANIFEST_VERSION, flows, devices: parseDevices(value.devices) }
}

/** One expanded run unit: a flow file paired with one variable group. */
export interface PlannedUnit {
  flowPath: string
  vars: Record<string, unknown>
  /** 1-based index of the variable group inside its flow entry. */
  varsIndex: number
}

/** Expand the flows × vars matrix in declaration order; missing or empty vars means one empty group. */
export function expandFleetManifest(manifest: FleetManifest): PlannedUnit[] {
  const units: PlannedUnit[] = []
  for (const entry of manifest.flows) {
    const groups = entry.vars && entry.vars.length ? entry.vars : [{}]
    groups.forEach((vars, index) => units.push({ flowPath: entry.flow, vars, varsIndex: index + 1 }))
  }
  return units
}

export interface FleetTask extends PlannedUnit {
  script: FlowScript
  varsTotal: number
}

/** Load and validate every flow file referenced by the manifest, keeping matrix order. */
export async function loadFleetTasks(manifest: FleetManifest, manifestPath: string, readFlowImpl: typeof readFlow = readFlow): Promise<FleetTask[]> {
  const base = dirname(resolve(manifestPath))
  const tasks: FleetTask[] = []
  for (const entry of manifest.flows) {
    const groups = entry.vars && entry.vars.length ? entry.vars : [{}]
    const flowPath = isAbsolute(entry.flow) ? entry.flow : resolve(base, entry.flow)
    const script = await readFlowImpl(flowPath)
    groups.forEach((vars, index) => tasks.push({ flowPath: entry.flow, script, vars, varsIndex: index + 1, varsTotal: groups.length }))
  }
  return tasks
}

export interface DevicePlan {
  serial: string
  /** Tasks this device runs, in order; round-robin over the expanded matrix. */
  tasks: FleetTask[]
}

/** Deal tasks to devices round-robin: device i runs tasks i, i+N, i+2N… serially while devices run in parallel. */
export function assignDevices(tasks: FleetTask[], serials: string[]): DevicePlan[] {
  const plans: DevicePlan[] = serials.map(serial => ({ serial, tasks: [] }))
  if (!plans.length)
    return plans
  tasks.forEach((task, index) => plans[index % plans.length]!.tasks.push(task))
  return plans
}

/** Replay entry point injected per run; the CLI wraps replayFlow with a real device, tests use fakes. */
export type FleetReplay = (flow: FlowScript, options: Omit<ReplayOptions, 'device'>) => Promise<RunReport>

export interface FleetDeps {
  replay?: FleetReplay
  createLease?: (options?: DeviceLeaseOptions) => DeviceLease
  /** Online serials for `devices: auto`. Defaults to the adb device list. */
  listOnlineSerials?: () => Promise<string[]>
  /** Screen size for recordedOn warnings; returning undefined skips the check. */
  screenSize?: (serial: string) => Promise<{ width: number, height: number } | undefined>
  readFlow?: typeof readFlow
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export interface FleetOptions {
  dryRun?: boolean
  /** Root for `<flow>/<serial>/<timestamp>/report.json` reports. Default: reports. */
  reportRoot?: string
  /** What to do when another holder owns a device lease. Default: skip. */
  onBusy?: 'wait' | 'skip'
  busyPollMs?: number
}

export type FleetTaskStatus = 'completed' | 'failed' | 'skipped'

export interface FleetTaskResult {
  serial: string
  flow: string
  flowPath: string
  varsIndex: number
  varsTotal: number
  vars: Record<string, unknown>
  status: FleetTaskStatus
  durationMs: number
  /** Total rows produced by extract steps. */
  rows: number
  warnings: string[]
  /** Why the task was skipped, e.g. the device was leased elsewhere. */
  reason?: string
  error?: string
  reportDir?: string
  reportPath?: string
}

export interface FleetRunSummary {
  manifestPath: string
  dryRun: boolean
  startedAt: number
  endedAt: number
  results: FleetTaskResult[]
  completed: number
  failed: number
  skipped: number
}

async function defaultListOnlineSerials(): Promise<string[]> {
  const adb = adbkit.Adb.createClient({ bin: process.env.ADB_PATH })
  const devices = await adb.listDevices() as Array<{ id: string, type: string }>
  return devices.filter(device => device.type === 'device').map(device => device.id)
}

function sanitizeSegment(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '-')
  return !safe || safe === '.' || safe === '..' ? 'flow' : safe
}

export function formatRunStamp(date: Date): string {
  // Colons and the millisecond dot are unwieldy on Windows paths; keep the rest of the ISO shape.
  return date.toISOString().replace(/[.:]/g, '-')
}

/** The dry-run execution plan: each device with its ordered task queue. */
export function formatFleetPlan(plans: DevicePlan[], meta: { manifestPath: string, reportRoot: string, onBusy: 'wait' | 'skip' }): string {
  const total = plans.reduce((count, plan) => count + plan.tasks.length, 0)
  const lines = [
    `fleet dry-run plan: ${meta.manifestPath} — ${total} task(s) across ${plans.length} device(s)`,
    `report root: ${meta.reportRoot}  on-busy: ${meta.onBusy}`,
  ]
  for (const plan of plans) {
    lines.push(`${plan.serial}:`)
    plan.tasks.forEach((task, index) => {
      lines.push(`  ${index + 1}. ${task.script.name} (vars ${task.varsIndex}/${task.varsTotal}) ${JSON.stringify(task.vars)}`)
    })
  }
  return lines.join('\n')
}

export function formatFleetSummary(summary: FleetRunSummary): string {
  const header = ['serial', 'flow', 'vars', 'status', 'ms', 'rows', 'note']
  const rows = summary.results.map(result => [
    result.serial,
    result.flow,
    `${result.varsIndex}/${result.varsTotal}`,
    result.status,
    String(result.durationMs),
    result.status === 'skipped' ? '-' : String(result.rows),
    result.status === 'skipped' ? (result.reason ?? '') : result.status === 'failed' ? (result.error ?? '') : (result.reportPath ?? ''),
  ])
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => row[index]!.length)))
  const format = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd()
  return [
    `fleet summary: ${summary.results.length} task(s) — ${summary.completed} completed, ${summary.failed} failed, ${summary.skipped} skipped in ${summary.endedAt - summary.startedAt} ms`,
    format(header),
    ...rows.map(format),
  ].join('\n')
}

/**
 * Run a fleet manifest: expand the flows × vars matrix, deal tasks to devices
 * round-robin (one task at a time per device, devices in parallel), lease each
 * device while its task replays, and write per-run reports under reportRoot.
 */
export async function runFleet(manifestPath: string, options: FleetOptions = {}, deps: FleetDeps = {}): Promise<FleetRunSummary> {
  const dryRun = options.dryRun ?? false
  const onBusy = options.onBusy ?? 'skip'
  const reportRoot = options.reportRoot ?? DEFAULT_REPORT_ROOT
  const busyPollMs = options.busyPollMs ?? DEFAULT_BUSY_POLL_MS
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const replay = deps.replay ?? ((flow: FlowScript, replayOptions: Omit<ReplayOptions, 'device'>) => replayFlow(flow, replayOptions as ReplayOptions))
  const lease = (deps.createLease ?? createDeviceLease)()
  const startedAt = now().getTime()

  const manifest = parseFleetManifest(await readFile(manifestPath, 'utf8'))
  const tasks = await loadFleetTasks(manifest, manifestPath, deps.readFlow)
  const serials = manifest.devices === 'auto' ? await (deps.listOnlineSerials ?? defaultListOnlineSerials)() : manifest.devices
  if (!serials.length)
    throw new Error('No devices available for the fleet run')
  const plans = assignDevices(tasks, serials)

  if (dryRun) {
    console.log(formatFleetPlan(plans, { manifestPath, reportRoot, onBusy }))
    return { manifestPath, dryRun: true, startedAt, endedAt: now().getTime(), results: [], completed: 0, failed: 0, skipped: 0 }
  }

  const usedStamps = new Set<string>()

  function nextStamp(flowName: string, serial: string): string {
    const base = formatRunStamp(now())
    let stamp = base
    let suffix = 2
    while (usedStamps.has(`${flowName}/${serial}/${stamp}`))
      stamp = `${base}_${suffix++}`
    usedStamps.add(`${flowName}/${serial}/${stamp}`)
    return stamp
  }

  /** recordedOn.size vs the live screen: a warning only, never a failure (design doc 10.3). */
  async function resolutionWarnings(task: FleetTask, serial: string): Promise<string[]> {
    const recorded = task.script.recordedOn?.size
    if (!recorded || !deps.screenSize)
      return []
    let size: { width: number, height: number } | undefined
    try {
      size = await deps.screenSize(serial)
    }
    catch {
      return []
    }
    if (size && (size.width !== recorded[0] || size.height !== recorded[1]))
      return [`flow ${task.script.name} was recorded on ${recorded[0]}x${recorded[1]} but ${serial} reports ${size.width}x${size.height}; point/image targets may drift`]
    return []
  }

  async function runTask(serial: string, task: FleetTask): Promise<FleetTaskResult> {
    const base = { serial, flow: task.script.name, flowPath: task.flowPath, varsIndex: task.varsIndex, varsTotal: task.varsTotal, vars: task.vars }
    // Occupancy check before dispatch: skip marks the task, wait polls until the holder is gone.
    for (;;) {
      const holder = await lease.info(serial)
      if (!holder)
        break
      if (onBusy === 'skip') {
        const reason = `busy: leased by ${holder.holder} (pid ${holder.pid})`
        console.log(`fleet: [${serial}] ${task.script.name} (vars ${task.varsIndex}/${task.varsTotal}) skipped — ${reason}`)
        return { ...base, status: 'skipped', durationMs: 0, rows: 0, warnings: [], reason }
      }
      await sleep(busyPollMs)
    }
    let acquired = false
    try {
      for (;;) {
        try {
          await lease.acquire(serial, { holder: FLEET_HOLDER })
          acquired = true
          break
        }
        catch (error) {
          if (!(error instanceof LeaseBusyError))
            throw error
          if (onBusy === 'skip') {
            const reason = `busy: leased by ${error.lease.holder} (pid ${error.lease.pid})`
            console.log(`fleet: [${serial}] ${task.script.name} (vars ${task.varsIndex}/${task.varsTotal}) skipped — ${reason}`)
            return { ...base, status: 'skipped', durationMs: 0, rows: 0, warnings: [], reason }
          }
          await sleep(busyPollMs)
        }
      }
      const warnings = await resolutionWarnings(task, serial)
      for (const warning of warnings)
        console.error(`warning: ${warning}`)
      const reportDir = join(reportRoot, sanitizeSegment(task.script.name), serial, nextStamp(task.script.name, serial))
      const report = await replay(task.script, { serial, vars: task.vars, reportDir })
      const rows = Object.values(report.outputs ?? {}).reduce((total, output) => total + output.rows.length, 0)
      console.log(`fleet: [${serial}] ${task.script.name} (vars ${task.varsIndex}/${task.varsTotal}) ${report.status} in ${report.durationMs} ms`)
      return {
        ...base,
        status: report.status === 'completed' ? 'completed' : 'failed',
        durationMs: report.durationMs,
        rows,
        warnings,
        ...(report.error ? { error: report.error } : {}),
        reportDir,
        reportPath: join(reportDir, 'report.json'),
      }
    }
    catch (error) {
      return { ...base, status: 'failed', durationMs: 0, rows: 0, warnings: [], error: error instanceof Error ? error.message : String(error) }
    }
    finally {
      if (acquired)
        await lease.release(serial)
    }
  }

  async function runDeviceQueue(plan: DevicePlan): Promise<FleetTaskResult[]> {
    const results: FleetTaskResult[] = []
    for (const task of plan.tasks)
      results.push(await runTask(plan.serial, task))
    return results
  }

  const results = (await Promise.all(plans.map(plan => runDeviceQueue(plan)))).flat()
  const summary: FleetRunSummary = {
    manifestPath,
    dryRun: false,
    startedAt,
    endedAt: now().getTime(),
    results,
    completed: results.filter(result => result.status === 'completed').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
  }
  console.log(formatFleetSummary(summary))
  return summary
}
