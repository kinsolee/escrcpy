import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findAll } from '@escrcpy/flow-device'
import type { Snapshot, UiNode } from '@escrcpy/flow-device'
import type { FlowScript, FlowStep, Selector, Target } from './schema.js'
import { FLOW_SCHEMA_VERSION, flowSchema } from './schema.js'

export interface TraceSessionEvent {
  type: 'session'
  id: string
  name: string
  task: string
  vars?: Record<string, unknown>
  device: { serial: string, model?: string, sdk?: number, width?: number, height?: number, density?: number }
  startedAt: number
}

export interface TraceTarget {
  text?: string
  contentDesc?: string
  resourceId?: string
  className?: string
  bounds?: [number, number, number, number]
  matchCount?: number
  point?: { x: number, y: number }
  ratio?: { x: number, y: number }
  crop?: string
  image?: string
}

export interface TraceCallEvent {
  type: 'call'
  seq: number
  ts: number
  tool: string
  args?: Record<string, unknown>
  ok: boolean
  kind: 'action' | 'observe' | 'meta'
  before?: { snapshotId: string, app?: { package: string, activity?: string } }
  target?: TraceTarget
  snapshotRef?: string
  durationMs?: number
  intent?: string
  error?: string
}

export interface TraceEndEvent {
  type: 'end'
  outcome: string
  endedAt: number
}

export type TraceEvent = TraceSessionEvent | TraceCallEvent | TraceEndEvent
export type TraceSnapshots = Record<string, Snapshot> | Map<string, Snapshot>

export interface CompileTraceOptions {
  snapshots?: TraceSnapshots | string
  name?: string
  description?: string
  vars?: Record<string, unknown>
  defaults?: { timeout?: number, settle?: number, pollInterval?: number }
}

export interface CompileResult {
  flow: FlowScript
  warnings: string[]
}

export function parseTrace(source: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim())
      continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    }
    catch (error) {
      throw new Error(`Invalid trace JSON on line ${lineNumber + 1}: ${(error as Error).message}`)
    }
  }
  return events
}

export async function readTrace(path: string): Promise<TraceEvent[]> {
  return parseTrace(await readFile(path, 'utf8'))
}

export async function compileTraceFile(path: string, options: CompileTraceOptions = {}): Promise<CompileResult> {
  const snapshots = await loadSnapshots(options.snapshots ?? join(dirname(path), 'snapshots'))
  // No name fallback here: compileTrace already prefers session.name, and the
  // file id (tr_xxx) is only a worse last resort than the recorded name.
  return compileTrace(await readTrace(path), { ...options, snapshots })
}

async function loadSnapshots(source: TraceSnapshots | string): Promise<TraceSnapshots> {
  if (typeof source !== 'string')
    return source
  const snapshots = new Map<string, Snapshot>()
  try {
    for (const file of await readdir(source)) {
      if (!file.endsWith('.json'))
        continue
      const snapshot = JSON.parse(await readFile(join(source, file), 'utf8')) as Snapshot
      if (snapshot.id)
        snapshots.set(snapshot.id, snapshot)
    }
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR')
      throw error
  }
  return snapshots
}

export function compileTrace(input: string | TraceEvent[], options: CompileTraceOptions = {}): CompileResult {
  const events = typeof input === 'string' ? parseTrace(input) : input
  const session = events.find((event): event is TraceSessionEvent => event.type === 'session')
  if (!session)
    throw new Error('Trace is missing a session event')
  const snapshots = typeof options.snapshots === 'string' ? undefined : options.snapshots
  const warnings: string[] = []
  const values = options.vars ?? session.vars ?? {}
  const vars = Object.fromEntries(Object.keys(values).map(key => [key, { required: true }]))
  const defaults = { timeout: 8_000, settle: 300, ...options.defaults }
  const calls = events.filter((event): event is TraceCallEvent => event.type === 'call')
  const actionCalls = calls.filter(event => event.kind === 'action' && event.ok)
  const intents = new Map<number, string>()
  let pendingIntent: string | undefined
  for (const event of calls) {
    if (event.tool === 'flow_step' && event.ok) {
      const intent = typeof event.args?.intent === 'string' ? event.args.intent : event.intent
      pendingIntent = intent
      continue
    }
    if (event.kind === 'action' && event.ok && pendingIntent) {
      intents.set(event.seq, pendingIntent)
      pendingIntent = undefined
    }
  }

  if (!actionCalls.length)
    throw new Error('Trace has no successful action calls to compile')

  const rawSteps: FlowStep[] = []
  const compiledCalls: TraceCallEvent[] = []
  for (const [index, call] of actionCalls.entries()) {
    const step = callToStep(call, snapshots, values, warnings)
    if (!step)
      continue
    const intent = call.intent ?? intents.get(call.seq)
    rawSteps.push({ ...step, ...(intent ? { intent } : {}), id: step.id || `step-${index + 1}` })
    compiledCalls.push(call)
  }
  if (!rawSteps.length)
    throw new Error('Trace has no supported successful actions to compile')
  const steps = mergeInputText(rawSteps, values)
  for (const [index, step] of steps.entries()) {
    const next = steps[index + 1]
    const visible = next?.target?.[0] ?? (index === steps.length - 1 ? lastVisibleSelector(compiledCalls.at(-1), snapshots, calls) : undefined)
    if (visible && !step.expect)
      steps[index] = { ...step, expect: { visible } }
  }

  const firstApp = actionCalls.find(call => call.before?.app)?.before?.app
  const app = firstApp ? { package: firstApp.package, ...(firstApp.activity ? { activity: firstApp.activity } : {}) } : undefined
  const device = session.device
  const flow = flowSchema.parse({
    version: FLOW_SCHEMA_VERSION,
    name: options.name ?? session.name,
    description: options.description ?? session.task,
    ...(app ? { app } : {}),
    recordedOn: {
      ...(device.model ? { model: device.model } : {}),
      ...(device.sdk === undefined ? {} : { sdk: device.sdk }),
      ...(device.width === undefined || device.height === undefined ? {} : { size: [device.width, device.height] }),
      trace: session.id,
    },
    vars,
    defaults,
    interrupts: [],
    steps,
  })
  return { flow, warnings }
}

