#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import type { Adbx } from '@escrcpy/adbx'
import { shellEscape, validateShellCommand } from '@escrcpy/shared'
import {
  createDeviceLease,
  createFlowDevice,

} from '@escrcpy/flow-device'
import type { DeviceLease, FlowDevice, RatioPoint, Selector, Snapshot } from '@escrcpy/flow-device'
import { AUTO_RECORDING_TASK, compileTraceFile, llmConfigPath, loadLlmConfig, parseFlow, readFlow, replayFlow, resolveLlm, saveLlmConfig, writeFlow } from '@escrcpy/flow-core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import {
  asError,
  deviceInfo,
  elementTarget,
  hitTarget,
  isMcpContentResult,
  json,
  leaseDetails,
  mcpContent,
  prepareBefore,
  runTool,
  serialFor,
  stateResult,

} from './context.js'
import type { FlowMcpContext, McpContentBlock, ToolExecutionResult } from './context.js'
import { FlowTraceRecorder } from './recorder.js'
import type { TraceDevice } from './recorder.js'

/** When set, the server records a trace to this directory without agent cooperation. */
export const TRACE_DIR_ENV = 'FLOW_TRACE_DIR'

export interface FlowMcpOptions {
  device: FlowDevice
  adbx?: Adbx
  /** Cross-process device lease; defaults to createDeviceLease() with FLOW_LEASE_DIR defaults. */
  lease?: DeviceLease
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

const settleShape = z.number().int().min(0).max(5000).optional().describe('Milliseconds to wait after the action completes, so the UI can settle (integer 0-5000, default 300)')

const pointShape = {
  serial: z.string().optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  settle: settleShape,
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
  if (!context.autoTraceDir || context.autoRecordingDismissed || !context.recorder || context.recorder.isActive)
    return
  const serialArg = typeof args.serial === 'string' ? args.serial : undefined
  const serial = await serialFor(context, serialArg)
  const device = await deviceInfo(context, serial)
  await context.recorder.start({ name: 'auto', task: AUTO_RECORDING_TASK, vars: {}, device })
}

async function settle(ms: unknown): Promise<void> {
  if (typeof ms === 'number' && ms > 0)
    await new Promise(resolve => setTimeout(resolve, ms))
}

function shellQuote(value: string): string {
  return `'${shellEscape(value)}'`
}

function safeShell(command: string): string {
  validateShellCommand(command)
  return command
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
    if (tool !== 'flow_record_start' && tool !== 'flow_record_stop')
      await ensureAutoRecording(context, args)
    const serial = opts.serial ?? (typeof args.serial === 'string' ? await serialFor(context, args.serial) : undefined)
    // Policy B (design 10.2): actions refuse a device leased by another process, but never acquire one.
    if (kind === 'action' && serial && context.lease) {
      const lease = await context.lease.info(serial)
      if (lease && lease.pid !== process.pid)
        throw new Error(`DEVICE_BUSY: ${serial} is leased by ${lease.holder} (pid ${lease.pid}); wait for device_release or claim another device`)
      if (lease)
        await context.lease.refresh(serial).catch(() => {})
    }
    const before = opts.before && serial ? await prepareBefore(context, serial) : undefined
    const value = await runTool(context, tool, args, () => handler(serial!, before), kind, before)
    if (isMcpContentResult(value))
      return { content: value.__mcpContent__, isError: false } as { content: McpContentBlock[], isError: false }
    return ok(value)
  }
  catch (error) {
    loggerFor(flow)(`${tool} failed`, error)
    return formatError(error)
  }
}

type ToolResponse = ReturnType<typeof ok> | ReturnType<typeof formatError> | { content: McpContentBlock[], isError: false }

function registerTool(flow: FlowMcpServer, name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<ToolResponse>) {
  flow.server.registerTool(name, { description, inputSchema }, async (args): Promise<ToolResponse> => {
    try {
      return await handler(args)
    }
    catch (error) {
      loggerFor(flow)(`${name} failed`, error)
      return formatError(error)
    }
  })
}

