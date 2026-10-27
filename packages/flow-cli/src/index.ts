#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import type { FlowScript, FlowStep, Target } from '@escrcpy/flow-core'
import { compileTraceFile, readFlow, readTrace, replayFlow, writeFlow } from '@escrcpy/flow-core'
import { startFlowMcpServer } from '@escrcpy/flow-mcp'
import type { Selector, UiElement } from '@escrcpy/flow-device'
import { createFlowDevice, FlowDeviceError } from '@escrcpy/flow-device'

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
  export <flow.yaml> -o <file>  Export a flow as compatible JSON

Compile options:
  --var <name=value>            Override or declare a trace variable (repeatable)
  --name <name>                 Override the generated flow name
  --description <text>          Override the generated description
  --annotate                    Preserve recorded intents; model annotation is unavailable in M2

Run options:
  --var <name=value>            Set a required flow variable (repeatable)
  --report <path>               Write the run report to a JSON file or directory

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
  'format'?: string
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
  'help': { type: 'boolean', short: 'h' },
  'trace-dir': { type: 'string' },
  'adb-path': { type: 'string' },
  'yadb-path': { type: 'string' },
  'var': { type: 'string', multiple: true },
  'name': { type: 'string' },
  'description': { type: 'string' },
  'annotate': { type: 'boolean' },
  'report': { type: 'string' },
  'format': { type: 'string' },
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

async function runCommand(input: string, values: CliValues): Promise<void> {
  if (!input)
    throw new Error('flow run requires a flow YAML path')
  const flow = await readFlow(input)
  const adbx = adbBackend(values)
  const device = createFlowDevice({ adbx })
  const serial = await selectedSerial(adbx, values)
  const reportPath = values.report
  const reportDir = reportPath && !reportPath.toLowerCase().endsWith('.json') ? reportPath : undefined
  const report = await replayFlow(flow, {
    device: { ...device, shell: (serial, command) => adbx.shell(serial, command) },
    serial,
    vars: parseVars(values),
    ...(reportDir ? { reportDir } : {}),
  })
  if (reportPath?.toLowerCase().endsWith('.json'))
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`${report.status}: ${flow.name} on ${serial} (${report.durationMs} ms)`)
  if (reportPath)
    console.log(`report: ${reportPath}${reportDir ? '/report.json' : ''}`)
  if (report.status === 'failed')
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
      yadbPath: values['yadb-path'] ?? process.env.YADB_PATH,
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
  if (command === 'export') {
    const input = positionals[1]
    if (!input)
      throw new Error('flow export requires a flow YAML path')
    if (!values.output)
      throw new Error('flow export requires -o <file>')
    if (values.format && values.format !== 'escrcpy-automation' && values.format !== 'json')
      throw new Error(`Unsupported export format: ${values.format}`)
    const flow = await readFlow(input)
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
