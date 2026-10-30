#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import type { FlowScript, FlowStep, HealLlmClient, RunReport, Target } from '@escrcpy/flow-core'
import { applyPatch, compileTraceFile, createEnvLlmClient, loadLlmConfig, readFlow, readTrace, replayFlow, resolveLlm, toAutomationScript, writeFlow } from '@escrcpy/flow-core'
import { startFlowMcpServer } from '@escrcpy/flow-mcp'
import type { Selector, UiElement } from '@escrcpy/flow-device'
import { createDeviceLease, createFlowDevice, FlowDeviceError, LeaseBusyError } from '@escrcpy/flow-device'
import { runFleet } from './fleet.js'

export const HELP = `flow — record once, replay without a model

Usage: flow <command> [options]

Commands:
  devices                       List connected devices
  dump [--xml] [--json]         Dump the screen and list its elements
  find <selector>               List elements matching a selector
  tap  <selector> | --x --y     Tap an element, or a 0~1 ratio point
  wait <selector> [--timeout]   Wait until an element appears
  text <string>                 Type into the focused field
  key  <name|code>              Send a key event (HOME, BACK, ENTER, …)
  screenshot -o <file>          Save a JPEG screenshot
  mcp [--trace-dir <dir>]       Start the flow-mcp stdio server
  compile <trace.jsonl> -o <flow.yaml>
                                Compile a recorded trace into a flow
  run <flow.yaml> -s <serial>   Replay a flow on an Android device
  fleet run <manifest.yaml>     Replay a manifest of flows across a device fleet
  export <flow.yaml> -o <file>  Export a flow as compatible JSON
  export <flow.yaml> -o <file> --format official  Export as official Escrcpy Automation JSON (point steps only)
  heal <report.json> [--apply]  Re-run a failed flow with LLM self-heal and emit a patch

Compile options:
  --var <name=value>            Override or declare a trace variable (repeatable)
  --name <name>                 Override the generated flow name
  --description <text>          Override the generated description
  --annotate                    Preserve recorded intents; model annotation is unavailable in M2

Run options:
  --var <name=value>            Set a required flow variable (repeatable)
  --report <path>               Write the run report to a JSON file or directory
  --out-dir <dir>               Directory for files written by extract steps (default: report dir, else .)
  --no-lease                    Skip the cross-process device lease acquire/release around the run
  --heal                        Let the L2 heal agent recover failed steps that have an expect
  --heal-goal                   When the run still fails, let the LLM explore toward the
                                flow's goal description and write a repair patch (implies --heal)
  --goal-max <n>                Cap goal-recovery exploration actions (default 30)

Heal options:
  --flow <path>                 Flow YAML for flow heal (default: the flowPath saved in the report)
  --apply                       Apply each produced patch to the flow file in place
  --heal-goal                   Also attempt goal-driven recovery if step healing cannot fix the run

Fleet options:
  --dry-run                     Print the expanded plan (device -> task queue) without touching devices
  --report-root <dir>           Root for fleet reports <flow>/<serial>/<timestamp>/report.json (default: reports)
  --on-busy <wait|skip>         Handle devices leased elsewhere: wait for release or skip (default: skip)

Selector options:
  --text <s>  --desc <s>  --id <s>  --class <s>  --exact  --index <n>

Common options:
  -s, --serial <serial>   Device (default: ANDROID_SERIAL, or the only device)
  --no-yadb               Use plain adb even when YADB_PATH is set

Environment:
  ADB_PATH         adb binary (default: adb on PATH)
  YADB_PATH        yadb binary, enables faster dumps and Unicode input
  ANDROID_SERIAL   default Android device serial
  FLOW_TRACE_DIR   trace directory used by flow mcp automatic recording
  FLOW_LLM_CONFIG  Path to the shared LLM config (default ~/.escrcpy/flow/llm.json, the desktop AI-model dialog)
  FLOW_LLM_BASE_URL / FLOW_LLM_API_KEY / FLOW_LLM_MODEL   Fallback LLM endpoint when the config has none
  FLOW_LLM_API_TYPE  messages (default), responses or chat_completions, matching the LLM endpoint style
`