function callToStep(call: TraceCallEvent, snapshots: TraceSnapshots | undefined, values: Record<string, unknown>, warnings: string[]): FlowStep | undefined {
  const step = actionStep(call, snapshots, values, warnings)
  // A settle chosen while recording is what the UI needed to become ready; keep it for replay.
  const settle = call.args?.settle
  return step && typeof settle === 'number' && settle >= 0 ? { ...step, settle } : step
}

function actionStep(call: TraceCallEvent, snapshots: TraceSnapshots | undefined, values: Record<string, unknown>, warnings: string[]): FlowStep | undefined {
  const args = call.args ?? {}
  const id = `step-${call.seq}`
  const target = call.target ? targetsFor(call.target, snapshots, call.before?.snapshotId, values, warnings) : undefined
  const withArgs = { ...args }
  delete withArgs.serial
  delete withArgs.settle
  switch (call.tool) {
    case 'ui_tap':
    case 'tap':
      return { id, do: 'tap', ...(target ? { target } : {}), ...(!target && typeof args.x === 'number' && typeof args.y === 'number' ? { target: [{ point: [args.x, args.y] }] } : {}) }
    case 'long_press':
      return { id, do: 'long_press', ...(target ? { target } : {}), ...(!target && typeof args.x === 'number' && typeof args.y === 'number' ? { target: [{ point: [args.x, args.y] }] } : {}), with: withoutUndefined(withArgs) }
    case 'input_text':
      return { id, do: 'input_text', with: { text: String(args.text ?? '') } }
    case 'key_event':
      return { id, do: 'key', with: withoutUndefined({ key: args.keycode }) }
    case 'swipe':
      return {
        id,
        do: 'swipe',
        with: withoutUndefined({
          from: [args.x1, args.y1],
          to: [args.x2, args.y2],
          duration_ms: args.duration_ms,
        }),
      }
    case 'app_start':
      return { id, do: 'app_start', with: parameterizeObject({ restart: true, ...withArgs }, values) }
    case 'app_stop':
      return { id, do: 'app_stop', with: parameterizeObject(withArgs, values) }
    case 'open_url':
      return { id, do: 'open_url', with: parameterizeObject(withArgs, values) }
    case 'shell_exec':
      return { id, do: 'shell', with: parameterizeObject(withArgs, values) }
    case 'ui_wait_for':
      return { id, do: 'wait_for', ...(target ? { target } : { target: [selectorFromArgs(args)] }) }
    case 'sleep':
      return { id, do: 'sleep', with: parameterizeObject(withArgs, values) }
    default:
      warnings.push(`Skipped unsupported action tool: ${call.tool}`)
      return undefined
  }
}

