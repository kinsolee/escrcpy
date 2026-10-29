import { Buffer } from 'node:buffer'
import type { Adbx } from '@escrcpy/adbx'
import type { UiElement } from './elements.js'
import { extractElements } from './elements.js'
import type { Point, Size } from './geometry.js'
import { pixelToRatio, ratioToPixel, tapPoint } from './geometry.js'
import { resolveKeyCode } from './keycodes.js'
import { KeyedQueue, sleep, withTimeout } from './queue.js'
import type { EncodedImage, EncodeOptions } from './screenshot.js'
import { encodeScreenshot } from './screenshot.js'
import type { FindResult, Selector } from './selector.js'
import { describeSelector, findAll, findOne } from './selector.js'
import type { ForegroundApp, Snapshot, SnapshotStoreOptions } from './snapshot.js'
import { SnapshotStore } from './snapshot.js'
import type { UiNode } from './ui-tree.js'
import { parseUiTree } from './ui-tree.js'

/** The part of adbx this layer needs. Tests pass a fake with the same shape. */
export type DeviceBackend = Pick<Adbx, 'shell' | 'screencap' | 'input' | 'ui' | 'deviceInfo'>

export type FlowDeviceErrorCode = 'NOT_FOUND' | 'DUMP_FAILED' | 'SNAPSHOT_EXPIRED' | 'INVALID_ARGUMENT'

export class FlowDeviceError extends Error {
  constructor(
    readonly code: FlowDeviceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'FlowDeviceError'
  }
}

/** A 0~1 ratio point; anything else passed as a target is a selector. */
export interface RatioPoint {
  x: number
  y: number
}

export type Target = Selector | RatioPoint

/** Which UI snapshot an action resolves its selector against. */
export type SnapshotRef = 'latest' | 'fresh' | (string & {})

export interface FlowDeviceOptions {
  adbx: DeviceBackend
  snapshots?: SnapshotStore | SnapshotStoreOptions
  /** Attempts per UI dump. Default 3. */
  dumpRetries?: number
  /** Timeout of one dump attempt. Default 15 s. */
  dumpTimeoutMs?: number
  /** Timeout of one input command. Default 15 s. */
  inputTimeoutMs?: number
  /** Dumps larger than this are rejected. Default 5 MB. */
  maxXmlBytes?: number
}

export interface ResolvedTarget {
  /** Device pixels the gesture is sent to. */
  point: Point
  /** The same point as a 0~1 ratio of the screen. */
  ratio: Point
  size: Size
  /** Present when the target was a selector. */
  node?: UiNode
  matchCount?: number
  snapshotId?: string
}

export interface WaitResult {
  found: boolean
  snapshot: Snapshot
  match?: FindResult
  attempts: number
  elapsedMs: number
}

export function isRatioPoint(target: Target): target is RatioPoint {
  return typeof (target as RatioPoint).x === 'number' && typeof (target as RatioPoint).y === 'number'
}

