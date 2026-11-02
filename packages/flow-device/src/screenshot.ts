import { Buffer } from 'node:buffer'
import { deflateSync, inflateSync } from 'node:zlib'
import type { Bounds } from './geometry.js'

type SharpModule = typeof import('sharp')

/** Thrown when the native sharp module cannot be loaded in this environment. */
export class SharpUnavailableError extends Error {}

export type SharpLoader = () => Promise<SharpModule>

/**
 * Wraps a sharp importer so it is tried once per process and a failure sticks.
 *
 * sharp ships platform-native binaries, which a self-contained bundle (the
 * standalone flow-mcp agent.mjs) cannot carry. In that bundle sharp's JS is
 * inlined as a lazily-evaluated CommonJS closure that caches its (partial)
 * `module.exports` *before* the body runs, so a second import after a failed
 * first one "succeeds" with an empty object and the next `sharp(png)` call
 * throws "(intermediate value) is not a function". Remembering the first
 * failure and rejecting anything that is not callable avoids that trap.
 */
export function createSharpLoader(importer: () => Promise<unknown>): SharpLoader {
  let loaded: SharpModule | undefined
  let failure: SharpUnavailableError | undefined
  return async () => {
    if (loaded)
      return loaded
    if (failure)
      throw failure
    try {
      const imported = await importer() as { default?: unknown }
      const candidate = (imported && typeof imported === 'object' && 'default' in imported ? imported.default : imported) as unknown
      if (typeof candidate !== 'function')
        throw new Error('sharp did not export a function')
      loaded = candidate as SharpModule
      return loaded
    }
    catch (error) {
      failure = new SharpUnavailableError(`sharp native module is unavailable in this environment: ${String((error as Error)?.message ?? error).split('\n')[0]}`)
      throw failure
    }
  }
}

/** Width/height from the PNG IHDR header; adb screencaps are always standard PNGs. */
function pngSize(png: Buffer): { width: number, height: number } {
  try {
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }
  catch {
    return { width: 0, height: 0 }
  }
}

export interface EncodeOptions {
  /** Longest edge of the output in pixels; larger images are scaled down. Default 2560. */
  maxEdge?: number
  format?: 'jpeg' | 'png'
  /** JPEG quality 1~100. Default 80. */
  quality?: number
}

export interface EncodedImage {
  data: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** Size of the raw capture, i.e. the device screen in its current orientation. */
  sourceWidth: number
  sourceHeight: number
}

/** Decoded 8-bit RGB pixels (3 bytes per pixel, row-major). */
export interface RgbImage {
  width: number
  height: number
  data: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/**
 * Minimal PNG decoder for the sharp-less path: 8-bit, non-interlaced
 * grayscale / RGB / gray+alpha / RGBA, which covers every `screencap` output.
 * Returns undefined for anything else so callers can pass the bytes through.
 */
export function decodePng(png: Buffer): RgbImage | undefined {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE))
    return undefined
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const color = body[9]
      const interlace = body[12]
      channels = CHANNELS[color] ?? 0
      if (depth !== 8 || !channels || interlace !== 0)
        return undefined
    }
    else if (type === 'IDAT') {
      idat.push(body)
    }
    else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!width || !height || !channels || !idat.length)
    return undefined
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  }
  catch {
    return undefined
  }
  const stride = width * channels
  if (raw.length < (stride + 1) * height)
    return undefined
  const current = new Uint8Array(stride)
  const previous = new Uint8Array(stride)
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0
      const up = previous[i]
      const upLeft = i >= channels ? previous[i - channels] : 0
      let value = row[i]
      switch (filter) {
        case 1: value += left
          break
        case 2: value += up
          break
        case 3: value += (left + up) >> 1
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          break
        }
      }
      current[i] = value & 0xFF
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels
      const target = (y * width + x) * 3
      if (channels <= 2) {
        rgb[target] = rgb[target + 1] = rgb[target + 2] = current[source]
      }
      else {
        rgb[target] = current[source]
        rgb[target + 1] = current[source + 1]
        rgb[target + 2] = current[source + 2]
      }
    }
    previous.set(current)
  }
  return { width, height, data: rgb }
}

/** Area-average downscale; good enough for UI screenshots and cheap in pure JS. */
export function downscaleRgb(image: RgbImage, width: number, height: number): RgbImage {
  if (width >= image.width && height >= image.height)
    return image
  const out = new Uint8Array(width * height * 3)
  const scaleX = image.width / width
  const scaleY = image.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * scaleY)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * scaleX)))
      let r = 0
      let g = 0
      let b = 0
      for (let sy = y0; sy < y1; sy++) {
        let index = (sy * image.width + x0) * 3
        for (let sx = x0; sx < x1; sx++) {
          r += image.data[index]
          g += image.data[index + 1]
          b += image.data[index + 2]
          index += 3
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      const target = (y * width + x) * 3
      out[target] = Math.round(r / count)
      out[target + 1] = Math.round(g / count)
      out[target + 2] = Math.round(b / count)
    }
  }
  return { width, height, data: out }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of data)
    crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** Encodes RGB pixels as a PNG with the Sub filter on every row (compresses UI screens well). */
