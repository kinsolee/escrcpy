/** Rectangle in device pixels, as written in the dump: `[left,top][right,bottom]`. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** Tolerance for ratio coordinates slightly outside 0~1 (float rounding from the model). */
export const RATIO_TOLERANCE = 0.005

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

export function parseBounds(value: string | undefined): Bounds {
  const match = value?.trim().match(BOUNDS_RE)
  if (!match)
    return { left: 0, top: 0, right: 0, bottom: 0 }
  const [, left, top, right, bottom] = match.map(Number)
  return { left, top, right, bottom }
}

export function boundsWidth(b: Bounds): number {
  return Math.max(0, b.right - b.left)
}

export function boundsHeight(b: Bounds): number {
  return Math.max(0, b.bottom - b.top)
}

export function boundsArea(b: Bounds): number {
  return boundsWidth(b) * boundsHeight(b)
}

export function boundsCenter(b: Bounds): Point {
  return {
    x: Math.round((b.left + b.right) / 2),
    y: Math.round((b.top + b.bottom) / 2),
  }
}

/** Half-open containment: the right and bottom edges belong to the next element. */
export function boundsContain(b: Bounds, p: Point): boolean {
  return p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom
}

export function clipBounds(b: Bounds, size: Size): Bounds {
  return {
    left: Math.max(0, Math.min(b.left, size.width)),
    top: Math.max(0, Math.min(b.top, size.height)),
    right: Math.max(0, Math.min(b.right, size.width)),
    bottom: Math.max(0, Math.min(b.bottom, size.height)),
  }
}

/** Tap point for an element: the centre of its on-screen part. */
export function tapPoint(b: Bounds, size: Size): Point {
  return boundsCenter(clipBounds(b, size))
}

export function isRatio(value: number): boolean {
  return Number.isFinite(value) && value >= -RATIO_TOLERANCE && value <= 1 + RATIO_TOLERANCE
}

/** Convert a 0~1 ratio point to device pixels, clamped to the screen. */
export function ratioToPixel(p: Point, size: Size): Point {
  if (!isRatio(p.x) || !isRatio(p.y))
    throw new RangeError(`Ratio coordinates must be within 0~1, got (${p.x}, ${p.y})`)
  const clamp = (v: number, max: number) => Math.min(Math.max(Math.round(v * max), 0), Math.max(max - 1, 0))
  return { x: clamp(p.x, size.width), y: clamp(p.y, size.height) }
}

/** Convert device pixels to a 0~1 ratio point, rounded to 4 decimals. */
export function pixelToRatio(p: Point, size: Size): Point {
  const round = (v: number) => Math.round(v * 10000) / 10000
  return { x: round(p.x / size.width), y: round(p.y / size.height) }
}
