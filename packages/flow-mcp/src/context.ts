import type { Adbx } from '@escrcpy/adbx'
import type { DeviceLease, FlowDevice, LeaseInfo, RatioPoint, Selector, Snapshot, Target, UiElement } from '@escrcpy/flow-device'
import { closestClickable, FlowDeviceError, hitTest, LeaseBusyError } from '@escrcpy/flow-device'
import type { FlowTraceRecorder, TraceCall, TraceDevice, TraceTarget } from './recorder.js'

export interface AdbxLike {
  deviceInfo: Adbx['deviceInfo']
}

export interface FlowMcpContext {
  device: FlowDevice
  /** Cross-process lease behind device_claim/device_release and device_list lease annotations. */
  lease?: DeviceLease
  /** Set after an explicit flow_record_stop so FLOW_TRACE_DIR auto-recording does not restart. */
  autoRecordingDismissed?: boolean
  recorder?: FlowTraceRecorder
  defaultSerial?: string
  resolveSerial?: (serial?: string) => Promise<string>
  describeDevice?: (serial: string) => Promise<TraceDevice>
  adbx?: AdbxLike
  logger?: (message: string, error?: unknown) => void
}

export interface ToolResult {
  value: unknown
  trace?: Omit<TraceCall, 'durationMs'>
}

export function json(value: unknown): { content: [{ type: 'text', text: string }], structuredContent: Record<string, unknown> } {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent }
}

export type McpContentBlock =
  | { type: 'text', text: string }
  | { type: 'image', data: string, mimeType: string }

/** Marker result that makes invoke() return native MCP content blocks (e.g. images) instead of a text JSON wrapper. */
export interface McpContentResult {
  __mcpContent__: McpContentBlock[]
}

export function mcpContent(...blocks: McpContentBlock[]): McpContentResult {
  return { __mcpContent__: blocks }
}

export function isMcpContentResult(value: unknown): value is McpContentResult {
  return Boolean(value && typeof value === 'object' && '__mcpContent__' in value && Array.isArray((value as McpContentResult).__mcpContent__))
}

/** The lease fields exposed to agents; the serial lives on the device entry itself. */
export function leaseDetails(info: LeaseInfo): { holder: string, pid: number, acquiredAt: number } {
  return { holder: info.holder, pid: info.pid, acquiredAt: info.acquiredAt }
}

export function asError(error: unknown): { message: string, details?: Record<string, unknown> } {
  if (error instanceof LeaseBusyError)
    return { message: error.message, details: { lease: leaseDetails(error.lease) } }
  if (error instanceof FlowDeviceError)
    return { message: error.message, details: error.details }
  return { message: error instanceof Error ? error.message : String(error) }
}

export function targetFromSelector(args: { resource_id?: string, text?: string, content_desc?: string, class_name?: string, exact?: boolean, index?: number }): Selector {
  const selector: Selector = {}
  if (args.resource_id !== undefined)
    selector.resource_id = args.resource_id
  if (args.text !== undefined)
    selector.text = args.text
  if (args.content_desc !== undefined)
    selector.content_desc = args.content_desc
  if (args.class_name !== undefined)
    selector.class_name = args.class_name
  if (args.exact !== undefined)
    selector.exact = args.exact
  if (args.index !== undefined)
    selector.index = args.index
  if (!Object.keys(selector).some(key => key !== 'exact' && key !== 'index'))
    throw new Error('Give at least one selector field')
  return selector
}

export function ratioPoint(x: number, y: number): RatioPoint {
  return { x, y }
}

export function elementTarget(snapshot: Snapshot, target: { node?: Snapshot['tree']['nodes'][number], matchCount?: number, point?: { x: number, y: number }, ratio?: { x: number, y: number } }): TraceTarget | undefined {
  if (!target.node)
    return target.point || target.ratio ? { text: '', contentDesc: '', resourceId: '', className: '', bounds: [0, 0, 0, 0], ...(target.point ? { point: target.point } : {}), ...(target.ratio ? { ratio: target.ratio } : {}) } : undefined
  const node = target.node
  return {
    text: node.text,
    contentDesc: node.contentDesc,
    resourceId: node.resourceId,
    className: node.className,
    bounds: [node.bounds.left, node.bounds.top, node.bounds.right, node.bounds.bottom],
    ...(target.matchCount === undefined ? {} : { matchCount: target.matchCount }),
    ...(target.point ? { point: target.point } : {}),
    ...(target.ratio ? { ratio: target.ratio } : {}),
  }
}