interface CliValues {
  'serial'?: string
  'text'?: string
  'desc'?: string
  'id'?: string
  'class'?: string
  'exact'?: boolean
  'index'?: string
  'x'?: string
  'y'?: string
  'timeout'?: string
  'output'?: string
  'xml'?: boolean
  'json'?: boolean
  'no-yadb'?: boolean
  'help'?: boolean
  'trace-dir'?: string
  'adb-path'?: string
  'yadb-path'?: string
  'var'?: string[]
  'name'?: string
  'description'?: string
  'annotate'?: boolean
  'report'?: string
  'out-dir'?: string
  'format'?: string
  'dry-run'?: boolean
  'report-root'?: string
  'on-busy'?: string
  'no-lease'?: boolean
  'heal'?: boolean
  'heal-goal'?: boolean
  'goal-max'?: string
  'apply'?: boolean
  'flow'?: string
}

export interface ParsedCliArgs {
  values: CliValues
  positionals: string[]
}

const CLI_OPTIONS = {
  'serial': { type: 'string', short: 's' },
  'text': { type: 'string' },
  'desc': { type: 'string' },
  'id': { type: 'string' },
  'class': { type: 'string' },
  'exact': { type: 'boolean' },
  'index': { type: 'string' },
  'x': { type: 'string' },
  'y': { type: 'string' },
  'timeout': { type: 'string' },
  'output': { type: 'string', short: 'o' },
  'xml': { type: 'boolean' },
  'json': { type: 'boolean' },
  'no-yadb': { type: 'boolean' },
  'no-lease': { type: 'boolean' },
  'help': { type: 'boolean', short: 'h' },
  'trace-dir': { type: 'string' },
  'adb-path': { type: 'string' },
  'yadb-path': { type: 'string' },
  'var': { type: 'string', multiple: true },
  'name': { type: 'string' },
  'description': { type: 'string' },
  'annotate': { type: 'boolean' },
  'report': { type: 'string' },
  'out-dir': { type: 'string' },
  'format': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'report-root': { type: 'string' },
  'on-busy': { type: 'string' },
  'heal': { type: 'boolean' },
  'heal-goal': { type: 'boolean' },
  'goal-max': { type: 'string' },
  'apply': { type: 'boolean' },
  'flow': { type: 'string' },
} as const

export function parseCliArgs(argv: string[] = process.argv.slice(2)): ParsedCliArgs {
  const parsed = parseArgs({ allowPositionals: true, options: CLI_OPTIONS, args: argv })
  return { values: parsed.values as CliValues, positionals: parsed.positionals }
}

function selectorFromArgs(values: CliValues): Selector | undefined {
  const selector: Selector = {}
  if (values.text !== undefined)
    selector.text = values.text
  if (values.desc !== undefined)
    selector.content_desc = values.desc
  if (values.id !== undefined)
    selector.resource_id = values.id
  if (values.class !== undefined)
    selector.class_name = values.class
  if (values.exact)
    selector.exact = true
  if (values.index !== undefined)
    selector.index = parseInteger(values.index, '--index')
  return Object.keys(selector).length ? selector : undefined
}

function targetFromArgs(values: CliValues): Selector | { x: number, y: number } {
  if (values.x !== undefined || values.y !== undefined) {
    if (values.x === undefined || values.y === undefined)
      throw new Error('Give both --x and --y for a ratio point')
    return { x: parseNumber(values.x, '--x'), y: parseNumber(values.y, '--y') }
  }
  const selector = selectorFromArgs(values)
  if (!selector)
    throw new Error('Give a selector (--text/--desc/--id/--class) or --x and --y')
  return selector
}

function formatElement(e: UiElement): string {
  const flags = [
    e.clickable && 'clickable',
    e.scrollable && 'scrollable',
    e.focused && 'focused',
    e.checked && 'checked',
    e.selected && 'selected',
    e.enabled === false && 'disabled',
  ].filter(Boolean).join(',')
  const label = [
    e.text && `text=${JSON.stringify(e.text)}`,
    e.contentDesc && `desc=${JSON.stringify(e.contentDesc)}`,
    e.resourceId && `id=${e.resourceId}`,
  ].filter(Boolean).join(' ')
  return `#${String(e.id).padEnd(4)} ${e.type.padEnd(14)} (${e.centerX},${e.centerY}) ${label}${flags ? `  [${flags}]` : ''}`
}

function parseInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed))
    throw new Error(`${name} must be an integer`)
  return parsed
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    throw new Error(`${name} must be a number`)
  return parsed
}