/** Where saved *.flow.yaml scripts live; shared with the desktop app and the CLI. */
function flowScriptsDir(): string {
  return process.env.FLOW_SCRIPTS_DIR ?? join(homedir(), '.escrcpy', 'flow', 'scripts')
}

/** Accept an absolute path to a .flow.yaml or a bare flow name inside the scripts dir. */
async function resolveFlowPath(pathOrName: string): Promise<string> {
  if (/[\\/]/.test(pathOrName) || pathOrName.endsWith('.yaml') || pathOrName.endsWith('.yml'))
    return pathOrName
  const dir = flowScriptsDir()
  for (const candidate of [`${pathOrName}.flow.yaml`, `${pathOrName}.flow.yml`, `${pathOrName}.yaml`]) {
    const path = join(dir, candidate)
    if (existsSync(path))
      return path
  }
  throw new Error(`flow not found in ${dir}: ${pathOrName}`)
}

const healGoalShape = z.union([z.boolean(), z.number().int().min(1).max(100)]).optional().describe('After healing fails, free-explore toward the flow description (true, or an action budget number) and patch the script')

interface FlowRunArgs {
  flowPath: string
  script: Awaited<ReturnType<typeof readFlow>>
  serial: string
  vars?: Record<string, unknown>
  heal?: boolean
  healGoal?: boolean | number
}

/**
 * Replay one flow on one device behind the shared lease, mirroring the
 * desktop run path: adb device + shell capability, optional LLM heal and
 * goal-driven recovery from the shared llm.json, reports under
 * ~/.escrcpy/flow/reports.
 */
