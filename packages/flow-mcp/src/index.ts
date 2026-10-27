#!/usr/bin/env node
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import type { Adbx } from '@escrcpy/adbx'
import {
  createFlowDevice,

} from '@escrcpy/flow-device'
import type { FlowDevice, RatioPoint, Selector, Snapshot } from '@escrcpy/flow-device'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  asError,
  deviceInfo,
  elementTarget,

  hitTarget,
  json,
  prepareBefore,
  runTool,
  serialFor,
  stateResult,

} from './context.js'
import type { FlowMcpContext, ToolExecutionResult } from './context.js'
import { FlowTraceRecorder } from './recorder.js'
import type { TraceDevice } from './recorder.js'

/** When set, the server records a trace to this directory without agent cooperation. */
export const TRACE_DIR_ENV = 'FLOW_TRACE_DIR'

export interface FlowMcpOptions {
  device: FlowDevice
  adbx?: Adbx
  recorder?: FlowTraceRecorder
  traceDir?: string
  defaultSerial?: string
  resolveSerial?: (serial?: string) => Promise<string>
  describeDevice?: (serial: string) => Promise<TraceDevice>
  logger?: (message: string, error?: unknown) => void
}

export interface RealFlowMcpOptions {
  adbPath?: string
  yadbPath?: string
  defaultSerial?: string
  traceDir?: string
}

export interface FlowMcpServer {
  server: McpServer
  context: FlowMcpContext & { adbx?: Adbx, autoTraceDir?: string }
}

const selectorShape = {
  serial: z.string().optional().describe('Android device serial; defaults to the selected device'),
  text: z.string().optional(),
  content_desc: z.string().optional(),
  resource_id: z.string().optional(),
  class_name: z.string().optional(),
  exact: z.boolean().optional(),
  index: z.number().int().optional(),
}

const pointShape = {
  serial: z.string().optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}

const selectorSchema = z.object(selectorShape)

function selectorOf(args: z.infer<typeof selectorSchema>): Selector {
  const { serial: _serial, ...selector } = args
  const fields = Object.fromEntries(Object.entries(selector).filter(([, value]) => value !== undefined))
  if (!Object.keys(fields).some(key => !['exact', 'index'].includes(key)))
    throw new Error('Give at least one selector field')
  return fields as Selector
}

function pointOf(args: { x: number, y: number }): RatioPoint {
  return { x: args.x, y: args.y }
}

function formatError(error: unknown): { content: [{ type: 'text', text: string }], isError: true } {
  const detail = asError(error)
  const suffix = detail.details ? `\n${JSON.stringify(detail.details)}` : ''
  return { content: [{ type: 'text', text: `${detail.message}${suffix}` }], isError: true }
}

function ok(value: unknown) {
  return json(value)
}

function loggerFor(options: FlowMcpServer): (message: string, error?: unknown) => void {
  return options.context.logger ?? ((message, error) => console.error(`[flow-mcp] ${message}`, error ?? ''))
}

async function ensureAutoRecording(context: FlowMcpServer['context'], args: Record<string, unknown>): Promise<void> {
  if (!context.autoTraceDir || !context.recorder || context.recorder.isActive)
    return
  const serialArg = typeof args.serial === 'string' ? args.serial : undefined
  const serial = await serialFor(context, serialArg)
  const device = await deviceInfo(context, serial)
  await context.recorder.start({ name: 'auto', task: 'Automatic FLOW_TRACE_DIR recording', vars: {}, device })
}

async function invoke(
  flow: FlowMcpServer,
  tool: string,
  args: any,
  kind: 'action' | 'observe' | 'meta',
  handler: (serial: string, before?: Snapshot) => Promise<unknown | ToolExecutionResult>,
  opts: { serial?: string, before?: boolean } = {},
) {
  const { context } = flow
  try {
    if (tool !== 'flow_record_start' && tool !== 'flow_record_stop' && tool !== 'flow_step')
      await ensureAutoRecording(context, args)
    const serial = opts.serial ?? (typeof args.serial === 'string' ? await serialFor(context, args.serial) : undefined)
    const before = opts.before && serial ? await prepareBefore(context, serial) : undefined
    const value = await runTool(context, tool, args, () => handler(serial!, before), kind, before)
    return ok(value)
  }
  catch (error) {
    loggerFor(flow)(`${tool} failed`, error)
    return formatError(error)
  }
}