function targetsFor(target: TraceTarget, snapshots: TraceSnapshots | undefined, snapshotId: string | undefined, values: Record<string, unknown>, warnings: string[]): Target[] {
  const result: Target[] = []
  const snapshot = snapshotId ? getSnapshot(snapshots, snapshotId) : undefined
  const fields: Array<keyof Pick<TraceTarget, 'resourceId' | 'contentDesc' | 'text' | 'className'>> = ['resourceId', 'contentDesc', 'text', 'className']
  const fieldNames: Record<string, keyof Selector> = { resourceId: 'resource_id', contentDesc: 'content_desc', text: 'text', className: 'class_name' }
  for (const field of fields) {
    const value = target[field]
    if (!value)
      continue
    const selector = { [fieldNames[field]]: parameterize(value, values), ...(field === 'text' || field === 'contentDesc' ? { exact: true } : {}) } as Selector
    const originalSelector = { [fieldNames[field]]: value, ...(field === 'text' || field === 'contentDesc' ? { exact: true } : {}) } as Selector
    const matches = snapshot ? findAll(snapshot.tree, originalSelector) : []
    const parameterized = parameterize(value, values)
    const dynamicText = field === 'text' && /\d/.test(value) && parameterized === value
    if (!snapshot || matches.length === 1) {
      if (!dynamicText && (field !== 'resourceId' || !looksObfuscatedResourceId(value)))
        result.push(selector)
    }
    else if (!dynamicText && (field === 'text' || field === 'contentDesc')) {
      const index = targetIndex(matches, target)
      if (index >= 0)
        result.push({ ...selector, index })
    }
  }
  if (target.crop || target.image)
    result.push({ image: target.image ?? target.crop!, threshold: 0.85 })
  if (target.ratio)
    result.push({ point: [target.ratio.x, target.ratio.y] })
  else if (target.point && snapshot?.tree.size.width && snapshot.tree.size.height)
    result.push({ point: [round(target.point.x / snapshot.tree.size.width), round(target.point.y / snapshot.tree.size.height)] })
  else if (target.point)
    warnings.push('Trace target has pixel point but no snapshot size; point fallback was omitted')
  if (!result.length)
    warnings.push('Trace action has no usable target')
  return deduplicateTargets(result)
}

function targetIndex(matches: UiNode[], target: TraceTarget): number {
  const bounds = target.bounds
  if (!bounds)
    return -1
  return matches.findIndex(node => node.bounds.left === bounds[0] && node.bounds.top === bounds[1] && node.bounds.right === bounds[2] && node.bounds.bottom === bounds[3])
}

function lastVisibleSelector(call: TraceCallEvent | undefined, snapshots: TraceSnapshots | undefined, calls: TraceCallEvent[]): Target | undefined {
  const snapshotId = call?.snapshotRef ?? calls.find(event => event.seq > (call?.seq ?? -1) && event.kind === 'observe' && event.ok)?.snapshotRef
  const snapshot = snapshotId ? getSnapshot(snapshots, snapshotId) : undefined
  const node = snapshot?.tree.nodes.find(node => node.contentDesc || node.text || node.resourceId)
  if (!node)
    return undefined
  if (node.resourceId && !looksObfuscatedResourceId(node.resourceId))
    return { resource_id: node.resourceId }
  if (node.contentDesc)
    return { content_desc: node.contentDesc, exact: true }
  if (node.text)
    return { text: node.text, exact: true }
  return undefined
}

function getSnapshot(snapshots: TraceSnapshots | undefined, id: string): Snapshot | undefined {
  return snapshots instanceof Map ? snapshots.get(id) : snapshots?.[id]
}

function looksObfuscatedResourceId(value: string): boolean {
  const [namespace, suffix = ''] = value.split(':')
  if (namespace === 'android' || namespace.endsWith('.android') || namespace === 'com.android.systemui')
    return false
  return /\d/.test(suffix.split('/').at(-1) ?? suffix) && /^[a-z\d]{2,8}$/i.test(suffix.split('/').at(-1) ?? suffix) && !suffix.includes('_') && !suffix.includes('-')
}

function parameterize(value: string, values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, candidate]) =>
      ['string', 'number', 'boolean'].includes(typeof candidate)
      && !(typeof candidate === 'string' && candidate.length === 0),
    )
    .sort((a, b) => String(b[1]).length - String(a[1]).length)
    .reduce((current, [key, candidate]) => current.split(String(candidate)).join(`{{${key}}}`), value)
}

function parameterizeObject(value: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' ? parameterize(item, vars) : item]))
}

function selectorFromArgs(args: Record<string, unknown>): Selector {
  return Object.fromEntries(['resource_id', 'text', 'content_desc', 'class_name', 'exact', 'index'].flatMap(key => args[key] === undefined ? [] : [[key, args[key]]])) as Selector
}

function mergeInputText(steps: FlowStep[], vars: Record<string, unknown>): FlowStep[] {
  const result: FlowStep[] = []
  for (const step of steps) {
    const previous = result.at(-1)
    if (previous?.do === 'input_text' && step.do === 'input_text') {
      const a = String(previous.with?.text ?? '')
      const b = String(step.with?.text ?? '')
      const settle = step.settle ?? previous.settle
      result[result.length - 1] = { ...previous, with: { ...previous.with, text: `${a}${b}` }, intent: previous.intent ?? step.intent, ...(settle === undefined ? {} : { settle }) }
    }
    else {
      result.push({ ...step, target: step.target?.map(target => mapTarget(target, vars)) })
    }
  }
  return result.map(step => step.do === 'input_text'
    ? { ...step, with: { ...step.with, text: parameterize(String(step.with?.text ?? ''), vars) } }
    : step)
}

function mapTarget(target: Target, vars: Record<string, unknown>): Target {
  if ('point' in target || 'image' in target)
    return target
  return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, typeof value === 'string' ? parameterize(value, vars) : value])) as Selector
}

function deduplicateTargets(targets: Target[]): Target[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = JSON.stringify(target)
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}
