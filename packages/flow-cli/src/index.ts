#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import { applyPatch, compileTraceFile, createEnvLlmClient, listPlaybooks, loadLlmConfig, PLAYBOOKS, readFlow, readTrace, replayFlow, requireJevClient, requireLlmEndpoint, resolveLlm, runPlaybook, runVisionAgent, toAutomationScript, visionDeviceFromFlowDevice, visualCheck, visualLocate, writeFlow } from '@escrcpy/flow-core'
import type { FlowScript, FlowStep, HealLlmClient, JevQuestions, PlaybookEvent, PlaybookThresholds, RunReport, Target, VisionAgentEvent, VisionObserveMode } from '@escrcpy/flow-core'
import { defaultVisionRunDir, isEntryModule, startFlowMcpServer } from '@escrcpy/flow-mcp'
import type { Selector, UiElement } from '@escrcpy/flow-device'
import { createDeviceLease, createFlowDevice, FlowDeviceError, LeaseBusyError, resolveYadbPath, withLease } from '@escrcpy/flow-device'
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
  agent --serial <s> --goal <text>
                                Let a vision LLM operate the device toward a goal (no script)
  see --serial <s> --locate <desc> | --ask <json>
                                Ask Jev about the current screen (Box + presence, or typed questions)
  playbook <id> --serial <s> [params]
                                Run a code-driven playbook (Jev judges each screen, the vision
                                agent takes over single uncertain steps); playbook list shows ids

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

Agent options (flow agent):
  --goal <text>                 Natural-language goal (required); --serial is required too
  --result-schema <json|file>   Shape expected in the result, e.g. '{"links":"string[]"}'
  --allow-package <pkg>         Foreground package the agent may act in (repeatable);
                                the first is launched when needed and relaunched once if left
  --forbid-text <text>          Extra label that must never be tapped (repeatable; defaults stay)
  --max-steps <n>               Step budget (default 30)
  --max-model-calls <n>         Model-call budget (default 2 x max-steps)
  --time-budget <ms>            Wall-clock budget (default 600000)
  --observe <mode>              screenshot | screenshot+tree (default)
  --launch <mode>               if-needed (default) | restart | never, for the first allowed package
  --model <vendor::model>       Model from llm.json (default: its active model)
  --run-dir <dir>               report.json + step screenshots (default ~/.escrcpy/flow/vision-runs/<serial>/<time>)
  --instructions <text>         Extra guidance for the model
  --jev                         Jev assist: visually refuse unlabeled social/purchase taps and
                                verify a successful done (clipboard links, final screen)
  --json                        Print only the final result JSON on stdout (progress goes to stderr)

See options (flow see):
  --locate <desc>               Box + presence for one control, e.g. "the Copy link button"
  --ask <json|file>             Questions {name: {type, instructions, criteria?}} about the screen ("screen");
                                or {"questions": {...}, "state": {...}} for extra state fields

Playbook options (flow playbook tiktok-shop-links):
  --keyword <text>              Search keyword (required)
  --count <n>                   Links to collect (default 3)
  --skip-ads                    Skip cards labelled Ad / Sponsored (default: keep and flag them)
  --model <vendor::model>       Takeover model from llm.json (default: its active model)
  --no-fallback                 No vision-agent takeovers: an uncertain step fails the run
  --box-threshold <0..1>        Box confidence needed to tap (default 0.6)
  --launch <mode>               restart (default) | if-needed | never
  --max-steps / --time-budget / --run-dir   as for flow agent (defaults 60 / 360000 /
                                ~/.escrcpy/flow/playbook-runs/<id>/<serial>/<time>)

Fleet options:
  --dry-run                     Print the expanded plan (device -> task queue) without touching devices
  --report-root <dir>           Root for fleet reports <flow>/<serial>/<timestamp>/report.json (default: reports)
  --on-busy <wait|skip>         Handle devices leased elsewhere: wait for release or skip (default: skip)

Selector options:
  --text <s>  --desc <s>  --id <s>  --class <s>  --exact  --index <n>

Common options:
  -s, --serial <serial>   Device (default: ANDROID_SERIAL, or the only device)
  --no-yadb               Use plain adb even when yadb is set or found

