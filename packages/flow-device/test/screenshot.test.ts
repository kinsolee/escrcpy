import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceLease, withLease } from '../src/lease.js'
import { createScreenshotEncoder, createSharpLoader, decodePng, encodePng, fingerprintDistance, SharpUnavailableError } from '../src/screenshot.js'

/** A gradient screen with a dark "button", so downscaling and fingerprints have something to see. */
async function screen(width = 1080, height = 2400, button = true): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inButton = button && x > 200 && x < 800 && y > 1000 && y < 1300
      pixels[i] = inButton ? 10 : Math.floor((x / width) * 255)
      pixels[i + 1] = inButton ? 10 : Math.floor((y / height) * 255)
      pixels[i + 2] = 128
      pixels[i + 3] = 255
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

/**
 * The self-contained agent.mjs inlines sharp as a lazy CommonJS closure that
 * caches a half-initialised `module.exports` before its body throws. The first
 * import fails (no native binary), every later import returns `{}`.
 */
function bundledSharpImporter(): () => Promise<unknown> {
  let calls = 0
  return async () => {
    calls++
    if (calls === 1)
      throw new Error('Could not load the "sharp" module using the darwin-arm64 runtime')
    return { default: {} }
  }
}

describe('sharp loader', () => {
  it('remembers the first failure instead of returning a broken module (regression: "(intermediate value) is not a function")', async () => {
    const load = createSharpLoader(bundledSharpImporter())
    await expect(load()).rejects.toBeInstanceOf(SharpUnavailableError)
    await expect(load()).rejects.toBeInstanceOf(SharpUnavailableError)
  })

  it('rejects a module that does not export a function', async () => {
    const load = createSharpLoader(async () => ({ default: {} }))
    await expect(load()).rejects.toThrow(/did not export a function/)
  })

  it('screenshots keep working on every call when sharp is unavailable', async () => {
    const encoder = createScreenshotEncoder(createSharpLoader(bundledSharpImporter()))
    const png = await screen()
    for (let i = 0; i < 3; i++) {
      const image = await encoder.encodeScreenshot(png, { maxEdge: 1280 })
      expect(image).toMatchObject({ mimeType: 'image/png', width: 576, height: 1280, sourceWidth: 1080, sourceHeight: 2400 })
      const meta = await sharp(image.data).metadata()
      expect([meta.width, meta.height]).toEqual([576, 1280])
    }
  })
})

describe('pure-JS png', () => {
  it('round-trips pixels through decode/encode', async () => {
    const png = await screen(64, 32)
    const decoded = decodePng(png)!
    expect([decoded.width, decoded.height]).toEqual([64, 32])
    const raw = await sharp(png).removeAlpha().raw().toBuffer()
    expect(Buffer.from(decoded.data).equals(raw)).toBe(true)
    const again = decodePng(encodePng(decoded))!
    expect(Buffer.from(again.data).equals(raw)).toBe(true)
  })

  it('decodes every PNG filter type sharp emits', async () => {
    const png = await sharp(await screen(97, 41)).png({ adaptiveFiltering: true, compressionLevel: 9 }).toBuffer()
    const raw = await sharp(png).removeAlpha().raw().toBuffer()
    expect(Buffer.from(decodePng(png)!.data).equals(raw)).toBe(true)
  })

  it('passes undecodable input through untouched', async () => {
    const encoder = createScreenshotEncoder(createSharpLoader(async () => {
      throw new Error('no sharp')
    }))
    const jpeg = await sharp(await screen(10, 10)).jpeg().toBuffer()
    const image = await encoder.encodeScreenshot(jpeg)
    expect(image.data).toBe(jpeg)
  })
})

describe('screen fingerprint', () => {
  for (const [name, loader] of [
    ['sharp', createSharpLoader(() => import('sharp'))],
    ['pure JS', createSharpLoader(async () => {
      throw new Error('no sharp')
    })],
  ] as const) {
    it(`tells identical screens from changed ones (${name})`, async () => {
      const encoder = createScreenshotEncoder(loader)
      const a = (await encoder.fingerprint(await screen()))!
      const b = (await encoder.fingerprint(await screen()))!
      const c = (await encoder.fingerprint(await screen(1080, 2400, false)))!
      expect(fingerprintDistance(a, b)).toBe(0)
      expect(fingerprintDistance(a, c)).toBeGreaterThan(2)
    })
  }
})

describe('withLease', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'flow-with-lease-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('acquires and releases a free device', async () => {
    const lease = createDeviceLease({ dir })
    const seen = await withLease(lease, 'S1', { holder: 'vision' }, async (held) => {
      expect(held.reused).toBe(false)
      return (await lease.info('S1'))?.holder
    })
    expect(seen).toBe('vision')
    expect(await lease.info('S1')).toBeUndefined()
  })

  it('reuses a lease this process already holds and keeps it afterwards', async () => {
    const lease = createDeviceLease({ dir })
    await lease.acquire('S1', { holder: 'agent-claim' })
    const reused = await withLease(lease, 'S1', { holder: 'flow-run' }, async held => held.reused)
    expect(reused).toBe(true)
    expect((await lease.info('S1'))?.holder).toBe('agent-claim')
  })

  it('releases even when the run throws', async () => {
    const lease = createDeviceLease({ dir })
    await expect(withLease(lease, 'S1', {}, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await lease.info('S1')).toBeUndefined()
  })
})
