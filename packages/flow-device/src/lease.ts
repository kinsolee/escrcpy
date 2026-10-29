import { mkdir, open, readdir, unlink, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { sleep } from './queue.js'

/** Who holds a device and since when. This is the on-disk content of a lock file. */
export interface LeaseInfo {
  serial: string
  holder: string
  pid: number
  acquiredAt: number
}

/** Thrown by `acquire` while another live holder owns the device; `lease` describes that holder. */
export class LeaseBusyError extends Error {
  constructor(
    message: string,
    readonly lease: LeaseInfo,
  ) {
    super(message)
    this.name = 'LeaseBusyError'
  }
}

export interface DeviceLeaseOptions {
  /** Directory holding `<serial>.lock` files. Default `FLOW_LEASE_DIR` or `~/.escrcpy/flow/leases`. */
  dir?: string
  /** Holder recorded in new leases. Default `FLOW_AGENT_NAME` or `pid:<process.pid>`. */
  holder?: string
  /** A lock that has not been refreshed for this long is stale. Default 120 s. */
  staleMs?: number
}

export interface AcquireOptions {
  /** Holder for this lease only, overriding the lease default. */
  holder?: string
  /** Keep retrying a busy lock this long instead of failing fast. Default 0. */
  waitMs?: number
}

export interface DeviceLease {
  /** Take the lock. Rejects with `LeaseBusyError` while a live holder owns it. */
  acquire(serial: string, options?: AcquireOptions): Promise<LeaseInfo>
  /** Remove the lock; false when there was nothing to remove. */
  release(serial: string): Promise<boolean>
  /** Touch the lock file so other processes do not treat it as stale. */
  refresh(serial: string): Promise<void>
  /** The current lease, or undefined when the device is not locked or the lock is stale. */
  info(serial: string): Promise<LeaseInfo | undefined>
  /** Every live lease in the directory; stale locks are cleaned up and skipped. */
  list(): Promise<LeaseInfo[]>
}

const DEFAULT_STALE_MS = 120_000
/** How often acquire(waitMs) rechecks a busy lock. */
const POLL_MS = 100

function lockFile(dir: string, serial: string): string {
  if (!serial || serial.includes('/') || serial.includes('\\') || serial === '.' || serial === '..')
    throw new Error(`Invalid device serial: ${JSON.stringify(serial)}`)
  return path.join(dir, `${serial}.lock`)
}

/** A holder is alive unless signal 0 reports the pid gone; EPERM still means the process exists. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException
    return code !== 'ESRCH' && code !== 'EINVAL'
  }
}

function parseLease(content: string): LeaseInfo | undefined {
  try {
    const lease = JSON.parse(content) as Partial<LeaseInfo>
    if (typeof lease.serial !== 'string' || typeof lease.holder !== 'string' || typeof lease.pid !== 'number' || typeof lease.acquiredAt !== 'number')
      return undefined
    return lease as LeaseInfo
  }
  catch {
    return undefined
  }
}

export function createDeviceLease(options: DeviceLeaseOptions = {}): DeviceLease {
  const dir = options.dir ?? process.env.FLOW_LEASE_DIR ?? path.join(homedir(), '.escrcpy', 'flow', 'leases')
  const holder = options.holder ?? process.env.FLOW_AGENT_NAME ?? `pid:${process.pid}`
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS

  /** Read a lock and its mtime through one handle; undefined when the file is gone. */
  async function readLock(serial: string): Promise<{ lease?: LeaseInfo, mtimeMs: number } | undefined> {
    let handle: FileHandle
    try {
      handle = await open(lockFile(dir, serial), 'r')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return undefined
      throw error
    }
    try {
      const [content, stats] = await Promise.all([handle.readFile('utf8'), handle.stat()])
      return { lease: parseLease(content), mtimeMs: stats.mtimeMs }
    }
    finally {
      await handle.close()
    }
  }

  async function acquire(serial: string, opts: AcquireOptions = {}): Promise<LeaseInfo> {
    const deadline = opts.waitMs && opts.waitMs > 0 ? Date.now() + opts.waitMs : 0
    await mkdir(dir, { recursive: true })
    for (;;) {
      const lease: LeaseInfo = { serial, holder: opts.holder ?? holder, pid: process.pid, acquiredAt: Date.now() }
      let created: FileHandle | undefined
      try {
        created = await open(lockFile(dir, serial), 'wx')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw error
      }
      if (created) {
        try {
          await created.writeFile(JSON.stringify(lease))
        }
        finally {
          await created.close()
        }
        return lease
      }
      // Somebody owns the lock; take it over only when it is gone or stale.
      const current = await readLock(serial)
      if (!current || !current.lease || Date.now() - current.mtimeMs > staleMs || !isPidAlive(current.lease.pid)) {
        try {
          await unlink(lockFile(dir, serial))
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error
        }
        continue
      }
      const busy = new LeaseBusyError(`Device ${serial} is leased by ${current.lease.holder} (pid ${current.lease.pid})`, current.lease)
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw busy
      await sleep(Math.min(POLL_MS, remaining))
    }
  }

  async function release(serial: string): Promise<boolean> {
    try {
      await unlink(lockFile(dir, serial))
      return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return false
      throw error
    }
  }

  async function refresh(serial: string): Promise<void> {
    const now = new Date()
    try {
      await utimes(lockFile(dir, serial), now, now)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`Device ${serial} is not leased`)
      throw error
    }
  }

  async function info(serial: string): Promise<LeaseInfo | undefined> {
    const lock = await readLock(serial)
    if (!lock?.lease)
      return undefined
    // A stale lock is as good as none: clean it up so the next acquire wins.
    if (Date.now() - lock.mtimeMs > staleMs || !isPidAlive(lock.lease.pid)) {
      await removeLock(serial)
      return undefined
    }
    return lock.lease
  }

  async function removeLock(serial: string): Promise<void> {
    try {
      await unlink(lockFile(dir, serial))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }

  async function list(): Promise<LeaseInfo[]> {
    let names: string[]
    try {
      names = await readdir(dir)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw error
    }
    const leases: LeaseInfo[] = []
    for (const name of names) {
      if (!name.endsWith('.lock'))
        continue
      const lease = await info(name.slice(0, -'.lock'.length))
      if (lease)
        leases.push(lease)
    }
    return leases
  }

  return { acquire, release, refresh, info, list }
}
