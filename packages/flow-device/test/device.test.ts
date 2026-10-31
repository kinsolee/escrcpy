import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceBackend } from '../src/device.js'
import { createFlowDevice, FlowDeviceError, isRatioPoint, parseForegroundApp } from '../src/device.js'
import { cropImage } from '../src/screenshot.js'
import { fixture } from './helpers.js'

const SERIAL = 'emulator-5554'
const SETTINGS = fixture('settings-dialog.xml')
const LAUNCHER = fixture('launcher-uiautomator.xml')

/** Fake adbx: returns queued dumps in order (the last one repeats) and records every input. */
function fakeBackend(dumps: Array<string | Error>, extra: Partial<Record<string, unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  let i = 0
  const backend = {
    shell: vi.fn(async (_serial: string, command: string) => {
      calls.push(['shell', command])
      if (command.startsWith('dumpsys activity'))
        return '  topResumedActivity=ActivityRecord{83856826 u0 com.android.settings/.SubSettings t12}'
      return ''
    }),
    screencap: vi.fn(async () => {
      calls.push(['screencap'])
      return sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#336699' } }).png().toBuffer()
    }),
    ui: {
      dumpLayout: vi.fn(async () => {
        const next = dumps[Math.min(i++, dumps.length - 1)]
        calls.push(['dump'])
        if (next instanceof Error)
          throw next
        return next
      }),
    },
    input: {
      tap: vi.fn(async (_s: string, x: number, y: number) => void calls.push(['tap', x, y])),
      longPress: vi.fn(async (_s: string, x: number, y: number, d?: number) => void calls.push(['longPress', x, y, d])),
      swipe: vi.fn(async (_s: string, x1: number, y1: number, x2: number, y2: number, d?: number) => void calls.push(['swipe', x1, y1, x2, y2, d])),
      text: vi.fn(async (_s: string, text: string) => void calls.push(['text', text])),
      key: vi.fn(async (_s: string, code: number) => void calls.push(['key', code])),
    },
    deviceInfo: {
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 2400 })),
      getOrientation: vi.fn(async () => 0),
    },
    ...extra,
  }
  return { backend: backend as unknown as DeviceBackend, calls, raw: backend }
}

const inputs = (calls: Array<[string, ...unknown[]]>) => calls.filter(([name]) => !['dump', 'shell', 'screencap'].includes(name))

describe('snapshot', () => {
  it('dumps, parses and records the foreground app', async () => {
    const { backend } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const snap = await device.snapshot(SERIAL)
    expect(snap.id).toBe('snap_1')
    expect(snap.serial).toBe(SERIAL)
    expect(snap.tree.size).toEqual({ width: 1080, height: 2400 })
    expect(snap.app).toEqual({ package: 'com.android.settings', activity: 'com.android.settings.SubSettings' })
    expect(snap.dumpMs).toBeGreaterThanOrEqual(0)
    expect(device.elements(snap).length).toBeGreaterThan(10)
  })

  it('retries failed and empty dumps', async () => {
    const { backend, raw } = fakeBackend([new Error('adb closed'), 'ERROR: could not get idle state.', SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const snap = await device.snapshot(SERIAL, { app: false })
    expect(raw.ui.dumpLayout).toHaveBeenCalledTimes(3)
    expect(snap.app).toBeUndefined()
  })

  it('gives up after the configured attempts', async () => {
    const { backend } = fakeBackend([new Error('offline')])
    const device = createFlowDevice({ adbx: backend, dumpRetries: 2 })
    const error = await device.snapshot(SERIAL).catch(e => e)
    expect(error).toBeInstanceOf(FlowDeviceError)
    expect(error.code).toBe('DUMP_FAILED')
    expect(error.message).toMatch(/after 2 attempts: offline/)
  })

  it('rejects oversized dumps', async () => {
    const { backend } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend, dumpRetries: 1, maxXmlBytes: 100 })
    await expect(device.snapshot(SERIAL)).rejects.toThrow(/larger than 100 bytes/)
  })

  it('reuses the latest snapshot until an input invalidates it', async () => {
    const { backend, raw } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const first = await device.getSnapshot(SERIAL)
    expect(await device.getSnapshot(SERIAL)).toBe(first)
    await device.key(SERIAL, 'BACK')
    const second = await device.getSnapshot(SERIAL)
    expect(second.id).not.toBe(first.id)
    expect(raw.ui.dumpLayout).toHaveBeenCalledTimes(2)
    await expect(device.getSnapshot(SERIAL, first.id)).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' })
  })
})