const RESUMED_RE = /(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{[^}]*?\s([\w.]+)\/([\w.$]+)/

/** Parse the resumed activity out of `dumpsys activity activities`. */
export function parseForegroundApp(output: string): ForegroundApp | undefined {
  const match = output.match(RESUMED_RE)
  if (!match)
    return undefined
  const [, pkg, activity] = match
  return { package: pkg, activity: activity.startsWith('.') ? pkg + activity : activity }
}

const MAX_HINT_ELEMENTS = 15

function hintLabel(element: UiElement): string {
  const label = element.text || element.contentDesc || element.resourceId
  return `${element.type} "${label}"`
}

export function createFlowDevice(options: FlowDeviceOptions) {
  const { adbx } = options
  const dumpRetries = options.dumpRetries ?? 3
  const dumpTimeoutMs = options.dumpTimeoutMs ?? 15_000
  const inputTimeoutMs = options.inputTimeoutMs ?? 15_000
  const maxXmlBytes = options.maxXmlBytes ?? 5 * 1024 * 1024
  const snapshots = options.snapshots instanceof SnapshotStore
    ? options.snapshots
    : new SnapshotStore(options.snapshots)
  const queue = new KeyedQueue()
  const sizeCache = new Map<string, { size: Size, orientation: number, at: number }>()

  async function dumpXml(serial: string): Promise<string> {
    let lastError: unknown
    for (let attempt = 1; attempt <= dumpRetries; attempt++) {
      try {
        const xml = await withTimeout(adbx.ui.dumpLayout(serial), dumpTimeoutMs, 'UI dump')
        if (Buffer.byteLength(xml) > maxXmlBytes)
          throw new Error(`UI dump is larger than ${maxXmlBytes} bytes`)
        if (!xml.includes('<hierarchy'))
          throw new Error(`UI dump returned no hierarchy: ${xml.slice(0, 200)}`)
        return xml
      }
      catch (error) {
        lastError = error
        if (attempt < dumpRetries)
          await sleep(300 * attempt)
      }
    }
    throw new FlowDeviceError('DUMP_FAILED', `UI dump failed after ${dumpRetries} attempts: ${String((lastError as Error)?.message ?? lastError)}`)
  }

  async function foregroundApp(serial: string): Promise<ForegroundApp | undefined> {
    const output = await withTimeout(adbx.shell(serial, 'dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity"'), dumpTimeoutMs, 'foreground app lookup')
    return parseForegroundApp(output)
  }

  /** Dump the screen now and register a new snapshot. */
  async function snapshot(serial: string, opts: { app?: boolean } = {}): Promise<Snapshot> {
    const started = Date.now()
    const [xml, app] = await Promise.all([
      dumpXml(serial),
      opts.app === false ? undefined : foregroundApp(serial).catch(() => undefined),
    ])
    const tree = parseUiTree(xml)
    if (tree.size.width > 0 && tree.size.height > 0)
      sizeCache.set(serial, { size: tree.size, orientation: tree.rotation, at: Date.now() })
    return snapshots.add(serial, { tree, xml, app, dumpMs: Date.now() - started })
  }

  async function getSnapshot(serial: string, ref: SnapshotRef = 'latest'): Promise<Snapshot> {
    if (ref === 'fresh')
      return snapshot(serial)
    if (ref === 'latest')
      return snapshots.latest(serial) ?? snapshot(serial)
    const found = snapshots.get(ref)
    if (!found || found.serial !== serial)
      throw new FlowDeviceError('SNAPSHOT_EXPIRED', `Snapshot ${ref} is expired or was invalidated by an input action`)
    return found
  }

  /** Current screen size in device pixels, honouring rotation. */
  async function screenSize(serial: string): Promise<Size> {
    const orientation = await adbx.deviceInfo.getOrientation(serial)
    const cached = sizeCache.get(serial)
    if (cached && cached.orientation === orientation && Date.now() - cached.at < 10_000)
      return cached.size
    const latest = snapshots.latest(serial)
    if (latest && latest.tree.size.width > 0 && latest.tree.rotation === orientation) {
      sizeCache.set(serial, { size: latest.tree.size, orientation, at: Date.now() })
      return latest.tree.size
    }
    const physical = await adbx.deviceInfo.getScreenSize(serial)
    const size = orientation % 2 === 1
      ? { width: physical.height, height: physical.width }
      : physical
    sizeCache.set(serial, { size, orientation, at: Date.now() })
    return size
  }

  async function find(serial: string, selector: Selector, ref: SnapshotRef = 'latest') {
    const snap = await getSnapshot(serial, ref)
    return { snapshot: snap, matches: findAll(snap.tree, selector) }
  }

  /** Poll fresh dumps until the selector matches or the timeout passes. Not finding it is not an error. */
  async function waitFor(serial: string, selector: Selector, opts: { timeoutMs?: number, intervalMs?: number } = {}): Promise<WaitResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000
    const intervalMs = opts.intervalMs ?? 500
    const started = Date.now()
    let attempts = 0
    let lastError: unknown
    while (true) {
      attempts++
      const elapsedBeforeDump = Date.now() - started
      const remaining = Math.max(0, timeoutMs - elapsedBeforeDump)
      let snap: Snapshot | undefined
      try {
        snap = await snapshotWithTimeout(serial, remaining)
      }
      catch (error) {
        // Animated screens (video feeds) sometimes refuse a dump; keep polling until the deadline.
        lastError = error
      }
      const match = snap && findOne(snap.tree, selector)
      const elapsedMs = Date.now() - started
      if (snap && match)
        return { found: true, snapshot: snap, match, attempts, elapsedMs }
      if (elapsedMs >= timeoutMs) {
        if (!snap)
          throw lastError
        return { found: false, snapshot: snap, attempts, elapsedMs }
      }
      await sleep(Math.min(intervalMs, timeoutMs - elapsedMs))
    }
  }

  async function snapshotWithTimeout(serial: string, timeoutMs: number): Promise<Snapshot> {
    if (timeoutMs <= 0)
      return snapshot(serial)
    return withTimeout(snapshot(serial), timeoutMs, 'waitFor snapshot')
  }

  async function resolveTarget(serial: string, target: Target, ref?: SnapshotRef): Promise<ResolvedTarget> {
    if (isRatioPoint(target)) {
      const size = await screenSize(serial)
      const [point] = ratioPoints([target], size)
      return { point, ratio: pixelToRatio(point, size), size }
    }
    const snap = await getSnapshot(serial, ref)
    const match = findOne(snap.tree, target)
    if (!match) {
      const visible = extractElements(snap.tree).slice(0, MAX_HINT_ELEMENTS).map(hintLabel)
      throw new FlowDeviceError('NOT_FOUND', `No element matches ${describeSelector(target)}`, {
        selector: target,
        snapshotId: snap.id,
        visible,
      })
    }
    const size = snap.tree.size
    const point = tapPoint(match.node.bounds, size)
    return { point, ratio: pixelToRatio(point, size), size, node: match.node, matchCount: match.matchCount, snapshotId: snap.id }
  }

  /**
   * Run a gesture through the device's queue: resolve where it goes, send it,
   * then drop that device's snapshots because the screen may have changed.
   * Resolving inside the queue means a queued tap never uses a snapshot taken
   * before the previous gesture landed.
   */
  function gesture<T>(serial: string, label: string, prepare: () => Promise<T>, send: (prepared: T) => Promise<unknown>): Promise<T> {
    return queue.run(serial, async () => {
      const prepared = await prepare()
      try {
        await send(prepared)
      }
      finally {
        snapshots.invalidate(serial)
        sizeCache.delete(serial)
      }
      return prepared
    }, { ms: inputTimeoutMs, label, onTimeout: () => {
      snapshots.invalidate(serial)
      sizeCache.delete(serial)
    } })
  }

  function ratioPoints(points: RatioPoint[], size: Size): Point[] {
    try {
      return points.map(p => ratioToPixel(p, size))
    }
    catch (error) {
      throw new FlowDeviceError('INVALID_ARGUMENT', (error as Error).message)
    }
  }

  return {
    snapshots,
    dumpXml,
    snapshot,
    getSnapshot,
    elements: (snap: Snapshot) => extractElements(snap.tree),
    foregroundApp,
    screenSize,
    find,
    waitFor,
    resolveTarget,

    async tap(serial: string, target: Target, opts: { snapshot?: SnapshotRef } = {}): Promise<ResolvedTarget> {
      return gesture(serial, 'tap', () => resolveTarget(serial, target, opts.snapshot), r => adbx.input.tap(serial, r.point.x, r.point.y))
    },

    async longPress(serial: string, target: Target, opts: { snapshot?: SnapshotRef, durationMs?: number } = {}): Promise<ResolvedTarget> {
      return gesture(serial, 'long press', () => resolveTarget(serial, target, opts.snapshot), r => adbx.input.longPress(serial, r.point.x, r.point.y, opts.durationMs ?? 1000))
    },

    /** Swipe between two ratio points. */
    async swipe(serial: string, from: RatioPoint, to: RatioPoint, durationMs = 300) {
      return gesture(
        serial,
        'swipe',
        async () => {
          const size = await screenSize(serial)
          const [a, b] = ratioPoints([from, to], size)
          return { from: a, to: b, size }
        },
        r => adbx.input.swipe(serial, r.from.x, r.from.y, r.to.x, r.to.y, durationMs),
      )
    },

    /** Type into the focused field. yadb handles Unicode; plain adb only ASCII. */
    async inputText(serial: string, text: string) {
      await gesture(serial, 'input text', async () => text, value => adbx.input.text(serial, value))
    },

    async key(serial: string, key: number | string) {
      return gesture(
        serial,
        'key event',
        async () => {
          try {
            return resolveKeyCode(key)
          }
          catch (error) {
            throw new FlowDeviceError('INVALID_ARGUMENT', (error as Error).message)
          }
        },
        code => adbx.input.key(serial, code),
      )
    },

    async screenshot(serial: string, opts?: EncodeOptions): Promise<EncodedImage> {
      const png = await withTimeout(adbx.screencap(serial), inputTimeoutMs, 'screencap')
      return encodeScreenshot(png, opts)
    },

    /** Raw PNG from screencap, e.g. for cropping template images. */
    async screencap(serial: string) {
      return withTimeout(adbx.screencap(serial), inputTimeoutMs, 'screencap')
    },
  }
}

export type FlowDevice = ReturnType<typeof createFlowDevice>
