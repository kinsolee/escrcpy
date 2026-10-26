import type { UiTree } from './ui-tree.js'

export interface ForegroundApp {
  package: string
  activity: string
}

export interface Snapshot {
  /** `snap_N`, unique per store. */
  id: string
  serial: string
  createdAt: number
  tree: UiTree
  xml: string
  app?: ForegroundApp
  /** Time spent dumping, for performance reports. */
  dumpMs?: number
}

export interface SnapshotStoreOptions {
  /** How long a snapshot stays usable. Default 60 s. */
  ttlMs?: number
  /** Snapshots kept per device; older ones are dropped. Default 20. */
  maxPerDevice?: number
  now?: () => number
}

/**
 * Per-device UI snapshots. A snapshot describes the screen at one moment, so
 * any input on that device invalidates all of its snapshots.
 */
export class SnapshotStore {
  private readonly ttlMs: number
  private readonly maxPerDevice: number
  private readonly now: () => number
  private readonly byId = new Map<string, Snapshot>()
  private readonly bySerial = new Map<string, string[]>()
  private seq = 0

  constructor(options: SnapshotStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000
    this.maxPerDevice = options.maxPerDevice ?? 20
    this.now = options.now ?? Date.now
  }

  add(serial: string, data: Pick<Snapshot, 'tree' | 'xml' | 'app' | 'dumpMs'>): Snapshot {
    const snapshot: Snapshot = { id: `snap_${++this.seq}`, serial, createdAt: this.now(), ...data }
    this.byId.set(snapshot.id, snapshot)
    const ids = this.bySerial.get(serial) ?? []
    ids.push(snapshot.id)
    while (ids.length > this.maxPerDevice)
      this.byId.delete(ids.shift()!)
    this.bySerial.set(serial, ids)
    return snapshot
  }

  /** A snapshot by id, or undefined when unknown, expired or invalidated. */
  get(id: string): Snapshot | undefined {
    const snapshot = this.byId.get(id)
    if (!snapshot)
      return undefined
    if (this.now() - snapshot.createdAt > this.ttlMs) {
      this.byId.delete(id)
      return undefined
    }
    return snapshot
  }

  latest(serial: string): Snapshot | undefined {
    const ids = this.bySerial.get(serial) ?? []
    for (let i = ids.length - 1; i >= 0; i--) {
      const snapshot = this.get(ids[i])
      if (snapshot)
        return snapshot
    }
    return undefined
  }

  invalidate(serial: string): void {
    for (const id of this.bySerial.get(serial) ?? [])
      this.byId.delete(id)
    this.bySerial.delete(serial)
  }
}