describe('tap', () => {
  it('taps the centre of the element a selector picks', async () => {
    const { backend, calls } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const result = await device.tap(SERIAL, { text: '连接', exact: true })
    expect(inputs(calls)).toEqual([['tap', 815, 1430]])
    expect(result).toMatchObject({ point: { x: 815, y: 1430 }, ratio: { x: 0.7546, y: 0.5958 }, matchCount: 1, snapshotId: 'snap_1' })
    expect(result.node!.resourceId).toBe('android:id/button1')
  })

  it('reports how many elements matched and honours index', async () => {
    const { backend, calls } = fakeBackend([LAUNCHER])
    const device = createFlowDevice({ adbx: backend })
    const result = await device.tap(SERIAL, { text: '音乐', exact: true, index: 1 }, { snapshot: 'fresh' })
    expect(result.matchCount).toBe(2)
    expect(inputs(calls)).toEqual([['tap', 753, 398]])
  })

  it('throws NOT_FOUND with visible elements as hints and sends nothing', async () => {
    const { backend, calls } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const error = await device.tap(SERIAL, { text: '蓝牙' }).catch(e => e)
    expect(error).toBeInstanceOf(FlowDeviceError)
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('No element matches text="蓝牙"')
    expect(error.details.visible.length).toBeLessThanOrEqual(15)
    expect(error.details.visible).toContain('TextView "网络和互联网"')
    expect(inputs(calls)).toEqual([])
    // A failed lookup sent no input, so the snapshot is still valid.
    expect(device.snapshots.latest(SERIAL)!.id).toBe(error.details.snapshotId)
  })

  it('taps a ratio point using the current screen size', async () => {
    const { backend, calls, raw } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const result = await device.tap(SERIAL, { x: 0.5, y: 0.25 })
    expect(inputs(calls)).toEqual([['tap', 540, 600]])
    expect(result.node).toBeUndefined()
    expect(raw.ui.dumpLayout).not.toHaveBeenCalled()
  })

  it('swaps width and height in landscape when no snapshot is available', async () => {
    const { backend, calls } = fakeBackend([SETTINGS])
    ;(backend.deviceInfo.getOrientation as any) = vi.fn(async () => 1)
    const device = createFlowDevice({ adbx: backend })
    await device.tap(SERIAL, { x: 0.5, y: 0.5 })
    expect(inputs(calls)).toEqual([['tap', 1200, 540]])
  })

  it('swaps width and height after an external rotation invalidates the size cache', async () => {
    const { backend, calls, raw } = fakeBackend([SETTINGS])
    const orientation = vi.fn(async () => 0)
    ;(backend.deviceInfo.getOrientation as any) = orientation
    const device = createFlowDevice({ adbx: backend })
    await device.tap(SERIAL, { x: 0.5, y: 0.5 })
    orientation.mockResolvedValue(1)
    await device.tap(SERIAL, { x: 0.5, y: 0.5 })
    expect(inputs(calls)).toEqual([['tap', 540, 1200], ['tap', 1200, 540]])
    expect(raw.deviceInfo.getScreenSize).toHaveBeenCalledTimes(2)
  })

  it('rejects ratio points outside 0~1', async () => {
    const { backend } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    await expect(device.tap(SERIAL, { x: 540, y: 1200 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('serialises taps on one device and resolves each after the previous one landed', async () => {
    const { backend, raw } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    await Promise.all([device.tap(SERIAL, { text: '取消' }), device.tap(SERIAL, { text: '连接' })])
    // The second tap could not reuse the snapshot taken before the first tap.
    expect(raw.ui.dumpLayout).toHaveBeenCalledTimes(2)
  })
})

describe('other gestures', () => {
  it('long-presses and swipes with ratio coordinates', async () => {
    const { backend, calls } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    await device.longPress(SERIAL, { text: 'VPN' }, { durationMs: 800 })
    await device.swipe(SERIAL, { x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 250)
    expect(inputs(calls)).toEqual([
      ['longPress', 395, 1340, 800],
      ['swipe', 540, 1920, 540, 480, 250],
    ])
  })

  it('types text and sends key codes by name', async () => {
    const { backend, calls } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    await device.inputText(SERIAL, '你好 world')
    expect(await device.key(SERIAL, 'enter')).toBe(66)
    expect(inputs(calls)).toEqual([['text', '你好 world'], ['key', 66]])
    await expect(device.key(SERIAL, 'nope')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('keeps a timed out input in the device queue until its backend promise settles', async () => {
    const { backend, calls, raw } = fakeBackend([SETTINGS])
    let release!: () => void
    let first = true
    raw.input.key.mockImplementation((_serial, code) => {
      calls.push(['key', code])
      if (first) {
        first = false
        return new Promise((resolve) => {
          release = () => resolve(undefined)
        })
      }
      return Promise.resolve(undefined)
    })
    const device = createFlowDevice({ adbx: backend, inputTimeoutMs: 20 })
    const firstRequest = device.key(SERIAL, 'HOME')
    await expect(firstRequest).rejects.toThrow(/key event timed out/)
    const second = device.key(SERIAL, 'BACK')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(inputs(calls)).toEqual([['key', 3]])
    release()
    await second
    expect(inputs(calls)).toEqual([['key', 3], ['key', 4]])
  })

  it('times out a stuck input command and still invalidates snapshots', async () => {
    const { backend, raw } = fakeBackend([SETTINGS])
    raw.input.key.mockImplementation(() => new Promise(() => {}))
    const device = createFlowDevice({ adbx: backend, inputTimeoutMs: 20 })
    await device.snapshot(SERIAL)
    await expect(device.key(SERIAL, 'HOME')).rejects.toThrow(/key event timed out/)
    expect(device.snapshots.latest(SERIAL)).toBeUndefined()
  })
})

describe('waitFor', () => {
  it('polls until the element appears', async () => {
    const { backend, raw } = fakeBackend([LAUNCHER, LAUNCHER, SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const result = await device.waitFor(SERIAL, { text: '连接' }, { timeoutMs: 2000, intervalMs: 10 })
    expect(result.found).toBe(true)
    expect(result.attempts).toBe(3)
    expect(result.match!.node.text).toBe('连接')
    expect(raw.ui.dumpLayout).toHaveBeenCalledTimes(3)
  })

  it('returns found: false after the timeout instead of throwing', async () => {
    const { backend } = fakeBackend([LAUNCHER])
    const device = createFlowDevice({ adbx: backend })
    const result = await device.waitFor(SERIAL, { text: '连接' }, { timeoutMs: 50, intervalMs: 20 })
    expect(result.found).toBe(false)
    expect(result.attempts).toBeGreaterThanOrEqual(2)
    expect(result.snapshot.tree.nodes.length).toBe(49)
  })

  it('keeps polling through a failed dump and throws only if none ever succeeds', async () => {
    const flaky = fakeBackend([...Array.from({ length: 3 }, () => new Error('could not get idle state')), SETTINGS])
    const result = await createFlowDevice({ adbx: flaky.backend }).waitFor(SERIAL, { text: '连接' }, { timeoutMs: 2000, intervalMs: 10 })
    expect(result.found).toBe(true)
    expect(result.attempts).toBe(2)

    const broken = fakeBackend([new Error('could not get idle state')])
    await expect(createFlowDevice({ adbx: broken.backend }).waitFor(SERIAL, { text: 'x' }, { timeoutMs: 40, intervalMs: 10 })).rejects.toThrow(/idle state|dump|timed out/)
  })
})

describe('screenshot', () => {
  it('scales the capture down and encodes JPEG', async () => {
    const { backend } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const image = await device.screenshot(SERIAL, { maxEdge: 1200 })
    expect(image).toMatchObject({ mimeType: 'image/jpeg', width: 540, height: 1200, sourceWidth: 1080, sourceHeight: 2400 })
    expect(image.data.subarray(0, 3)).toEqual(Buffer.from([0xFF, 0xD8, 0xFF]))
  })

  it('never enlarges and can keep PNG', async () => {
    const { backend } = fakeBackend([SETTINGS])
    const device = createFlowDevice({ adbx: backend })
    const image = await device.screenshot(SERIAL, { format: 'png' })
    expect(image).toMatchObject({ mimeType: 'image/png', width: 1080, height: 2400 })
  })

  it('crops an element and clips it to the image', async () => {
    const png = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#000' } }).png().toBuffer()
    const crop = await cropImage(png, { left: 80, top: 190, right: 150, bottom: 260 })
    const meta = await sharp(crop).metadata()
    expect([meta.width, meta.height]).toEqual([20, 10])
    await expect(cropImage(png, { left: 300, top: 0, right: 400, bottom: 10 })).rejects.toThrow(/outside/)
  })
})

describe('helpers', () => {
  it('parses the resumed activity on old and new Android', () => {
    expect(parseForegroundApp('    mResumedActivity: ActivityRecord{1a2b u0 com.tencent.mm/.ui.LauncherUI t5}'))
      .toEqual({ package: 'com.tencent.mm', activity: 'com.tencent.mm.ui.LauncherUI' })
    expect(parseForegroundApp('topResumedActivity=ActivityRecord{94799a2 u0 com.example/com.example.splash.SplashActivity t758}'))
      .toEqual({ package: 'com.example', activity: 'com.example.splash.SplashActivity' })
    expect(parseForegroundApp('')).toBeUndefined()
  })

  it('parses the bare ResumedActivity spelling and prefers the specific labels', () => {
    // Screen-off devices report the line without the m/top prefix.
    expect(parseForegroundApp('  ResumedActivity: ActivityRecord{f00d u0 com.example.app/.MainActivity t42}'))
      .toEqual({ package: 'com.example.app', activity: 'com.example.app.MainActivity' })
    // Noise lines (mLastResumedActivity) must not win over the real one.
    expect(parseForegroundApp('    mLastResumedActivity: ActivityRecord{dead u0 com.old/.A t1}\n    mResumedActivity: ActivityRecord{beef u0 com.current/.B t2}'))
      .toEqual({ package: 'com.current', activity: 'com.current.B' })
    // topResumedActivity wins when both spellings appear.
    expect(parseForegroundApp('    mResumedActivity: ActivityRecord{beef u0 com.current/.B t2}\n    topResumedActivity: ActivityRecord{aaaa u0 com.top/.C t3}'))
      .toEqual({ package: 'com.top', activity: 'com.top.C' })
  })

  it('tells ratio points from selectors', () => {
    expect(isRatioPoint({ x: 0.1, y: 0.2 })).toBe(true)
    expect(isRatioPoint({ text: 'x' })).toBe(false)
  })
})
