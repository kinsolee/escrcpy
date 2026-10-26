import type { Buffer } from 'node:buffer'
import sharp from 'sharp'
import type { Bounds } from './geometry.js'

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

/** Cut an element out of a screenshot, e.g. to keep a template image for a recorded tap. */
export async function cropImage(png: Buffer, bounds: Bounds): Promise<Buffer> {
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
