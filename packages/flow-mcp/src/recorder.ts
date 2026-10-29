import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Snapshot } from '@escrcpy/flow-device'

export interface TraceDevice {
  serial: string
  model?: string
  sdk?: number
  width?: number
  height?: number
  density?: number
}

export interface TraceSession {
  id?: string
  name: string
  task: string
  vars?: Record<string, unknown>
  device: TraceDevice
  startedAt?: number
}

export interface TraceTarget {
  text: string
  contentDesc: string
  resourceId: string
  className: string
  bounds: [number, number, number, number]
  matchCount?: number
  point?: { x: number, y: number }
  ratio?: { x: number, y: number }
}

export interface TraceCall {
  tool: string
  args: unknown
  ok: boolean
  kind: 'action' | 'observe' | 'meta'
  before?: Snapshot
  snapshot?: Snapshot
  target?: TraceTarget
  snapshotRef?: string
  durationMs: number
  intent?: string
  error?: string
}

export interface TraceRecorderOptions {
  dir: string
  now?: () => number
  id?: string
}

export interface TraceResult {
  traceId: string
  tracePath: string
  snapshotsDir: string
}

interface SessionEvent {
  type: 'session'
  id: string
  name: string
  task: string
  vars?: Record<string, unknown>
  device: TraceDevice
  startedAt: number
}

interface CallEvent {
  type: 'call'
  seq: number
  ts: number
  tool: string
  args: unknown
  ok: boolean
  kind: TraceCall['kind']
  before?: { snapshotId: string, app?: Snapshot['app'] }
  target?: TraceTarget
  snapshotRef?: string
  durationMs: number
  intent?: string
  error?: string
}

interface EndEvent {
  type: 'end'
  outcome: string
  endedAt: number
}

/** Writes a trace and its snapshots as append-only JSONL/JSON files. */
export class FlowTraceRecorder {
  private readonly now: () => number
  private readonly idOverride?: string
  private readonly dir: string
  private readonly snapshotsDir: string
  private traceId?: string
  private tracePath?: string
  private seq = 0
  private intent?: string
  private writeQueue: Promise<void> = Promise.resolve()
  private active = false

  constructor(options: TraceRecorderOptions) {
    this.dir = options.dir
    this.snapshotsDir = join(options.dir, 'snapshots')
    this.now = options.now ?? Date.now
    this.idOverride = options.id
  }

  get isActive(): boolean {
    return this.active
  }

  get result(): TraceResult | undefined {
    if (!this.traceId || !this.tracePath)
      return undefined
    return { traceId: this.traceId, tracePath: this.tracePath, snapshotsDir: this.snapshotsDir }
  }

  get currentIntent(): string | undefined {
    return this.intent
  }

  async start(session: TraceSession): Promise<TraceResult> {
    if (this.active)
      throw new Error('A flow recording is already active')
    await mkdir(this.snapshotsDir, { recursive: true })
    const traceId = session.id ?? this.idOverride ?? `tr_${this.now().toString(36)}_${randomBytes(3).toString('hex')}`
    this.traceId = traceId
    this.tracePath = join(this.dir, `${traceId}.jsonl`)
    this.seq = 0
    this.intent = undefined
    this.active = true
    const event: SessionEvent = {
      type: 'session',
      id: traceId,
      name: session.name,
      task: session.task,
      ...(session.vars === undefined ? {} : { vars: session.vars }),
      device: session.device,
      startedAt: session.startedAt ?? this.now(),
    }
    await writeFile(this.tracePath, `${JSON.stringify(event)}\n`, 'utf8')
    return this.result!
  }

  async setIntent(intent: string): Promise<void> {
    this.intent = intent
  }

  async saveSnapshot(snapshot: Snapshot): Promise<string | undefined> {
    if (!this.active)
      return undefined
    await mkdir(this.snapshotsDir, { recursive: true })
    const path = join(this.snapshotsDir, `${snapshot.id}.json`)
    await writeFile(path, JSON.stringify(snapshot), 'utf8')
    return snapshot.id
  }

  async recordCall(call: TraceCall): Promise<void> {
    if (!this.active || !this.tracePath)
      return
    if (call.before)
      await this.saveSnapshot(call.before)
    if (call.snapshot)
      await this.saveSnapshot(call.snapshot)
    const intent = call.intent ?? (call.kind === 'action' ? this.intent : undefined)
    const event: CallEvent = {
      type: 'call',
      seq: ++this.seq,
      ts: this.now(),
      tool: call.tool,
      args: call.args,
      ok: call.ok,
      kind: call.kind,
      ...(call.before ? { before: { snapshotId: call.before.id, app: call.before.app } } : {}),
      ...(call.target ? { target: call.target } : {}),
      ...(call.snapshotRef ? { snapshotRef: call.snapshotRef } : {}),
      durationMs: call.durationMs,
      ...(intent ? { intent } : {}),
      ...(call.error ? { error: call.error } : {}),
    }
    await this.append(event)
    if (call.kind === 'action' && call.ok)
      this.intent = undefined
  }

  async stop(outcome: string): Promise<TraceResult | undefined> {
    if (!this.active || !this.tracePath)
      return undefined
    await this.append({ type: 'end', outcome, endedAt: this.now() })
    await this.writeQueue
    this.active = false
    return this.result
  }

  private async append(event: CallEvent | EndEvent): Promise<void> {
    const path = this.tracePath
    if (!path)
      return
    this.writeQueue = this.writeQueue.then(() => appendFile(path, `${JSON.stringify(event)}\n`, 'utf8'))
    await this.writeQueue
  }
}