function parseVars(values: CliValues): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const value of values.var ?? []) {
    const separator = value.indexOf('=')
    if (separator <= 0)
      throw new Error(`Invalid --var ${JSON.stringify(value)}; expected name=value`)
    result[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return result
}

function adbBackend(values: CliValues) {
  const adb = adbkit.Adb.createClient({ bin: values['adb-path'] ?? process.env.ADB_PATH })
  return createAdbx({ adb: adb as never, yadbPath: values['no-yadb'] ? '' : values['yadb-path'] ?? process.env.YADB_PATH })
}

async function selectedSerial(adbx: ReturnType<typeof adbBackend>, values: CliValues): Promise<string> {
  if (values.serial ?? process.env.ANDROID_SERIAL)
    return values.serial ?? process.env.ANDROID_SERIAL!
  const online = (await adbx.getDevices()).filter(device => device.type === 'device')
  if (online.length === 1)
    return online[0].id
  throw new Error(online.length ? `${online.length} devices connected; pick one with --serial` : 'No device connected')
}

export interface AutomationExport {
  format: 'escrcpy-automation'
  version: 1
  name: string
  description?: string
  steps: Array<{
    id: string
    action: FlowStep['do']
    intent?: string
    target?: Target[]
    with?: Record<string, unknown>
    expect?: FlowStep['expect']
    optional?: boolean
  }>
}

/**
 * Export the M2 flow subset in a stable JSON shape consumable by automation clients.
 * Unknown future flow fields are intentionally omitted until their execution semantics exist.
 */
export function exportFlow(flow: FlowScript): AutomationExport {
  return {
    format: 'escrcpy-automation',
    version: 1,
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    steps: flow.steps.map(step => ({
      id: step.id,
      action: step.do,
      ...(step.intent ? { intent: step.intent } : {}),
      ...(step.target ? { target: step.target } : {}),
      ...(step.with ? { with: step.with } : {}),
      ...(step.expect ? { expect: step.expect } : {}),
      ...(step.optional ? { optional: step.optional } : {}),
    })),
  }
}

async function compileCommand(input: string, values: CliValues): Promise<void> {
  const trace = await readTrace(input)
  const session = trace.find(event => event.type === 'session')
  const vars = { ...session?.vars, ...parseVars(values) }
  const result = await compileTraceFile(input, {
    vars,
    ...(values.name ?? session?.name ? { name: values.name ?? session?.name } : {}),
    ...(values.description ? { description: values.description } : {}),
  })
  if (!values.output)
    throw new Error('flow compile requires -o <flow.yaml>')
  await writeFlow(values.output, result.flow)
  for (const warning of result.warnings)
    console.error(`warning: ${warning}`)
  if (values.annotate)
    console.error('warning: --annotate is accepted for compatibility; M2 preserves recorded intents without model annotation')
  console.log(`compiled ${input} -> ${values.output} (${result.flow.steps.length} steps)`)
}

/**
 * Wrap a replay in the cross-process device lease so two agents cannot drive one
 * device at once. `--no-lease` opts out; a busy device fails fast with its holder.
 */
export async function withDeviceLease<T>(serial: string, values: CliValues, run: () => Promise<T>): Promise<T> {
  if (values['no-lease'])
    return run()
  const lease = createDeviceLease()
  try {
    await lease.acquire(serial, { holder: process.env.FLOW_AGENT_NAME ?? 'flow-run' })
  }
  catch (error) {
    if (error instanceof LeaseBusyError)
      throw new Error(`device busy: ${serial} is leased by ${error.lease.holder} (pid ${error.lease.pid}); retry after release or pass --no-lease`)
    throw error
  }
  try {
    return await run()
  }
  finally {
    await lease.release(serial)
  }
}

/** Self-heal needs a model: the shared llm.json (the desktop AI-model dialog writes it) wins; FLOW_LLM_* env is the fallback. */
function requireHealClient(): HealLlmClient {
  const fromConfig = resolveLlm(loadLlmConfig())
  if (fromConfig)
    return fromConfig.client
  const client = createEnvLlmClient(process.env)
  if (!client)
    throw new Error('self-heal needs an LLM: pick a vendor + model in the desktop AI-model dialog (~/.escrcpy/flow/llm.json), or set FLOW_LLM_BASE_URL, FLOW_LLM_API_KEY and FLOW_LLM_MODEL (FLOW_LLM_API_TYPE=messages|responses|chat_completions)')
  return client
}

/** `--heal-goal` with an optional `--goal-max` cap; NaN/nonpositive budgets are rejected here. */
function goalHealOption(values: CliValues): boolean | { maxActions: number } | undefined {
  if (!values['heal-goal'])
    return undefined
  const raw = values['goal-max']
  if (raw === undefined)
    return true
  const maxActions = Number(raw)
  if (!Number.isInteger(maxActions) || maxActions < 1)
    throw new Error(`--goal-max expects a positive integer, got ${raw}`)
  return { maxActions }
}

async function runCommand(input: string, values: CliValues): Promise<void> {
  if (!input)
    throw new Error('flow run requires a flow YAML path')
  const flow = await readFlow(input)
  const healClient = (values.heal || values['heal-goal']) ? requireHealClient() : undefined
  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const serial = await selectedSerial(adbx, values)
  const reportPath = values.report
  const reportDir = reportPath && !reportPath.toLowerCase().endsWith('.json') ? reportPath : undefined
  const report = await withDeviceLease(serial, values, () => replayFlow(flow, {
    device: { ...device, shell: (serial, command) => adbx.shell(serial, command) },
    serial,
    vars: parseVars(values),
    ...(reportDir ? { reportDir } : {}),
    ...(values['out-dir'] ? { outputDir: values['out-dir'] } : {}),
    ...(healClient ? { flowPath: input, heal: { client: healClient, writePatch: true, logger: (message: string) => console.error(message), ...(goalHealOption(values) ? { goal: goalHealOption(values) } : {}) } } : {}),
  }))
  if (reportPath?.toLowerCase().endsWith('.json'))
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`${report.status}: ${flow.name} on ${serial} (${report.durationMs} ms)`)
  for (const [id, output] of Object.entries(report.outputs ?? {}))
    console.log(`extract ${id}: ${output.rows.length} rows${output.file ? ` -> ${output.file}` : ''}`)
  for (const step of report.steps) {
    if (step.healed)
      console.log(`healed ${step.id}`)
  }
  if (report.goal)
    console.log(`goal: ${report.goal.achieved ? 'achieved' : 'not achieved'} — ${report.goal.reason ?? ''}${report.goal.patchPath ? ` (patch: ${report.goal.patchPath})` : ''}`)
  if (reportPath)
    console.log(`report: ${reportPath}${reportDir ? '/report.json' : ''}`)
  if (report.status === 'failed')
    process.exitCode = 1
}

