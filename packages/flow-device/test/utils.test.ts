import { describe, expect, it } from 'vitest'
import { boundsCenter, boundsContain, parseBounds, pixelToRatio, ratioToPixel, tapPoint } from '../src/geometry.js'
import { resolveKeyCode } from '../src/keycodes.js'
import { KeyedQueue, sleep, withTimeout } from '../src/queue.js'
import { SnapshotStore } from '../src/snapshot.js'
import { parseUiTree } from '../src/ui-tree.js'

describe('geometry', () => {
  const size = { width: 1080, height: 2400 }

  it('parses bounds and falls back to an empty box', () => {
    expect(parseBounds('[0,63][147,210]')).toEqual({ left: 0, top: 63, right: 147, bottom: 210 })
    expect(parseBounds('[-5,0][10,10]').left).toBe(-5)
    expect(parseBounds('garbage')).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(parseBounds(undefined)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('computes centres and half-open containment', () => {
    const b = parseBounds('[450,1380][680,1480]')
    expect(boundsCenter(b)).toEqual({ x: 565, y: 1430 })
    expect(boundsContain(b, { x: 450, y: 1380 })).toBe(true)
    expect(boundsContain(b, { x: 680, y: 1400 })).toBe(false)
  })

  it('taps the visible part of an element that runs off-screen', () => {
    expect(tapPoint(parseBounds('[0,2300][1080,2510]'), size)).toEqual({ x: 540, y: 2350 })
  })

  it('converts ratios to pixels with clamping and tolerance', () => {
    expect(ratioToPixel({ x: 0.5, y: 0.5 }, size)).toEqual({ x: 540, y: 1200 })
    expect(ratioToPixel({ x: 1, y: 1 }, size)).toEqual({ x: 1079, y: 2399 })
    expect(ratioToPixel({ x: -0.004, y: 1.004 }, size)).toEqual({ x: 0, y: 2399 })
    expect(() => ratioToPixel({ x: 1.2, y: 0 }, size)).toThrow(RangeError)
    expect(() => ratioToPixel({ x: 540, y: 1200 }, size)).toThrow(/0~1/)
    expect(() => ratioToPixel({ x: Number.NaN, y: 0 }, size)).toThrow()
  })

  it('converts pixels back to 4-decimal ratios', () => {
    expect(pixelToRatio({ x: 960, y: 136 }, size)).toEqual({ x: 0.8889, y: 0.0567 })
  })
})

describe('resolveKeyCode', () => {
  it('accepts names in any form, aliases and numbers', () => {
    expect(resolveKeyCode('HOME')).toBe(3)
    expect(resolveKeyCode('back')).toBe(4)
    expect(resolveKeyCode('KEYCODE_ENTER')).toBe(66)
    expect(resolveKeyCode('backspace')).toBe(67)
    expect(resolveKeyCode('recents')).toBe(187)
    expect(resolveKeyCode(26)).toBe(26)
    expect(resolveKeyCode(' 224 ')).toBe(224)
  })

  it('rejects unknown names and invalid numbers', () => {
    expect(() => resolveKeyCode('FLY')).toThrow(/Unknown key/)
    expect(() => resolveKeyCode(-1)).toThrow(/Invalid key/)
    expect(() => resolveKeyCode(1.5)).toThrow()
    expect(() => resolveKeyCode('9'.repeat(400))).toThrow(/Invalid key/)
  })
})

describe('snapshotStore', () => {
  const tree = parseUiTree('<hierarchy><node bounds="[0,0][10,10]"/></hierarchy>')
  const data = { tree, xml: '' }

  it('numbers snapshots and returns the latest per device', () => {
    const store = new SnapshotStore()
    const a = store.add('A', data)
    const b = store.add('A', data)
    const c = store.add('B', data)
    expect([a.id, b.id, c.id]).toEqual(['snap_1', 'snap_2', 'snap_3'])
    expect(store.latest('A')).toBe(b)
    expect(store.latest('B')).toBe(c)
    expect(store.latest('C')).toBeUndefined()
  })

  it('expires snapshots after the TTL', () => {
    let now = 1000
    const store = new SnapshotStore({ ttlMs: 60_000, now: () => now })
    const snap = store.add('A', data)
    now += 60_000
    expect(store.get(snap.id)).toBe(snap)
    now += 1
    expect(store.get(snap.id)).toBeUndefined()
    expect(store.latest('A')).toBeUndefined()
  })

  it('invalidates only the given device', () => {
    const store = new SnapshotStore()
    const a = store.add('A', data)
    const b = store.add('B', data)
    store.invalidate('A')
    expect(store.get(a.id)).toBeUndefined()
    expect(store.get(b.id)).toBe(b)
  })

  it('keeps at most maxPerDevice snapshots', () => {
    const store = new SnapshotStore({ maxPerDevice: 2 })
    const first = store.add('A', data)
    store.add('A', data)
    store.add('A', data)
    expect(store.get(first.id)).toBeUndefined()
    expect(store.latest('A')!.id).toBe('snap_3')
  })
})

describe('keyedQueue', () => {
  it('runs tasks for one key in order without overlap', async () => {
    const queue = new KeyedQueue()
    const log: string[] = []
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`)
      await sleep(ms)
      log.push(`end ${name}`)
      return name
    }
    const results = await Promise.all([queue.run('A', task('a1', 20)), queue.run('A', task('a2', 1))])
    expect(results).toEqual(['a1', 'a2'])
    expect(log).toEqual(['start a1', 'end a1', 'start a2', 'end a2'])
  })

  it('runs different keys in parallel', async () => {
    const queue = new KeyedQueue()
    const log: string[] = []
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`)
      await sleep(ms)
      log.push(`end ${name}`)
    }
    await Promise.all([queue.run('A', task('a', 20)), queue.run('B', task('b', 1))])
    expect(log).toEqual(['start a', 'start b', 'end b', 'end a'])
  })

  it('keeps going after a failed task and cleans up idle keys', async () => {
    const queue = new KeyedQueue()
    const failed = queue.run('A', async () => {
      throw new Error('boom')
    })
    const next = queue.run('A', async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    await sleep(0)
    expect(queue.size).toBe(0)
  })
})

describe('withTimeout', () => {
  it('rejects slow promises with a labelled error', async () => {
    await expect(withTimeout(sleep(50), 5, 'UI dump')).rejects.toThrow('UI dump timed out after 5 ms')
    await expect(withTimeout(Promise.resolve(1), 50, 'x')).resolves.toBe(1)
  })
})