export function stateResult(snapshot: Snapshot, elements: UiElement[], screenshot?: { data: Buffer, mimeType: string, width: number, height: number }): Record<string, unknown> {
  return {
    snapshotId: snapshot.id,
    app: snapshot.app,
    size: snapshot.tree.size,
    elements,
    ...(screenshot ? { screenshot: { data: screenshot.data.toString('base64'), mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } } : {}),
  }
}

export async function serialFor(context: FlowMcpContext, serial?: string): Promise<string> {
  if (context.resolveSerial)
    return context.resolveSerial(serial)
  if (serial || context.defaultSerial)
    return serial ?? context.defaultSerial!
  throw new Error('No device selected; pass serial or call device_select')
}

export async function deviceInfo(context: FlowMcpContext, serial: string): Promise<TraceDevice> {
  if (context.describeDevice)
    return context.describeDevice(serial)
  const [size, model, sdk, density] = await Promise.all([
    context.device.screenSize(serial),
    context.adbx ? context.adbx.deviceInfo.getProperty(serial, 'ro.product.model').catch(() => undefined) : Promise.resolve(undefined),
    context.adbx ? context.adbx.deviceInfo.getProperty(serial, 'ro.build.version.sdk').catch(() => undefined) : Promise.resolve(undefined),
    context.adbx ? context.adbx.deviceInfo.getProperty(serial, 'ro.sf.lcd_density').catch(() => undefined) : Promise.resolve(undefined),
  ])
  return { serial, width: size.width, height: size.height, ...(model ? { model } : {}), ...(sdk ? { sdk: Number(sdk) } : {}), ...(density ? { density: Number(density) } : {}) }
}

export async function prepareBefore(context: FlowMcpContext, serial: string): Promise<Snapshot | undefined> {
  if (!context.recorder?.isActive)
    return undefined
  try {
    return await context.device.snapshot(serial)
  }
  catch {
    // Some screens never go idle (looping animation) and cannot be dumped. The action
    // is still recorded, without a locator, so replay falls back to its coordinates.
    return undefined
  }
}

export async function record(context: FlowMcpContext, call: Omit<TraceCall, 'durationMs'> & { startedAt: number }): Promise<void> {
  if (!context.recorder)
    return
  await context.recorder.recordCall({ ...call, durationMs: Date.now() - call.startedAt })
}

export async function hitTarget(context: FlowMcpContext, serial: string, point: RatioPoint, before?: Snapshot): Promise<TraceTarget | undefined> {
  // Only the pre-action snapshot describes what was tapped; the screen has changed since.
  if (!before)
    return undefined
  const x = point.x * before.tree.size.width
  const y = point.y * before.tree.size.height
  const node = hitTest(before.tree, { x, y })
  const clickable = node ? closestClickable(before.tree, node) : undefined
  return elementTarget(before, { node: clickable ?? node, point: { x, y }, ratio: point })
}

export interface ToolExecutionResult {
  value: unknown
  target?: TraceTarget
  snapshot?: Snapshot
  snapshotRef?: string
}

export type ToolHandler = (args: any) => Promise<unknown | ToolExecutionResult>

export async function runTool(context: FlowMcpContext, tool: string, args: any, handler: ToolHandler, kind: TraceCall['kind'], before?: Snapshot): Promise<unknown> {
  const startedAt = Date.now()
  try {
    const result = await handler(args)
    const execution = isToolExecutionResult(result) ? result : { value: result }
    const snapshotRef = execution.snapshotRef ?? (execution.value && typeof execution.value === 'object' && 'snapshotId' in execution.value && typeof (execution.value as { snapshotId?: unknown }).snapshotId === 'string' ? (execution.value as { snapshotId: string }).snapshotId : undefined)
    const snapshot = execution.snapshot
    await record(context, { tool, args, ok: true, kind, before, snapshot, target: execution.target, snapshotRef, startedAt })
    return execution.value
  }
  catch (error) {
    const detail = asError(error)
    await record(context, { tool, args, ok: false, kind, before, error: detail.message, startedAt })
    throw error
  }
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  return Boolean(value && typeof value === 'object' && 'value' in value && ('target' in value || 'snapshot' in value || 'snapshotRef' in value))
}

export function selectorArgs(args: any): Selector {
  return targetFromSelector(args)
}

export function targetArgs(args: any): Target {
  if (args.x !== undefined || args.y !== undefined)
    return ratioPoint(args.x, args.y)
  return selectorArgs(args)
}