export function encodePng(image: RgbImage): Buffer {
  const stride = image.width * 3
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 1
    const source = y * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? image.data[source + i - 3] : 0
      raw[rowStart + 1 + i] = (image.data[source + i] - left) & 0xFF
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function fitInside(width: number, height: number, maxEdge: number): { width: number, height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Without sharp: decode, downscale and re-encode as PNG in pure JS; undecodable input passes through. */
function encodeWithoutSharp(png: Buffer, maxEdge: number): EncodedImage {
  const size = pngSize(png)
  const decoded = decodePng(png)
  if (!decoded)
    return { data: png, mimeType: 'image/png', width: size.width, height: size.height, sourceWidth: size.width, sourceHeight: size.height }
  const target = fitInside(decoded.width, decoded.height, maxEdge)
  if (target.width === decoded.width && target.height === decoded.height)
    return { data: png, mimeType: 'image/png', width: decoded.width, height: decoded.height, sourceWidth: decoded.width, sourceHeight: decoded.height }
  const scaled = downscaleRgb(decoded, target.width, target.height)
  return { data: encodePng(scaled), mimeType: 'image/png', width: scaled.width, height: scaled.height, sourceWidth: decoded.width, sourceHeight: decoded.height }
}

/** Fingerprint size: small enough to be cheap, large enough to notice a tapped button changing. */
export const FINGERPRINT_SIZE = { width: 36, height: 64 } as const

/** A tiny grayscale thumbnail used to tell whether the screen changed between two steps. */
export interface ScreenFingerprint {
  width: number
  height: number
  data: Uint8Array
}

/** Mean absolute difference of two fingerprints, 0 (identical) ~ 255. Different shapes count as fully different. */
export function fingerprintDistance(a: ScreenFingerprint, b: ScreenFingerprint): number {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length)
    return 255
  let total = 0
  for (let i = 0; i < a.data.length; i++)
    total += Math.abs(a.data[i] - b.data[i])
  return total / a.data.length
}

export interface ScreenshotEncoder {
  encodeScreenshot: (png: Buffer, options?: EncodeOptions) => Promise<EncodedImage>
  cropImage: (png: Buffer, bounds: Bounds) => Promise<Buffer>
  fingerprint: (png: Buffer) => Promise<ScreenFingerprint | undefined>
}

/** Image helpers bound to one sharp loader; tests inject a failing or broken loader. */
export function createScreenshotEncoder(loadSharp: SharpLoader): ScreenshotEncoder {
  async function optionalSharp(): Promise<SharpModule | undefined> {
    try {
      return await loadSharp()
    }
    catch (error) {
      if (error instanceof SharpUnavailableError)
        return undefined
      throw error
    }
  }

  return {
    async encodeScreenshot(png, options = {}) {
      const { maxEdge = 2560, format = 'jpeg', quality = 80 } = options
      const sharp = await optionalSharp()
      // Without sharp, scale in pure JS and hand back a PNG rather than failing the screenshot.
      if (!sharp)
        return encodeWithoutSharp(png, maxEdge)
      const image = sharp(png)
      const meta = await image.metadata()
      if (!meta.width || !meta.height)
        throw new Error('Screenshot is not a valid image')
      let pipeline = image.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      pipeline = format === 'png' ? pipeline.png() : pipeline.jpeg({ quality })
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
      return {
        data,
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
        width: info.width,
        height: info.height,
        sourceWidth: meta.width,
        sourceHeight: meta.height,
      }
    },

    async cropImage(png, bounds) {
      const sharp = await loadSharp()
      const meta = await sharp(png).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      const left = Math.max(0, Math.min(bounds.left, width))
      const top = Math.max(0, Math.min(bounds.top, height))
      const right = Math.max(left, Math.min(bounds.right, width))
      const bottom = Math.max(top, Math.min(bounds.bottom, height))
      if (right - left < 1 || bottom - top < 1)
        throw new RangeError('Crop area is outside the image')
      return sharp(png).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
    },

    async fingerprint(png) {
      const { width, height } = FINGERPRINT_SIZE
      const sharp = await optionalSharp()
      if (sharp) {
        const data = await sharp(png).resize(width, height, { fit: 'fill' }).grayscale().raw().toBuffer()
        return { width, height, data: new Uint8Array(data) }
      }
      const decoded = decodePng(png)
      if (!decoded)
        return undefined
      const scaled = downscaleRgb(decoded, width, height)
      const gray = new Uint8Array(width * height)
      for (let i = 0; i < gray.length; i++)
        gray[i] = Math.round(0.299 * scaled.data[i * 3] + 0.587 * scaled.data[i * 3 + 1] + 0.114 * scaled.data[i * 3 + 2])
      return { width, height, data: gray }
    },
  }
}

const defaultEncoder = createScreenshotEncoder(createSharpLoader(() => import('sharp')))

/** Scale and re-encode a raw screencap PNG. Without sharp the result is a pure-JS downscaled PNG. */
export const encodeScreenshot = defaultEncoder.encodeScreenshot

/** Cut an element out of a screenshot, e.g. to keep a template image for a recorded tap. Needs sharp. */
export const cropImage = defaultEncoder.cropImage

/** Grayscale thumbnail of a raw screencap for change detection; undefined when it cannot be decoded. */
export const screenFingerprint = defaultEncoder.fingerprint