/** Patch files written beside a flow YAML, e.g. by a `--heal` run of this CLI. */
async function listPatches(flowPath: string): Promise<string[]> {
  try {
    const names = await readdir(dirname(flowPath))
    return names.filter(name => name.startsWith(`${basename(flowPath)}.patch-`) && name.endsWith('.yaml')).sort()
  }
  catch {
    return []
  }
}

/**
 * Re-run the flow behind a failed report with the L2 heal agent enabled, emit a patch per
 * healed step, and optionally apply the patches to the flow file. `--flow` or the report's
 * saved flowPath locates the flow; patches always target the steps that failed.
 */
async function healCommand(reportPath: string, values: CliValues): Promise<void> {
  if (!reportPath)
    throw new Error('flow heal requires a report JSON path')
  const report: RunReport = JSON.parse(await readFile(reportPath, 'utf8'))
  if (report.status !== 'failed')
    throw new Error(`nothing to heal: report status is ${report.status}`)
  const failedStep = report.steps.find(step => step.status === 'failed')
  if (!failedStep)
    throw new Error('nothing to heal: the report has no failed step')
  const client = requireHealClient()
  const flowPath = values.flow ?? report.flowPath
  if (!flowPath)
    throw new Error('flow heal needs --flow <flow.yaml> or a flowPath saved in the report')
  const flow = await readFlow(flowPath)
  const step = flow.steps.find(step => step.id === failedStep.id)
  if (!step)
    throw new Error(`report step ${failedStep.id} is not in ${flowPath}`)
  if (!step.expect)
    throw new Error(`step ${failedStep.id} has no expect; the heal agent needs an assertion to verify`)

  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const serial = await selectedSerial(adbx, values)
  const before = new Set(await listPatches(flowPath))
  const healed = await withDeviceLease(serial, values, () => replayFlow(flow, {
    device: { ...device, shell: (serial, command) => adbx.shell(serial, command) },
    serial,
    vars: parseVars(values),
    flowPath,
    heal: { client, writePatch: true, logger: (message: string) => console.error(message), ...(goalHealOption(values) ? { goal: goalHealOption(values) } : {}) },
  }))
  const patches = (await listPatches(flowPath)).filter(path => !before.has(path))
  for (const stepReport of healed.steps) {
    if (stepReport.healed)
      console.log(`healed ${stepReport.id}`)
  }
  if (healed.goal)
    console.log(`goal: ${healed.goal.achieved ? 'achieved' : 'not achieved'} — ${healed.goal.reason ?? ''}${healed.goal.patchPath ? ` (patch: ${healed.goal.patchPath})` : ''}`)
  for (const patch of patches) {
    console.log(`patch: ${patch}`)
    if (values.apply) {
      await writeFlow(flowPath, await applyPatch(flowPath, patch))
      console.log(`applied ${patch} -> ${flowPath}`)
    }
  }
  if (!patches.length)
    console.error('no patch produced; see the heal log above')
  if (values.apply)
    console.error('note: --apply rewrites the flow file in place; keep a backup (e.g. git) before committing healed flows')
  if (healed.status === 'failed')
    process.exitCode = 1
}

