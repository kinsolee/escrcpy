import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceLease, LeaseBusyError } from '../src/lease.js'

/** A pid no live process can have, so `process.kill(pid, 0)` reports ESRCH. */
const DEAD_PID = 2_000_000_000

/** Await a busy acquire and hand back the error for inspection. */
function expectBusy(promise: Promise<unknown>): Promise<LeaseBusyError> {
  return promise.then(
    () => {
      throw new Error('expected the lease to be busy')
    },
    error => error as LeaseBusyError,
  )
}

describe('deviceLease', () => {
  let dir: string
  const envKeys = ['FLOW_LEASE_DIR', 'FLOW_AGENT_NAME'] as const
  let savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>>

  beforeEach(async () => {
    savedEnv = {}
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    dir = await mkdtemp(path.join(tmpdir(), 'flow-lease-'))
  })

  afterEach(async () => {
    for (const key of envKeys) {
      const value = savedEnv[key]
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  const lockPath = (serial: string) => path.join(dir, `${serial}.lock`)

  /** Fake an untouched lock by moving its mtime into the past. */
  const ageLock = (serial: string, ageMs: number) => {
    const at = new Date(Date.now() - ageMs)
    return utimes(lockPath(serial), at, at)
  }

  it('acquires, reports and releases a lease', async () => {
    const lease = createDeviceLease({ dir })
    const info = await lease.acquire('emulator-5554')
    expect(info).toMatchObject({ serial: 'emulator-5554', holder: `pid:${process.pid}`, pid: process.pid })
    expect(info.acquiredAt).toBeLessThanOrEqual(Date.now())
    expect(JSON.parse(await readFile(lockPath('emulator-5554'), 'utf8'))).toEqual(info)
    expect(await lease.info('emulator-5554')).toEqual(info)
    expect(await lease.info('unknown')).toBeUndefined()
    expect(await lease.release('emulator-5554')).toBe(true)
    expect(await lease.info('emulator-5554')).toBeUndefined()
    expect(await lease.release('emulator-5554')).toBe(false)
    // The device is acquirable again after release.
    expect((await lease.acquire('emulator-5554')).holder).toBe(`pid:${process.pid}`)
  })

  it('rejects a second acquire with LeaseBusyError carrying the current lease', async () => {
    const owner = createDeviceLease({ dir })
    const info = await owner.acquire('A', { holder: 'owner' })
    const rival = createDeviceLease({ dir, holder: 'rival' })
    const error = await expectBusy(rival.acquire('A'))
    expect(error).toBeInstanceOf(LeaseBusyError)
    expect(error.lease).toEqual(info)
    expect(error.message).toContain('owner')
  })

  it('honours a per-acquire holder over the lease default', async () => {
    const lease = createDeviceLease({ dir, holder: 'default-holder' })
    expect((await lease.acquire('A', { holder: 'recorder' })).holder).toBe('recorder')
    expect((await lease.acquire('B')).holder).toBe('default-holder')
  })

  it('takes over a lock that has not been refreshed within staleMs', async () => {
    const staleWorker = createDeviceLease({ dir })
    await staleWorker.acquire('A', { holder: 'stale-worker' })
    await ageLock('A', 130_000) // past the 120 s default
    const lease = createDeviceLease({ dir })
    const info = await lease.acquire('A', { holder: 'fresh-worker' })
    expect(info).toMatchObject({ serial: 'A', holder: 'fresh-worker' })
    expect((await lease.info('A'))!.holder).toBe('fresh-worker')
  })

  it('takes over a fresh lock whose holder pid is dead', async () => {
    const ghost = { serial: 'A', holder: 'ghost', pid: DEAD_PID, acquiredAt: Date.now() }
    await writeFile(lockPath('A'), JSON.stringify(ghost))
    const lease = createDeviceLease({ dir })
    expect(await lease.acquire('A')).toMatchObject({ serial: 'A', holder: `pid:${process.pid}` })
  })

  it('takes over an unreadable lock file', async () => {
    await writeFile(lockPath('A'), 'not json')
    const lease = createDeviceLease({ dir })
    expect(await lease.acquire('A')).toMatchObject({ serial: 'A' })
  })

  it('refresh keeps a live lease from going stale', async () => {
    const holder = createDeviceLease({ dir })
    await holder.acquire('A', { holder: 'heartbeat' })
    await ageLock('A', 130_000)
    await holder.refresh('A')
    const rival = createDeviceLease({ dir })
    const error = await expectBusy(rival.acquire('A'))
    expect(error).toBeInstanceOf(LeaseBusyError)
    expect(error.lease.holder).toBe('heartbeat')
    await expect(holder.refresh('B')).rejects.toThrow(/not leased/)
  })

  it('waits for a busy lock within waitMs and gives up after', async () => {
    const owner = createDeviceLease({ dir })
    await owner.acquire('A', { holder: 'owner' })
    const waiter = createDeviceLease({ dir, holder: 'waiter' })
    const start = Date.now()
    await expect(waiter.acquire('A', { waitMs: 60 })).rejects.toBeInstanceOf(LeaseBusyError)
    expect(Date.now() - start).toBeGreaterThanOrEqual(50)

    const timer = setTimeout(() => void owner.release('A'), 80)
    const info = await waiter.acquire('A', { waitMs: 2_000 })
    clearTimeout(timer)
    expect(info.holder).toBe('waiter')
  })

  it('lists leases across serials', async () => {
    const lease = createDeviceLease({ dir, holder: 'lister' })
    expect(await lease.list()).toEqual([])
    await lease.acquire('A')
    await lease.acquire('B')
    const all = await lease.list()
    expect(all.map(entry => entry.serial).sort()).toEqual(['A', 'B'])
    expect(all.every(entry => entry.holder === 'lister')).toBe(true)
    await lease.release('A')
    expect((await lease.list()).map(entry => entry.serial)).toEqual(['B'])
  })

  it('reports stale locks as free and cleans them up in info/list', async () => {
    const lease = createDeviceLease({ dir, holder: 'owner' })
    await lease.acquire('A')
    await lease.acquire('B')
    // Backdate A far past staleMs; both info and list must treat it as gone.
    const old = new Date(Date.now() - 600_000)
    await utimes(path.join(dir, 'A.lock'), old, old)
    expect(await lease.info('A')).toBeUndefined()
    expect((await lease.list()).map(entry => entry.serial)).toEqual(['B'])
    // The stale lock file was removed, so the next acquire wins immediately.
    expect(await lease.acquire('A', { holder: 'taker' })).toMatchObject({ holder: 'taker' })
  })

  it('treats a dead holder pid as stale in info', async () => {
    const lease = createDeviceLease({ dir, holder: 'owner' })
    await lease.acquire('A')
    const file = path.join(dir, 'A.lock')
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...parsed, pid: DEAD_PID }))
    expect(await lease.info('A')).toBeUndefined()
    expect(await lease.acquire('A', { holder: 'taker' })).toMatchObject({ holder: 'taker' })
  })

  it('picks up FLOW_LEASE_DIR and FLOW_AGENT_NAME defaults', async () => {
    process.env.FLOW_LEASE_DIR = dir
    process.env.FLOW_AGENT_NAME = 'env-agent'
    const lease = createDeviceLease()
    const info = await lease.acquire('env-serial')
    expect(info.holder).toBe('env-agent')
    expect(JSON.parse(await readFile(lockPath('env-serial'), 'utf8'))).toEqual(info)
  })
})