function registerTool(flow: FlowMcpServer, name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<ReturnType<typeof ok> | ReturnType<typeof formatError>>) {
  flow.server.registerTool(name, { description, inputSchema }, async (args): Promise<ReturnType<typeof ok> | ReturnType<typeof formatError>> => {
    try {
      return await handler(args)
    }
    catch (error) {
      loggerFor(flow)(`${name} failed`, error)
      return formatError(error)
    }
  })
}

function registerFlowTools(flow: FlowMcpServer): void {
  const { context } = flow
  registerTool(flow, 'device_list', 'List connected Android devices.', {}, async () => {
    const devices = context.adbx ? await context.adbx.getDevices() : []
    return ok(devices)
  })

  registerTool(flow, 'device_select', 'Select the default Android device for subsequent calls.', { serial: z.string() }, async ({ serial }) => {
    const selected = await serialFor(context, serial)
    context.defaultSerial = selected
    return ok({ serial: selected })
  })

  registerTool(flow, 'device_info', 'Return device identity and screen information.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'device_info', args, 'observe', async () => deviceInfo(context, serial))
  })

  registerTool(flow, 'get_foreground_app', 'Return the foreground application.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'get_foreground_app', args, 'observe', async () => context.device.foregroundApp(serial))
  })

  registerTool(flow, 'get_screen_state', 'Dump the current UI tree and list interactive elements.', { serial: selectorShape.serial, include_screenshot: z.boolean().optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'get_screen_state', args, 'observe', async () => {
      const snapshot = await context.device.snapshot(serial)
      const image = args.include_screenshot ? await context.device.screenshot(serial) : undefined
      return { value: stateResult(snapshot, context.device.elements(snapshot), image), snapshot, snapshotRef: snapshot.id }
    })
  })

  registerTool(flow, 'ui_dump', 'Dump the UI hierarchy as XML or parsed JSON.', { serial: selectorShape.serial, format: z.enum(['xml', 'json']).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'ui_dump', args, 'observe', async () => {
      const snapshot = await context.device.snapshot(serial)
      return args.format === 'xml'
        ? { value: { snapshotId: snapshot.id, xml: snapshot.xml }, snapshot, snapshotRef: snapshot.id }
        : { value: stateResult(snapshot, context.device.elements(snapshot)), snapshot, snapshotRef: snapshot.id }
    })
  })

  registerTool(flow, 'ui_find_element', 'Find visible UI elements matching a selector.', { ...selectorShape, snapshot_id: z.string().optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'ui_find_element', args, 'observe', async () => {
      const result = await context.device.find(serial, selectorOf(args), args.snapshot_id ?? 'fresh')
      return { value: { snapshotId: result.snapshot.id, matches: result.matches.map(node => ({ ...node })) }, snapshot: result.snapshot, snapshotRef: result.snapshot.id }
    })
  })

  registerTool(flow, 'ui_wait_for', 'Wait until a selector matches a UI element.', { ...selectorShape, timeout_ms: z.number().int().min(0).max(60_000).optional(), poll_interval_ms: z.number().int().min(0).max(10_000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'ui_wait_for', args, 'observe', async () => {
      const result = await context.device.waitFor(serial, selectorOf(args), { timeoutMs: args.timeout_ms, intervalMs: args.poll_interval_ms })
      return { value: { found: result.found, snapshotId: result.snapshot.id, match: result.match, attempts: result.attempts, elapsedMs: result.elapsedMs }, snapshot: result.snapshot, snapshotRef: result.snapshot.id }
    })
  })

  registerTool(flow, 'screenshot', 'Capture a JPEG screenshot as base64.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'screenshot', args, 'observe', async () => {
      const image = await context.device.screenshot(serial)
      return { data: image.data.toString('base64'), mimeType: 'image/jpeg', width: image.width, height: image.height, sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight }
    })
  })

  registerTool(flow, 'ui_tap', 'Find one UI element and tap its center.', { ...selectorShape, settle: z.number().int().min(0).max(5000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'ui_tap', args, 'action', async (_serial, before) => {
      const target = selectorOf(args)
      const result = await context.device.tap(serial, target, { snapshot: before?.id ?? 'fresh' })
      const traceTarget = before ? elementTarget(before, result) : undefined
      return { value: { ...result, point: result.point, ratio: result.ratio }, target: traceTarget }
    }, { serial, before: true })
  })

  registerTool(flow, 'tap', 'Tap a 0~1 ratio coordinate.', pointShape, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'tap', args, 'action', async (_serial, before) => {
      const point = pointOf(args)
      await context.device.tap(serial, point)
      return { value: { serial, ratio: point }, target: await hitTarget(context, serial, point, before) }
    }, { serial, before: true })
  })

  registerTool(flow, 'long_press', 'Long press a 0~1 ratio coordinate.', { ...pointShape, duration_ms: z.number().int().min(1).max(60_000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'long_press', args, 'action', async (_serial, before) => {
      const result = await context.device.longPress(serial, pointOf(args), { durationMs: args.duration_ms })
      return { value: result, target: before ? elementTarget(before, result) : undefined }
    }, { serial, before: true })
  })

  registerTool(flow, 'swipe', 'Swipe between two 0~1 ratio coordinates.', { serial: selectorShape.serial, x1: z.number().min(0).max(1), y1: z.number().min(0).max(1), x2: z.number().min(0).max(1), y2: z.number().min(0).max(1), duration_ms: z.number().int().min(1).max(60_000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'swipe', args, 'action', async () => context.device.swipe(serial, pointOf({ x: args.x1, y: args.y1 }), pointOf({ x: args.x2, y: args.y2 }), args.duration_ms), { serial, before: true })
  })

  registerTool(flow, 'key_event', 'Send a key event by Android key name or numeric code.', { serial: selectorShape.serial, keycode: z.union([z.string(), z.number()]) }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'key_event', args, 'action', async () => ({ keycode: await context.device.key(serial, args.keycode) }), { serial, before: true })
  })

  registerTool(flow, 'input_text', 'Type text into the focused field.', { serial: selectorShape.serial, text: z.string() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'input_text', args, 'action', async () => {
      await context.device.inputText(serial, args.text)
      return { serial, length: args.text.length }
    }, { serial, before: true })
  })

  registerTool(flow, 'app_start', 'Start an Android application.', { serial: selectorShape.serial, package: z.string(), activity: z.string().optional(), restart: z.boolean().optional(), settle: z.number().int().min(0).max(5000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_start', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_start requires an ADB backend')
      if (args.restart)
        await context.adbx.shell(serial, `am force-stop ${args.package}`)
      const component = args.activity ? `${args.package}/${args.activity}` : undefined
      await context.adbx.shell(serial, component ? `am start -n ${component}` : `monkey -p ${args.package} -c android.intent.category.LAUNCHER 1`)
      return { serial, package: args.package, activity: args.activity }
    }, { serial, before: true })
  })

  registerTool(flow, 'app_stop', 'Stop an Android application.', { serial: selectorShape.serial, package: z.string(), settle: z.number().int().min(0).max(5000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_stop', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_stop requires an ADB backend')
      await context.adbx.shell(serial, `am force-stop ${args.package}`)
      return { serial, package: args.package }
    }, { serial, before: true })
  })

  registerTool(flow, 'open_url', 'Open a URL on the Android device.', { serial: selectorShape.serial, url: z.string(), settle: z.number().int().min(0).max(5000).optional() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'open_url', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('open_url requires an ADB backend')
      const escaped = args.url.replaceAll('\'', '\'\\\'\'')
      await context.adbx.shell(serial, `am start -a android.intent.action.VIEW -d '${escaped}'`)
      return { serial, url: args.url }
    }, { serial, before: true })
  })

  registerTool(flow, 'clipboard_get', 'Read the Android clipboard.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'clipboard_get', args, 'observe', async () => {
      if (!context.adbx)
        throw new Error('clipboard_get requires an ADB backend')
      return context.adbx.clipboard.read(serial)
    })
  })

  registerTool(flow, 'clipboard_set', 'Write the Android clipboard.', { serial: selectorShape.serial, text: z.string() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'clipboard_set', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('clipboard_set requires an ADB backend')
      await context.adbx.clipboard.write(serial, args.text)
      return { serial }
    }, { serial, before: true })
  })

  registerTool(flow, 'shell_exec', 'Run a shell command on the selected Android device.', { serial: selectorShape.serial, command: z.string() }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'shell_exec', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('shell_exec requires an ADB backend')
      return { output: await context.adbx.shell(serial, args.command) }
    }, { serial, before: true })
  })

  registerTool(flow, 'flow_record_start', 'Start recording calls to a JSONL trace.', { name: z.string(), task: z.string(), vars: z.record(z.string(), z.unknown()).optional(), serial: selectorShape.serial }, async (args) => {
    if (!context.recorder)
      throw new Error('Recording is unavailable; set FLOW_TRACE_DIR or provide a recorder')
    const serial = await serialFor(context, args.serial)
    const device = await deviceInfo(context, serial)
    const result = await context.recorder.start({ name: args.name, task: args.task, vars: args.vars, device })
    return ok(result)
  })

  registerTool(flow, 'flow_step', 'Declare the intent for the next logical flow step.', { intent: z.string() }, async ({ intent }) => {
    if (!context.recorder)
      throw new Error('Recording is unavailable; set FLOW_TRACE_DIR or provide a recorder')
    await context.recorder.setIntent(intent)
    await context.recorder.recordCall({ tool: 'flow_step', args: { intent }, ok: true, kind: 'meta', durationMs: 0 })
    return ok({ intent })
  })

  registerTool(flow, 'flow_record_stop', 'Stop recording and return the trace path.', { outcome: z.string().default('completed') }, async ({ outcome }) => {
    if (!context.recorder)
      throw new Error('Recording is unavailable; set FLOW_TRACE_DIR or provide a recorder')
    return ok(await context.recorder.stop(outcome))
  })

  flow.server.registerPrompt('flow/explore', {
    title: 'Explore and record an Android flow',
    description: 'Guide an agent to explore an Android UI and produce a useful record/replay trace.',
    argsSchema: { task: z.string().optional() },
  }, ({ task }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Explore the Android task${task ? `: ${task}` : ''}. Before each logical step call flow_step with a short intent. Prefer get_screen_state and ui_tap with selectors; use coordinate tap only when the UI tree cannot identify the target. Perform one action at a time, observe after meaningful changes, and verify the final state with a UI assertion or observation. Preserve the exact user text in input_text.`,
      },
    }],
  }))
}

export function createFlowMcpServer(options: FlowMcpOptions): FlowMcpServer {
  const traceDir = options.traceDir ?? process.env[TRACE_DIR_ENV]
  const recorder = options.recorder ?? (traceDir ? new FlowTraceRecorder({ dir: traceDir }) : undefined)
  const context: FlowMcpServer['context'] = {
    device: options.device,
    recorder,
    defaultSerial: options.defaultSerial ?? process.env.ANDROID_SERIAL,
    resolveSerial: options.resolveSerial ?? (async (serial) => {
      if (serial || context.defaultSerial)
        return serial ?? context.defaultSerial!
      if (!options.adbx)
        throw new Error('No device selected; pass serial or call device_select')
      const devices = (await options.adbx.getDevices()).filter(device => device.type === 'device')
      if (devices.length === 1)
        return devices[0].id
      throw new Error(devices.length ? 'Multiple devices connected; pass serial or call device_select' : 'No Android device connected')
    }),
    describeDevice: options.describeDevice,
    logger: options.logger,
    adbx: options.adbx,
    autoTraceDir: traceDir,
  }
  const server = new McpServer({ name: 'flow-mcp', version: '0.0.0' })
  const flow = { server, context }
  registerFlowTools(flow)
  return flow
}

export function createRealFlowMcpServer(options: RealFlowMcpOptions = {}): FlowMcpServer {
  const adb = adbkit.Adb.createClient(options.adbPath ? { bin: options.adbPath } : {})
  const adbx = createAdbx({ adb: adb as never, yadbPath: options.yadbPath ?? process.env.YADB_PATH })
  const device = createFlowDevice({ adbx })
  return createFlowMcpServer({ ...options, adbx, device })
}

export async function startFlowMcpServer(options: RealFlowMcpOptions = {}): Promise<void> {
  const flow = createRealFlowMcpServer(options)
  const transport = new StdioServerTransport()
  await flow.server.connect(transport)
  console.error('[flow-mcp] stdio server started')
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  startFlowMcpServer().catch((error) => {
    console.error('[flow-mcp] fatal', error)
    process.exitCode = 1
  })
}

export * from './context.js'
export * from './recorder.js'