async function fleetCommand(manifestPath: string, values: CliValues): Promise<void> {
  const onBusy = values['on-busy'] ?? 'skip'
  if (onBusy !== 'wait' && onBusy !== 'skip')
    throw new Error(`Unsupported --on-busy: ${onBusy}; expected wait or skip`)
  // Build the adb backend lazily so --dry-run never touches adb or the devices.
  let backend: ReturnType<typeof adbBackend> | undefined
  const adb = () => (backend ??= adbBackend(values))
  const summary = await runFleet(manifestPath, {
    ...(values['dry-run'] ? { dryRun: true } : {}),
    ...(values['report-root'] ? { reportRoot: values['report-root'] } : {}),
    onBusy,
  }, {
    // Each fleet task replays through the same device path as `flow run`.
    replay: (flow, options) => {
      const adbx = adb()
      const device = createFlowDevice({ adbx })
      return replayFlow(flow, { ...options, device: { ...device, shell: (serial, command) => adbx.shell(serial, command) } })
    },
    listOnlineSerials: async () => (await adb().getDevices()).filter(entry => entry.type === 'device').map(entry => entry.id),
    screenSize: serial => createFlowDevice({ adbx: adb() }).screenSize(serial),
  })
  if (summary.failed > 0)
    process.exitCode = 1
}