async function runFlowReplay(context: FlowMcpServer['context'], args: FlowRunArgs): Promise<unknown> {
  const { flowPath, script, serial } = args
  // Prefer the injected device (real server or test fake); shell steps need
  // an ADB backend and go through adbx when one exists.
  const base = context.device ?? (() => {
    const adb = adbkit.Adb.createClient()
    return createFlowDevice({ adbx: createAdbx({ adb, yadbPath: process.env.YADB_PATH }) })
  })()
  const device = {
    ...base,
    shell: (serial_: string, command: string) => {
      if (!context.adbx)
        return Promise.reject(new Error('flow_run shell steps require an ADB backend'))
      return context.adbx.shell(serial_, command)
    },
  }
  const lease = context.lease ?? createDeviceLease()
  await lease.acquire(serial, { holder: 'flow-mcp' })
  const reportDir = join(process.env.FLOW_REPORTS_DIR ?? join(homedir(), '.escrcpy', 'flow', 'reports'), script.name, serial, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(reportDir, { recursive: true })
  try {
    const wantsHeal = args.heal || args.healGoal
    const resolved = wantsHeal ? resolveLlm(loadLlmConfig()) : undefined
    if (wantsHeal && !resolved)
      throw new Error('heal requested but no LLM is configured; set one with llm_config_set_active or llm_config_set')
    const goal = typeof args.healGoal === 'number' ? { maxActions: args.healGoal } : true
    const report = await replayFlow(script, {
      serial,
      device,
      vars: args.vars,
      flowPath,
      reportDir,
      outputDir: reportDir,
      ...(resolved ? { heal: { client: resolved.client, writePatch: true, ...(args.healGoal ? { goal } : {}) } } : {}),
    })
    return { report, reportDir }
  }
  finally {
    await lease.release(serial)
  }
}

function registerFlowTools(flow: FlowMcpServer): void {
  const { context } = flow
  registerTool(flow, 'device_list', 'List connected Android devices with their lease state.', {}, async () => {
    const devices = context.adbx ? await context.adbx.getDevices() : []
    const listed = await Promise.all(devices.map(async (device) => {
      // An unreadable lock file must not hide the device; report it as unleased.
      const lease = context.lease ? await context.lease.info(device.id).catch(() => undefined) : undefined
      return { ...device, lease: lease ? leaseDetails(lease) : null }
    }))
    return ok(listed)
  })

  registerTool(flow, 'device_select', 'Select the default Android device for subsequent calls.', { serial: z.string() }, async ({ serial }) => {
    const selected = await serialFor(context, serial)
    context.defaultSerial = selected
    return ok({ serial: selected })
  })

  // Claim/release are recorded as meta: they coordinate agents, not the device UI,
  // so compileTrace produces no replay steps for them.
  registerTool(flow, 'device_claim', 'Claim an exclusive cross-process lease on a device.', { serial: selectorShape.serial, holder: z.string().optional().describe('Holder name recorded in the lease; defaults to the agent pid') }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'device_claim', args, 'meta', async () => {
      if (!context.lease)
        throw new Error('Lease is unavailable; provide a lease')
      return context.lease.acquire(serial, { holder: args.holder })
    }, { serial })
  })

  registerTool(flow, 'device_release', 'Release the lease on a device.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'device_release', args, 'meta', async () => {
      if (!context.lease)
        throw new Error('Lease is unavailable; provide a lease')
      return context.lease.release(serial)
    }, { serial })
  })

  // LLM config is shared state for every flow consumer (desktop dialog, CLI, MCP),
  // so unlike the decompiled Copilot it stays reachable from the agent side. Keys are masked.
  registerTool(flow, 'llm_config_get', 'Read the shared self-heal LLM config (vendors and active model; API keys are masked).', {}, async () => {
    const config = loadLlmConfig()
    return ok({
      active: config?.active,
      vendors: (config?.vendors ?? []).map(vendor => ({
        id: vendor.id,
        name: vendor.name,
        baseUrl: vendor.baseUrl,
        apiType: vendor.apiType ?? 'messages',
        apiKey: vendor.apiKey ? `${vendor.apiKey.slice(0, 4)}***` : '',
        models: vendor.models.map(model => model.id),
      })),
      path: llmConfigPath(),
    })
  })

  registerTool(flow, 'llm_config_set_active', 'Switch the active self-heal model to <vendorId>::<modelId>.', { active: z.string().describe('vendorId::modelId, e.g. magpie::claude/claude-sonnet-5-5') }, async (args) => {
    const [vendorId, model] = args.active.split('::')
    const config = loadLlmConfig() ?? { vendors: [] }
    if (!config.vendors.some(vendor => vendor.id === vendorId && vendor.models.some(item => item.id === model)))
      throw new Error(`unknown vendor/model: ${args.active}; call llm_config_get for the list`)
    config.active = args.active
    const path = saveLlmConfig(config)
    return ok({ active: args.active, path })
  })

  registerTool(flow, 'device_info', 'Return device identity and screen information.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'device_info', args, 'observe', async () => deviceInfo(context, serial))
  })

  registerTool(flow, 'get_foreground_app', 'Return the foreground application.', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'get_foreground_app', args, 'observe', async () => {
      const app = await context.device.foregroundApp(serial)
      // No resumed activity is a valid answer (screen off / locked); json(undefined)
      // would fail MCP response validation, so report it structurally.
      return app ?? { app: null, note: 'no resumed activity reported; the screen may be off or locked' }
    })
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

  registerTool(flow, 'screenshot', 'Capture the current screen and return it as a native MCP image content block (clients can view it directly).', { serial: selectorShape.serial }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'screenshot', args, 'observe', async () => {
      const image = await context.device.screenshot(serial)
      const meta = { mimeType: image.mimeType, width: image.width, height: image.height, sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight }
      return mcpContent(
        { type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType },
        { type: 'text', text: JSON.stringify(meta) },
      )
    })
  })

  registerTool(flow, 'ui_tap', 'Find one UI element and tap its center.', { ...selectorShape, settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'ui_tap', args, 'action', async (_serial, before) => {
      const target = selectorOf(args)
      const value = await context.device.tap(serial, target, { snapshot: before?.id ?? 'fresh' })
      const traceTarget = before ? elementTarget(before, value) : undefined
      await settle(args.settle)
      return { value: { ...value, point: value.point, ratio: value.ratio }, target: traceTarget }
    }, { serial, before: true })
  })

  registerTool(flow, 'tap', 'Tap a 0~1 ratio coordinate.', pointShape, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'tap', args, 'action', async (_serial, before) => {
      const point = pointOf(args)
      await context.device.tap(serial, point)
      await settle(args.settle)
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

  registerTool(flow, 'key_event', 'Send a key event by Android key name or numeric code.', { serial: selectorShape.serial, keycode: z.union([z.string(), z.number()]), settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'key_event', args, 'action', async () => {
      const keycode = await context.device.key(serial, args.keycode)
      await settle(args.settle)
      return { keycode }
    }, { serial, before: true })
  })

  registerTool(flow, 'input_text', 'Type text into the focused field.', { serial: selectorShape.serial, text: z.string(), settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'input_text', args, 'action', async () => {
      await context.device.inputText(serial, args.text)
      await settle(args.settle)
      return { serial, length: args.text.length }
    }, { serial, before: true })
  })

  registerTool(flow, 'app_start', 'Start an Android application.', { serial: selectorShape.serial, package: z.string(), activity: z.string().optional(), restart: z.boolean().optional(), settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_start', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_start requires an ADB backend')
      if (args.restart)
        await context.adbx.shell(serial, safeShell(`am force-stop ${shellQuote(args.package)}`))
      const component = args.activity ? `${args.package}/${args.activity}` : undefined
      await context.adbx.shell(serial, component ? safeShell(`am start -n ${shellQuote(component)}`) : safeShell(`monkey -p ${shellQuote(args.package)} -c android.intent.category.LAUNCHER 1`))
      await settle(args.settle)
      return { serial, package: args.package, activity: args.activity }
    }, { serial })
  })

  registerTool(flow, 'app_stop', 'Stop an Android application.', { serial: selectorShape.serial, package: z.string(), settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_stop', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_stop requires an ADB backend')
      await context.adbx.shell(serial, safeShell(`am force-stop ${shellQuote(args.package)}`))
      await settle(args.settle)
      return { serial, package: args.package }
    }, { serial, before: true })
  })

  registerTool(flow, 'open_url', 'Open a URL on the Android device.', { serial: selectorShape.serial, url: z.string(), settle: settleShape }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'open_url', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('open_url requires an ADB backend')
      const escaped = shellQuote(args.url)
      await context.adbx.shell(serial, safeShell(`am start -a android.intent.action.VIEW -d ${escaped}`))
      await settle(args.settle)
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
      return { output: await context.adbx.shell(serial, safeShell(args.command)) }
    }, { serial, before: true })
  })

  registerTool(flow, 'app_install', 'Install a local APK file onto the device.', { serial: selectorShape.serial, path: z.string().describe('Absolute path to the .apk on this machine'), reinstall: z.boolean().optional().describe('Pass true to keep app data when replacing an installed package (pm install -r)') }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_install', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_install requires an ADB backend')
      if (!existsSync(args.path))
        throw new Error(`APK not found: ${args.path}`)
      const remote = `/data/local/tmp/escrcpy-install-${Date.now()}.apk`
      await context.adbx.push(serial, args.path, remote)
      try {
        const flags = args.reinstall ? ' -r' : ''
        const output = await context.adbx.shell(serial, safeShell(`pm install${flags} ${shellQuote(remote)}`), { stderr: true })
        if (/\bFailure\b|INSTALL_FAILED/.test(output))
          throw new Error(output.trim())
        return { serial, output: output.trim() || 'Success' }
      }
      finally {
        await context.adbx.shell(serial, safeShell(`rm -f ${shellQuote(remote)}`)).catch(() => {})
      }
    }, { serial, before: true })
  })

  registerTool(flow, 'app_uninstall', 'Uninstall a package from the device.', { serial: selectorShape.serial, package: z.string(), keep_data: z.boolean().optional().describe('Pass true for pm uninstall -k (remove the app but keep its data and caches)') }, async (args) => {
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'app_uninstall', args, 'action', async () => {
      if (!context.adbx)
        throw new Error('app_uninstall requires an ADB backend')
      const flags = args.keep_data ? ' -k' : ''
      const output = await context.adbx.shell(serial, safeShell(`pm uninstall${flags} ${shellQuote(args.package)}`))
      if (!/^Success$/m.test(output.trim()))
        throw new Error(output.trim())
      return { serial, package: args.package }
    }, { serial, before: true })
  })

  registerTool(flow, 'flow_list', 'List saved replayable flow scripts (*.flow.yaml).', {}, async () => {
    const dir = flowScriptsDir()
    if (!existsSync(dir))
      return ok({ dir, flows: [] })
    const flows = readdirSync(dir)
      .filter(file => /\.flow\.ya?ml$/.test(file))
      .map((file) => {
        const path = join(dir, file)
        try {
          const script = parseFlow(readFileSync(path, 'utf8'))
          return { file, path, name: script.name, description: script.description ?? '', vars: Object.keys(script.vars ?? {}), steps: script.steps.length }
        }
        catch (error) {
          return { file, path, error: asError(error).message }
        }
      })
      .sort((a, b) => a.file.localeCompare(b.file))
    return ok({ dir, flows })
  })

  registerTool(flow, 'flow_run', 'Replay a saved flow script on a device (deterministic, no LLM unless healing is on).', {
    serial: selectorShape.serial,
    path: z.string().describe('Absolute path to the .flow.yaml; a bare name resolves inside the scripts dir'),
    vars: z.record(z.string(), z.unknown()).optional(),
    heal: z.boolean().optional().describe('Retry failed steps with the configured LLM and write a patch file'),
    heal_goal: healGoalShape,
  }, async (args) => {
    const flowPath = await resolveFlowPath(args.path)
    const script = await readFlow(flowPath)
    const serial = await serialFor(context, args.serial)
    return invoke(flow, 'flow_run', args, 'action', async () => runFlowReplay(context, {
      flowPath,
      script,
      serial,
      vars: args.vars,
      heal: args.heal,
      healGoal: args.heal_goal,
    }), { serial })
  })

  registerTool(flow, 'flow_compile', 'Compile a recorded JSONL trace into a replayable flow script saved next to the others.', {
    trace_path: z.string().describe('Absolute path to the JSONL trace (see flow_record_stop)'),
    name: z.string().regex(/^[\w-]+$/, 'name may only contain letters, digits and hyphens').optional().describe('Defaults to the trace session name'),
    description: z.string().optional(),
  }, async (args) => {
    const { flow: compiled, warnings } = await compileTraceFile(args.trace_path, { name: args.name, description: args.description })
    const path = join(flowScriptsDir(), `${compiled.name}.flow.yaml`)
    mkdirSync(flowScriptsDir(), { recursive: true })
    await writeFlow(path, compiled)
    return ok({ path, name: compiled.name, steps: compiled.steps.length, warnings })
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
    context.autoRecordingDismissed = true
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
    lease: options.lease ?? createDeviceLease(),
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

/** MCP tool surface as the copilot agent loop sees it. */
export interface InProcessTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface InProcessFlowMcp {
  tools: InProcessTool[]
  /** Runs one tool; resolves with its text content, rejects on isError. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  close: () => Promise<void>
}

/**
 * Same real MCP server the CLI exposes over stdio, wired to an in-memory client
 * so the desktop copilot can drive it without spawning a subprocess.
 */
export async function createInProcessFlowMcp(options: RealFlowMcpOptions = {}): Promise<InProcessFlowMcp> {
  const flow = createRealFlowMcpServer(options)
  const client = new Client({ name: 'escrcpy-copilot', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    flow.server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  const listed = await client.listTools()
  return {
    tools: listed.tools.map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
    })),
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      const content = (result.content ?? []) as Array<{ type?: string, text?: string }>
      const text = content.map(item => item.text ?? '').join('\n').trim()
      if (result.isError)
        throw new Error(text || `tool ${name} failed`)
      return text || JSON.stringify(result.structuredContent ?? '') || 'ok'
    },
    close: async () => {
      await client.close()
    },
  }
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