Environment:
  ADB_PATH         adb binary (default: adb on PATH)
  YADB_PATH        yadb binary, enables faster dumps and Unicode input
                   (default: the copy bundled with Escrcpy, when found)
  ANDROID_SERIAL   default Android device serial
  FLOW_TRACE_DIR   trace directory used by flow mcp automatic recording
  FLOW_LLM_CONFIG  Path to the shared LLM config (default ~/.escrcpy/flow/llm.json, the desktop AI-model dialog)
  FLOW_LLM_BASE_URL / FLOW_LLM_API_KEY / FLOW_LLM_MODEL   Fallback LLM endpoint when the config has none
  FLOW_LLM_API_TYPE  messages (default), responses or chat_completions, matching the LLM endpoint style
  FLOW_VISION_RUNS_DIR  Root for flow agent run directories (default ~/.escrcpy/flow/vision-runs)
  llm.json vendors may set "apiKeyEnv": "<ENV_NAME>" to read the key from the environment
  FLOW_JEV_BASE_URL / FLOW_JEV_API_KEY / FLOW_JEV_MODEL   Jev endpoint (default: llm.json "jev"
                   section, else magpie http://127.0.0.1:3425 with the magpie vendor key)
  FLOW_JEV_FALLBACK_BASE_URL / FLOW_JEV_FALLBACK_API_KEY   Optional endpoint for image/Box requests
                   when the primary answers "Images are not turned on" (off unless set)
  FLOW_PLAYBOOK_RUNS_DIR  Root for flow playbook run directories
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
  'goal'?: string
  'result-schema'?: string
  'allow-package'?: string[]
  'forbid-text'?: string[]
  'max-steps'?: string
  'max-model-calls'?: string
  'time-budget'?: string
  'observe'?: string
  'launch'?: string
  'model'?: string
  'run-dir'?: string
  'instructions'?: string
  'jev'?: boolean
  'locate'?: string
  'ask'?: string
  'keyword'?: string
  'count'?: string
  'skip-ads'?: boolean
  'no-fallback'?: boolean
  'box-threshold'?: string
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
  'goal': { type: 'string' },
  'result-schema': { type: 'string' },
  'allow-package': { type: 'string', multiple: true },
  'forbid-text': { type: 'string', multiple: true },
  'max-steps': { type: 'string' },
  'max-model-calls': { type: 'string' },
  'time-budget': { type: 'string' },
  'observe': { type: 'string' },
  'launch': { type: 'string' },
  'model': { type: 'string' },
  'run-dir': { type: 'string' },
  'instructions': { type: 'string' },
  'jev': { type: 'boolean' },
  'locate': { type: 'string' },
  'ask': { type: 'string' },
  'keyword': { type: 'string' },
  'count': { type: 'string' },
  'skip-ads': { type: 'boolean' },
  'no-fallback': { type: 'boolean' },
  'box-threshold': { type: 'string' },
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

/** --no-yadb > --yadb-path > YADB_PATH > a bundled/installed copy; '' means plain adb. */
function cliYadbPath(values: CliValues): string {
  return values['no-yadb'] ? '' : resolveYadbPath(values['yadb-path'])
}

function adbBackend(values: CliValues) {
  const adb = adbkit.Adb.createClient({ bin: values['adb-path'] ?? process.env.ADB_PATH })
  return createAdbx({ adb: adb as never, yadbPath: cliYadbPath(values) })
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

/** `--result-schema`: inline JSON, a JSON file, or a free-text description. */
export async function readResultSchema(value: string | undefined): Promise<unknown> {
  if (value === undefined)
    return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('['))
    return JSON.parse(trimmed)
  if (existsSync(trimmed)) {
    const text = await readFile(trimmed, 'utf8')
    try {
      return JSON.parse(text)
    }
    catch {
      return text
    }
  }
  return trimmed
}

function optionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined)
    return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} expects a positive integer, got ${value}`)
  return parsed
}

function describeAgentEvent(event: VisionAgentEvent): string | undefined {
  if (event.type === 'log')
    return `agent: ${event.message}`
  if (event.type !== 'step')
    return undefined
  const { step } = event
  const action = step.action ? JSON.stringify(step.action) : '(no action)'
  const guard = step.guard && 'blocked' in step.guard && step.guard.blocked ? ` BLOCKED: ${step.guard.reason}` : step.guard && 'unverifiedTap' in step.guard ? ' (unverified tap)' : ''
  const exec = step.execution ? (step.execution.ok ? (step.execution.output ? ` -> ${step.execution.output.slice(0, 160)}` : ' -> ok') : ` -> failed: ${step.execution.error}`) : ''
  const model = step.model ? ` [${step.model.latencyMs} ms${step.model.usage ? `, ${step.model.usage.promptTokens}+${step.model.usage.completionTokens} tok` : ''}]` : ''
  return `step ${step.index} ${step.app?.package ?? '?'}${model}: ${action}${guard}${exec}${step.error ? ` (${step.error})` : ''}${step.thought ? `  // ${step.thought.slice(0, 120)}` : ''}`
}

/**
 * `flow agent`: a vision LLM drives the device toward --goal under the runner's
 * guardrails. Prints the final result JSON (stdout) and exits 0 only on success.
 */
async function agentCommand(values: CliValues): Promise<void> {
  const serial = values.serial
  if (!serial)
    throw new Error('flow agent requires an explicit --serial')
  if (!values.goal?.trim())
    throw new Error('flow agent requires --goal <text>')
  if (values.observe && values.observe !== 'screenshot' && values.observe !== 'screenshot+tree')
    throw new Error(`--observe expects screenshot or screenshot+tree, got ${values.observe}`)
  if (values.launch && !['if-needed', 'restart', 'never'].includes(values.launch))
    throw new Error(`--launch expects if-needed, restart or never, got ${values.launch}`)
  const resultSchema = await readResultSchema(values['result-schema'])
  const endpoint = requireLlmEndpoint(values.model)
  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const runDir = values['run-dir'] ?? defaultVisionRunDir(serial)
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const run = () => runVisionAgent({
    serial,
    goal: values.goal!,
    resultSchema,
    allowedPackages: values['allow-package'],
    forbiddenTexts: values['forbid-text'],
    maxSteps: optionalPositiveInt(values['max-steps'], '--max-steps'),
    maxModelCalls: optionalPositiveInt(values['max-model-calls'], '--max-model-calls'),
    timeBudgetMs: optionalPositiveInt(values['time-budget'], '--time-budget'),
    observe: values.observe as VisionObserveMode | undefined,
    launch: values.launch as 'if-needed' | 'restart' | 'never' | undefined,
    instructions: values.instructions,
    ...(values.jev ? { jev: requireJevClient() } : {}),
    endpoint,
    device: visionDeviceFromFlowDevice(device, adbx),
    runDir,
    signal: controller.signal,
    onEvent: (event) => {
      const line = describeAgentEvent(event)
      if (line)
        console.error(line)
    },
  })
  let result
  try {
    result = values['no-lease']
      ? await run()
      : await withLease(createDeviceLease(), serial, { holder: process.env.FLOW_AGENT_NAME ?? 'flow-agent' }, run).catch((error) => {
          if (error instanceof LeaseBusyError)
            throw new Error(`device busy: ${serial} is leased by ${error.lease.holder} (pid ${error.lease.pid}); retry after release`)
          throw error
        })
  }
  finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  if (values.json)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  else
    console.log(JSON.stringify(result, null, 2))
  if (!result.success)
    process.exitCode = 1
}

/** `flow see`: one Jev request about the current screen. Read-only, no lease. */
async function seeCommand(values: CliValues): Promise<void> {
  const serial = values.serial
  if (!serial)
    throw new Error('flow see requires an explicit --serial')
  if (!values.locate === !values.ask)
    throw new Error('flow see needs exactly one of --locate <description> or --ask <json>')
  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const jev = requireJevClient()
  let output: unknown
  if (values.locate) {
    output = await visualLocate({ serial, description: values.locate, device, jev })
  }
  else {
    const parsed = await readResultSchema(values.ask) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object')
      throw new Error('--ask expects a JSON object of questions')
    const wrapped = parsed.questions && typeof parsed.questions === 'object' && !('type' in (parsed.questions as object))
    const questions = (wrapped ? parsed.questions : parsed) as JevQuestions
    const state = wrapped ? parsed.state as Record<string, unknown> | undefined : undefined
    const result = await visualCheck({ serial, questions, state, device, jev })
    output = { answers: result.summary, screen: result.screen, jev: result.jev }
  }
  process.stdout.write(values.json ? `${JSON.stringify(output)}\n` : `${JSON.stringify(output, null, 2)}\n`)
}

function describePlaybookEvent(event: PlaybookEvent): string | undefined {
  if (event.type === 'log')
    return `playbook: ${event.message}`
  if (event.type !== 'step')
    return undefined
  const { step } = event
  const page = step.jev?.answers.page as { choice?: string, confidence?: number } | undefined
  const jev = step.jev ? ` [jev ${step.jev.latencyMs} ms${page?.choice ? `, ${page.choice} ${page.confidence}` : ''}]` : ''
  const actions = step.actions.map(action => `${action.type}${action.target ? `(${action.target})` : action.key ? `(${action.key})` : ''}${action.blocked ? ' BLOCKED' : ''}`).join(' ')
  const fallback = step.fallback ? ` TAKEOVER ${step.fallback.status} ${step.fallback.steps} steps ${step.fallback.tokens.total} tok` : ''
  return `step ${step.index} ${step.goal}${jev}: ${step.decision ?? ''}${actions ? ` -> ${actions}` : ''}${fallback}${step.error ? ` (${step.error})` : ''}`
}

function parseRatio(value: string | undefined, name: string): number | undefined {
  if (value === undefined)
    return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new Error(`${name} expects a number between 0 and 1, got ${value}`)
  return parsed
}

/**
 * `flow playbook <id>`: a code-driven task where Jev judges each screen and the
 * vision agent takes over single uncertain steps. Prints the result JSON and
 * exits 0 only on success.
 */
async function playbookCommand(id: string | undefined, values: CliValues): Promise<void> {
  if (!id || id === 'list') {
    process.stdout.write(`${JSON.stringify(listPlaybooks(), null, 2)}\n`)
    return
  }
  if (!PLAYBOOKS[id])
    throw new Error(`unknown playbook "${id}"; available: ${Object.keys(PLAYBOOKS).join(', ')}`)
  const serial = values.serial
  if (!serial)
    throw new Error('flow playbook requires an explicit --serial')
  if (values.launch && !['if-needed', 'restart', 'never'].includes(values.launch))
    throw new Error(`--launch expects restart, if-needed or never, got ${values.launch}`)
  const params: Record<string, unknown> = {}
  if (values.keyword !== undefined)
    params.keyword = values.keyword
  if (values.count !== undefined)
    params.count = optionalPositiveInt(values.count, '--count')
  if (values['skip-ads'])
    params.skipAds = true
  const boxThreshold = parseRatio(values['box-threshold'], '--box-threshold')
  const thresholds: Partial<PlaybookThresholds> = boxThreshold === undefined ? {} : { box: boxThreshold }
  const jev = requireJevClient()
  const fallback = values['no-fallback'] ? false as const : { endpoint: requireLlmEndpoint(values.model) }
  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const runDir = values['run-dir'] ?? join(process.env.FLOW_PLAYBOOK_RUNS_DIR ?? join(homedir(), '.escrcpy', 'flow', 'playbook-runs'), id, serial, new Date().toISOString().replace(/[:.]/g, '-'))
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let result
  try {
    result = await runPlaybook(id, {
      serial,
      params,
      device: visionDeviceFromFlowDevice(device, adbx),
      jev,
      fallback,
      forbiddenTexts: values['forbid-text'],
      thresholds,
      maxSteps: optionalPositiveInt(values['max-steps'], '--max-steps'),
      timeBudgetMs: optionalPositiveInt(values['time-budget'], '--time-budget'),
      launch: values.launch as 'restart' | 'if-needed' | 'never' | undefined,
      runDir,
      ...(values['no-lease'] ? {} : { lease: createDeviceLease(), leaseHolder: process.env.FLOW_AGENT_NAME ?? `flow-playbook:${id}` }),
      signal: controller.signal,
      onEvent: (event) => {
        const line = describePlaybookEvent(event)
        if (line)
          console.error(line)
      },
    })
  }
  catch (error) {
    if (error instanceof LeaseBusyError)
      throw new Error(`device busy: ${serial} is leased by ${error.lease.holder} (pid ${error.lease.pid}); retry after release`)
    throw error
  }
  finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  if (!result.success)
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
  // Ad-hoc commands intentionally bypass the lease (they are for humans poking
  // at a device), but say so when another process holds one.
  const held = await createDeviceLease().info(serial).catch(() => undefined)
  if (held)
    console.error(`note: ${serial} is currently leased by ${held.holder} (pid ${held.pid}); this ad-hoc command bypasses the lease`)
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
      yadbPath: cliYadbPath(values),
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
  if (command === 'agent') {
    await agentCommand(values)
    return
  }
  if (command === 'see') {
    await seeCommand(values)
    return
  }
  if (command === 'playbook') {
    await playbookCommand(positionals[1], values)
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

if (isEntryModule(import.meta.url)) {
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