async function deviceCommand(command: string, positionals: string[], values: CliValues): Promise<void> {
  const adbx = adbBackend(values)
  if (command === 'devices') {
    for (const device of await adbx.getDevices())
      console.log(`${device.id}\t${device.type}`)
    return
  }
  const serial = await selectedSerial(adbx, values)
  const device = createFlowDevice({ adbx })
  const via = adbx.yadb.isAvailable() ? 'yadb' : 'uiautomator'

  switch (command) {
    case 'dump': {
      const snap = await device.snapshot(serial)
      if (values.xml) {
        process.stdout.write(snap.xml)
        return
      }
      const elements = device.elements(snap)
      if (values.json) {
        console.log(JSON.stringify({ snapshotId: snap.id, app: snap.app, size: snap.tree.size, elements }, null, 2))
        return
      }
      console.log(`${snap.id}  ${snap.app ? `${snap.app.package}/${snap.app.activity}` : 'unknown app'}  ${snap.tree.size.width}x${snap.tree.size.height}  ${snap.tree.nodes.length} nodes, ${elements.length} elements  dump ${snap.dumpMs} ms via ${via}`)
      for (const element of elements)
        console.log(formatElement(element))
      return
    }
    case 'find': {
      const selector = selectorFromArgs(values)
      if (!selector)
        throw new Error('Give a selector (--text/--desc/--id/--class)')
      const { snapshot, matches } = await device.find(serial, selector, 'fresh')
      console.log(`${matches.length} match(es) in ${snapshot.id}`)
      for (const node of matches)
        console.log(`#${node.id} ${node.className} text=${JSON.stringify(node.text)} desc=${JSON.stringify(node.contentDesc)} id=${node.resourceId} bounds=[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`)
      return
    }
    case 'tap': {
      const started = Date.now()
      const result = await device.tap(serial, targetFromArgs(values), { snapshot: 'fresh' })
      const what = result.node ? `${result.node.className} ${JSON.stringify(result.node.text || result.node.contentDesc || result.node.resourceId)} (${result.matchCount} match)` : 'point'
      console.log(`tapped ${what} at (${result.point.x},${result.point.y}) = ratio (${result.ratio.x},${result.ratio.y}) in ${Date.now() - started} ms`)
      return
    }
    case 'wait': {
      const selector = selectorFromArgs(values)
      if (!selector)
        throw new Error('Give a selector (--text/--desc/--id/--class)')
      const result = await device.waitFor(serial, selector, { timeoutMs: values.timeout ? parseInteger(values.timeout, '--timeout') : 10_000 })
      console.log(result.found
        ? `found after ${result.attempts} dump(s), ${result.elapsedMs} ms`
        : `not found after ${result.attempts} dump(s), ${result.elapsedMs} ms`)
      process.exitCode = result.found ? 0 : 1
      return
    }
    case 'text':
      await device.inputText(serial, positionals.join(' '))
      return
    case 'key': {
      const code = await device.key(serial, positionals[0] ?? '')
      console.log(`sent key ${code}`)
      return
    }
    case 'screenshot': {
      if (!values.output)
        throw new Error('Give an output file with -o')
      const image = await device.screenshot(serial)
      await writeFile(values.output, image.data)
      console.log(`saved ${values.output} (${image.width}x${image.height}, from ${image.sourceWidth}x${image.sourceHeight})`)
      return
    }
    default:
      throw new Error(`Unknown device command: ${command}. Run flow --help.`)
  }
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseCliArgs(argv)
  const command = positionals[0]
  if (!command || values.help) {
    process.stdout.write(HELP)
    return
  }
  if (command === 'mcp') {
    await startFlowMcpServer({
      adbPath: values['adb-path'] ?? process.env.ADB_PATH,
      yadbPath: values['no-yadb'] ? '' : values['yadb-path'] ?? process.env.YADB_PATH,
      defaultSerial: values.serial ?? process.env.ANDROID_SERIAL,
      traceDir: values['trace-dir'] ?? process.env.FLOW_TRACE_DIR,
    })
    return
  }
  if (command === 'compile') {
    const input = positionals[1]
    if (!input)
      throw new Error('flow compile requires a trace JSONL path')
    await compileCommand(input, values)
    return
  }
  if (command === 'run') {
    await runCommand(positionals[1], values)
    return
  }
  if (command === 'heal') {
    await healCommand(positionals[1], values)
    return
  }
  if (command === 'fleet') {
    if (positionals[1] !== 'run')
      throw new Error(`Unknown fleet command: ${positionals[1] ?? '(none)'}. Run flow --help.`)
    if (!positionals[2])
      throw new Error('flow fleet run requires a manifest YAML path')
    await fleetCommand(positionals[2], values)
    return
  }
  if (command === 'export') {
    const input = positionals[1]
    if (!input)
      throw new Error('flow export requires a flow YAML path')
    if (!values.output)
      throw new Error('flow export requires -o <file>')
    if (values.format && values.format !== 'escrcpy-automation' && values.format !== 'official' && values.format !== 'json')
      throw new Error(`Unsupported export format: ${values.format}`)
    const flow = await readFlow(input)
    if (values.format === 'official') {
      const { script, skipped } = toAutomationScript(flow)
      await writeFile(values.output, `${JSON.stringify(script, null, 2)}\n`, 'utf8')
      console.log(`exported ${input} -> ${values.output} (${script.steps.length} steps for the official Automation importer${skipped.length ? `; skipped selector-only steps: ${skipped.join(', ')}` : ''})`)
      return
    }
    await writeFile(values.output, `${JSON.stringify(exportFlow(flow), null, 2)}\n`, 'utf8')
    console.log(`exported ${input} -> ${values.output}`)
    return
  }
  await deviceCommand(command, positionals.slice(1), values)
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  runCli().catch((error) => {
    if (error instanceof FlowDeviceError && error.code === 'NOT_FOUND') {
      console.error(error.message)
      console.error('Visible elements:')
      for (const line of (error.details?.visible as string[] | undefined) ?? [])
        console.error(`  ${line}`)
    }
    else {
      console.error(error instanceof Error ? error.message : error)
    }
    process.exitCode = 1
  })
}
