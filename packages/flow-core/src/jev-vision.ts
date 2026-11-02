import type { Buffer } from 'node:buffer'
import { decodePng, encodePng, encodeScreenshot } from '@escrcpy/flow-device'
import type { EncodedImage, EncodeOptions, RatioPoint, RgbImage } from '@escrcpy/flow-device'
import { jevBoxCenter, JevError, JevImage, summarizeJevAnswer } from './jev.js'
import type { JevAnswers, JevBox, JevClient, JevNoulQuestion, JevQuestions, JevUsage } from './jev.js'

/**
 * Jev visual primitives over a live device screen: locate a control (Box +
 * presence Noul in one request), ask typed questions about the screen
 * (fan-out in one request), and judge whether the control under a tap point is
 * a social / purchase action (crop + marker, one Noul).
 */

export interface JevScreenDevice {
  /** Raw PNG screencap. */
  screencap: (serial: string) => Promise<Buffer>
  encode?: (png: Buffer, options: EncodeOptions) => Promise<EncodedImage>
}

export interface JevScreen {
  png: Buffer
  encoded: EncodedImage
  image: JevImage
  /** Device screen size (the raw capture). */
  width: number
  height: number
}

/** Longest edge sent to Jev; 1280 keeps a 1080x2400 phone at 576x1280 (inside Jev's 280..1568). */
export const JEV_SCREEN_MAX_EDGE = 1280

export async function encodeJevScreen(png: Buffer, encode: JevScreenDevice['encode'] = encodeScreenshot, maxEdge = JEV_SCREEN_MAX_EDGE): Promise<JevScreen> {
  const encoded = await encode(png, { maxEdge, format: 'jpeg', quality: 80 })
  const image = new JevImage(encoded.data, encoded.mimeType === 'image/png' ? 'png' : 'jpg', encoded.width, encoded.height)
  return { png, encoded, image, width: encoded.sourceWidth, height: encoded.sourceHeight }
}

export async function captureJevScreen(device: JevScreenDevice, serial: string, maxEdge = JEV_SCREEN_MAX_EDGE): Promise<JevScreen> {
  return encodeJevScreen(await device.screencap(serial), device.encode, maxEdge)
}

export interface VisualCallInfo {
  latencyMs: number
  attempts: number
  endpoint: 'primary' | 'fallback'
  usage?: JevUsage
}

function callInfo(response: { latencyMs: number, attempts: number, endpoint: 'primary' | 'fallback', usage?: JevUsage }): VisualCallInfo {
  return { latencyMs: response.latencyMs, attempts: response.attempts, endpoint: response.endpoint, ...(response.usage ? { usage: response.usage } : {}) }
}

// ---------------------------------------------------------------------------
// visualLocate

export interface VisualLocateOptions {
  serial: string
  /** What to find, e.g. "the Copy link button in the share panel". */
  description: string
  device: JevScreenDevice
  jev: JevClient
  signal?: AbortSignal
  /** Reuse a screen captured by the caller instead of taking a new screenshot. */
  screen?: JevScreen
}

export interface VisualLocateResult {
  /** Presence probability ≥ 0.5. Box always comes back, so check this before acting. */
  present: boolean
  presentProbability: number
  box: JevBox
  confidence: number | null
  /** Box centre as a 0..1 ratio of the screen. */
  ratio: RatioPoint
  /** Box centre in device pixels. */
  point: { x: number, y: number }
  screen: { width: number, height: number }
  jev: VisualCallInfo
}

/** One Jev request: a Box for `description` plus a Noul asking whether it is on screen at all. */
export async function visualLocate(options: VisualLocateOptions): Promise<VisualLocateResult> {
  const screen = options.screen ?? await captureJevScreen(options.device, options.serial)
  const target = options.description.trim()
  if (!target)
    throw new JevError('JEV_CONFIG', 'visualLocate needs a description')
  const response = await options.jev.ask({
    state: { screen: screen.image },
    questions: {
      present: { type: 'noul', instructions: `Is this visible in \`screen\`: ${target}?` },
      target: { type: 'box', instructions: `${target}, in \`screen\`` },
    },
  }, { signal: options.signal })
  const { present, target: located } = response.answers
  const ratio = jevBoxCenter(located.box)
  return {
    present: present.noul >= 0.5,
    presentProbability: present.noul,
    box: located.box,
    confidence: located.confidence,
    ratio,
    point: { x: Math.round(ratio.x * screen.width), y: Math.round(ratio.y * screen.height) },
    screen: { width: screen.width, height: screen.height },
    jev: callInfo(response),
  }
}

// ---------------------------------------------------------------------------
// visualCheck

export interface VisualCheckOptions<Q extends JevQuestions> {
  serial: string
  /** Questions about the screenshot, which is in the state as `screen`; refer to it as \`screen\`. */
  questions: Q
  device: JevScreenDevice
  jev: JevClient
  /** Extra state fields next to `screen` (e.g. a keyword the questions compare against). */
  state?: Record<string, unknown>
  signal?: AbortSignal
  screen?: JevScreen
}

export interface VisualCheckResult<Q extends JevQuestions> {
  answers: JevAnswers<Q>
  /** Rounded, JSON-friendly answers. */
  summary: Record<string, Record<string, unknown>>
  screen: { width: number, height: number }
  jev: VisualCallInfo
}

