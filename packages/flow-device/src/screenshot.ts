import type { Buffer } from 'node:buffer'
import type { Bounds } from './geometry.js'

type SharpModule = typeof import('sharp')

/** Thrown when the native sharp module cannot be loaded in this environment. */
export class SharpUnavailableError extends Error {}

// sharp ships platform-native binaries, which a self-contained bundle (the
// standalone flow-mcp agent.mjs) cannot carry. Import it lazily so every
// non-image capability keeps working without it.
let sharpModule: SharpModule | undefined
async function loadSharp(): Promise<SharpModule> {
  if (!sharpModule) {
    try {
      const imported = await import('sharp')
      sharpModule = (imported.default ?? imported) as SharpModule
    }
    catch (error) {
      throw new SharpUnavailableError(`sharp native module is unavailable in this environment: ${(error as Error).message.split('\n')[0]}`)
    }
  }
  return sharpModule
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

/** Scale and re-encode a raw screencap PNG. */
export async function encodeScreenshot(png: Buffer, options: EncodeOptions = {}): Promise<EncodedImage> {
  const { maxEdge = 2560, format = 'jpeg', quality = 80 } = options
  const size = pngSize(png)
  try {
    const sharp = await loadSharp()
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
  }
  catch (error) {
    // Without sharp, hand back the raw capture untouched rather than failing
    // the whole screenshot tool (it just costs more bytes than a re-encode).
    if (!(error instanceof SharpUnavailableError))
      throw error
    return {
      data: png,
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      sourceWidth: size.width,
      sourceHeight: size.height,
    }
  }
}

/** Cut an element out of a screenshot, e.g. to keep a template image for a recorded tap. */
export async function cropImage(png: Buffer, bounds: Bounds): Promise<Buffer> {
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
}