/** Asks every question about the current screen in one request (fan-out). */
export async function visualCheck<const Q extends JevQuestions>(options: VisualCheckOptions<Q>): Promise<VisualCheckResult<Q>> {
  if (!Object.keys(options.questions).length)
    throw new JevError('JEV_CONFIG', 'visualCheck needs at least one question')
  const screen = options.screen ?? await captureJevScreen(options.device, options.serial)
  const response = await options.jev.ask({ state: { ...options.state, screen: screen.image }, questions: options.questions }, { signal: options.signal })
  const summary = Object.fromEntries(Object.entries(response.answers).map(([name, answer]) => [name, summarizeJevAnswer(answer as never)]))
  return { answers: response.answers, summary, screen: { width: screen.width, height: screen.height }, jev: callInfo(response) }
}

// ---------------------------------------------------------------------------
// Visual forbidden-control check

/** Probability above which the visual check refuses a tap. */
export const VISUAL_RISK_THRESHOLD = 0.5

/** Calibrated on 15 real TikTok crops (share arrow, copy link, cart, buy, chat, friends, claim, like…): 15/15. */
export const VISUAL_RISK_QUESTION: JevNoulQuestion = {
  type: 'noul',
  instructions: 'Is the control inside the red circle in `crop` a button that likes, follows, comments, sends a message, adds to cart, buys, checks out, claims a coupon or reward, subscribes, or sends to a specific friend, contact or app?',
  criteria: {
    true: {
      what: 'A social, messaging, sending or purchase action button',
      examples: ['a heart Like icon', 'a Follow or + follow button', 'a comment bubble icon', 'an Add to cart cart-plus icon', 'a Buy now button', 'a Claim or Claim all button', 'a Send button', 'a friend avatar in a share panel', 'a TikTok friends, Facebook, SMS or WhatsApp button in a share panel', 'a Chat button that messages the seller'],
    },
    false: {
      what: 'A navigation, search, close, copy-link, share-panel-opening or content control',
      examples: ['a Copy link button', 'a close X button', 'a back arrow', 'a Search button or search field', 'a product card photo or title', 'a Shop tab', 'a curved-arrow Share icon in a top bar, which only opens the share panel', 'an empty area of the page'],
    },
  },
}

/** Copies a rectangle out of RGB pixels. */
export function cropRgb(image: RgbImage, rect: { left: number, top: number, width: number, height: number }): RgbImage {
  const data = new Uint8Array(rect.width * rect.height * 3)
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.top + y) * image.width + rect.left) * 3
    data.set(image.data.subarray(from, from + rect.width * 3), y * rect.width * 3)
  }
  return { width: rect.width, height: rect.height, data }
}

/** Draws a red ring (in place) centred on (cx, cy). */
export function drawRing(image: RgbImage, cx: number, cy: number, radius: number, thickness: number): void {
  const outer = radius + thickness / 2
  const inner = Math.max(0, radius - thickness / 2)
  for (let y = Math.max(0, Math.floor(cy - outer)); y <= Math.min(image.height - 1, Math.ceil(cy + outer)); y++) {
    for (let x = Math.max(0, Math.floor(cx - outer)); x <= Math.min(image.width - 1, Math.ceil(cx + outer)); x++) {
      const distance = Math.hypot(x - cx, y - cy)
      if (distance <= outer && distance >= inner) {
        const i = (y * image.width + x) * 3
        image.data[i] = 255
        image.data[i + 1] = 0
        image.data[i + 2] = 64
      }
    }
  }
}

export interface TapCrop {
  image: JevImage
  /** Crop rectangle in device pixels. */
  rect: { left: number, top: number, width: number, height: number }
}

/**
 * A square crop of the raw screencap around a tap point with a red ring on the
 * point, sized for Jev (≥ 280 px when the screen allows). Pure JS: works
 * without sharp. Undefined when the screencap cannot be decoded.
 */
export function cropAroundPoint(png: Buffer, ratio: RatioPoint): TapCrop | undefined {
  const decoded = decodePng(png)
  if (!decoded)
    return undefined
  const short = Math.min(decoded.width, decoded.height)
  const side = Math.min(short, Math.max(280, Math.round(short * 0.42)))
  const px = Math.round(ratio.x * decoded.width)
  const py = Math.round(ratio.y * decoded.height)
  const left = Math.min(Math.max(0, px - Math.round(side / 2)), decoded.width - side)
  const top = Math.min(Math.max(0, py - Math.round(side / 2)), decoded.height - side)
  const crop = cropRgb(decoded, { left, top, width: side, height: side })
  drawRing(crop, px - left, py - top, Math.round(side * 0.12), Math.max(3, Math.round(side * 0.012)))
  return { image: new JevImage(encodePng(crop), 'png', side, side), rect: { left, top, width: side, height: side } }
}

export interface VisualRiskResult {
  /** True when the probability exceeds the threshold: refuse the tap. */
  risky: boolean
  probability: number
  rect: TapCrop['rect']
  jev: VisualCallInfo
}

/**
 * Asks Jev whether the control under `ratio` (marked with a red ring on a crop
 * of the raw screencap) is a social / purchase action. Throws when the crop or
 * the request fails; callers decide how to treat an unverifiable tap.
 */
export async function visualRiskCheck(options: { png: Buffer, ratio: RatioPoint, jev: JevClient, threshold?: number, signal?: AbortSignal }): Promise<VisualRiskResult> {
  const crop = cropAroundPoint(options.png, options.ratio)
  if (!crop)
    throw new JevError('JEV_IMAGE_INVALID', 'screencap could not be decoded for the visual tap check')
  const response = await options.jev.ask({ state: { crop: crop.image }, questions: { risky: VISUAL_RISK_QUESTION } }, { signal: options.signal })
  const probability = response.answers.risky.noul
  return { risky: probability > (options.threshold ?? VISUAL_RISK_THRESHOLD), probability, rect: crop.rect, jev: callInfo(response) }
}
