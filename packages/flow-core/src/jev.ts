import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { HealError } from './heal.js'
import { loadLlmConfig, resolveJevSettings } from './llm-config.js'
import type { ResolvedJevSettings } from './llm-config.js'
import { redactSecret } from './vision-llm.js'

/**
 * Client for Jev, TypeSafe's System One judgment model: one request carries a
 * `state` and several typed questions (choice / score / noul / box), answered
 * in parallel with probability distributions. Jev does not plan or generate:
 * callers own control flow, arithmetic and policy, Jev owns snap judgments.
 *
 * Images go in a top-level `assets` map; `JevImage` values placed anywhere in
 * the state, instructions or criteria are replaced by a per-image UUID
 * reference here, and the `TypeSafe-Danger-Zone-Images: true` header is added
 * whenever a request carries an image or a Box question.
 */

// ---------------------------------------------------------------------------
// Questions and answers

export type JevInstructions = string | Record<string, unknown> | unknown[]

export interface JevNoulQuestion {
  type: 'noul'
  instructions: JevInstructions
  criteria?: { true?: unknown, false?: unknown }
}

export interface JevChoiceQuestion<K extends string = string> {
  type: 'choice'
  instructions?: JevInstructions
  criteria: Record<K, unknown>
}

export interface JevScoreQuestion {
  type: 'score'
  instructions?: JevInstructions
  /** Two to ten levels, low to high. */
  criteria: unknown[]
}

export interface JevBoxQuestion {
  type: 'box'
  instructions: JevInstructions
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion | JevBoxQuestion
export type JevQuestions = Record<string, JevQuestion>

export interface JevNoulAnswer {
  type: 'noul'
  /** Probability of yes, 0..1. */
  noul: number
}

export interface JevChoiceAnswer<K extends string = string> {
  type: 'choice'
  choice: K
  confidence: number
  probabilities: Record<K, number>
}

export interface JevScoreAnswer {
  type: 'score'
  score: number
  confidence: number
  probabilities: Record<string, number>
  legend?: Record<string, unknown>
}

/** Edges as fractions (0..1) of the image, measured from its top-left corner. */
export interface JevBox {
  top: number
  bottom: number
  left: number
  right: number
}

export interface JevBoxAnswer {
  type: 'box'
  box: JevBox
  /** Null when the model did not report one. */
  confidence: number | null
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer | JevBoxAnswer

export type JevAnswerFor<Q> = Q extends { type: 'noul' } ? JevNoulAnswer
  : Q extends { type: 'choice', criteria: infer C } ? JevChoiceAnswer<Extract<keyof C, string>>
    : Q extends { type: 'score' } ? JevScoreAnswer
      : Q extends { type: 'box' } ? JevBoxAnswer
        : JevAnswer

export type JevAnswers<Q extends JevQuestions> = { [K in keyof Q]: JevAnswerFor<Q[K]> }

// ---------------------------------------------------------------------------
// Images

export type JevImageFormat = 'png' | 'jpg'

/** Jev accepts images whose sides are each 280..1568 px. */
export const JEV_IMAGE_MIN_EDGE = 280
export const JEV_IMAGE_MAX_EDGE = 1568

/** An image to place in a Jev state / instruction / criteria; serialised as an asset with a UUID reference. */
export class JevImage {
  constructor(readonly data: Buffer, readonly format: JevImageFormat, readonly width: number, readonly height: number) {}
}

/** Width/height from a PNG IHDR or a JPEG SOF marker; undefined when unrecognised. */
export function imageDimensions(data: Buffer): { width: number, height: number, format: JevImageFormat } | undefined {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), format: 'png' }
  if (data.length >= 4 && data[0] === 0xFF && data[1] === 0xD8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xFF) {
        offset++
        continue
      }
      const marker = data[offset + 1]
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7), format: 'jpg' }
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        offset += 2
        continue
      }
      offset += 2 + data.readUInt16BE(offset + 2)
    }
  }
  return undefined
}

/** Wraps PNG/JPEG bytes, reading the size from the header. Throws JEV_IMAGE_INVALID for anything else. */
export function jevImage(data: Buffer): JevImage {
  const size = imageDimensions(data)
  if (!size)
    throw new JevError('JEV_IMAGE_INVALID', 'Jev images must be PNG or JPEG')
  return new JevImage(data, size.format, size.width, size.height)
}

function checkImageSize(image: JevImage): void {
  const { width, height } = image
  const ok = (side: number) => Number.isFinite(side) && side >= JEV_IMAGE_MIN_EDGE && side <= JEV_IMAGE_MAX_EDGE
  if (!ok(width) || !ok(height))
    throw new JevError('JEV_IMAGE_SIZE', `Jev images need both sides within ${JEV_IMAGE_MIN_EDGE}..${JEV_IMAGE_MAX_EDGE} px; got ${width}x${height}`)
}

// ---------------------------------------------------------------------------
// Errors

export type JevErrorCode
  = | 'JEV_IMAGES_BLOCKED'
    | 'JEV_HTTP'
    | 'JEV_TIMEOUT'
    | 'JEV_NETWORK'
    | 'JEV_BAD_RESPONSE'
    | 'JEV_IMAGE_SIZE'
    | 'JEV_IMAGE_INVALID'
    | 'JEV_CONFIG'
    | 'JEV_ABORTED'

export class JevError extends HealError {
  constructor(readonly code: JevErrorCode, message: string, readonly status?: number, readonly retryable = false) {
    super(`${code}: ${message}`, { code, ...(status === undefined ? {} : { status }) })
    this.name = 'JevError'
  }
}

// ---------------------------------------------------------------------------
// Client

export interface JevEndpoint {
  baseUrl: string
  apiKey: string
}

export interface JevClientOptions {
  /** Default endpoint for every request. Optional when `fallback` is set (image-only use). */
  primary?: JevEndpoint
  /** Endpoint for requests with images / Box questions after the primary refuses them with "Images are not turned on". */
  fallback?: JevEndpoint
  /** Default `typesafe-ai/jev`. */
  model?: string
  /** Per attempt. Default 10 s. */
  timeoutMs?: number
  /** Retries for 408/429/5xx/network/timeout failures. Default 1. */
  maxRetries?: number
  /** Delay before a retry. Default 300 ms. */
  retryDelayMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Called after every request (success or failure); never receives a key. */
  onCall?: (record: JevCallRecord) => void
}

export interface JevUsage {
  inputTokens: number
  outputTokens: number
}

export interface JevAskOptions {
  signal?: AbortSignal
  /** Overrides the client model for this request. */
  model?: string
}

export interface JevRequest<Q extends JevQuestions> {
  state: unknown
  questions: Q
}

export interface JevResponse<Q extends JevQuestions> {
  answers: JevAnswers<Q>
  model: string
  usage?: JevUsage
  latencyMs: number
  /** HTTP attempts, retries and the fallback switch included. */
  attempts: number
  endpoint: 'primary' | 'fallback'
  images: number
}

export interface JevCallRecord {
  ok: boolean
  latencyMs: number
  attempts: number
  endpoint?: 'primary' | 'fallback'
  questions: number
  images: number
  usage?: JevUsage
  error?: string
}

export interface JevClient {
  ask: <const Q extends JevQuestions>(request: JevRequest<Q>, options?: JevAskOptions) => Promise<JevResponse<Q>>
  /** Safe-to-log description: no keys. */
  describe: () => { model: string, primary?: string, fallback?: string, imagesViaFallback: boolean }
}

const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500

/** Replaces every JevImage with a UUID reference string and collects the assets. */
function serialize(value: unknown, assets: Map<JevImage, string>): unknown {
  if (value instanceof JevImage) {
    let ref = assets.get(value)
    if (!ref) {
      checkImageSize(value)
      ref = randomUUID()
      assets.set(value, ref)
    }
    return ref
  }
  if (Array.isArray(value))
    return value.map(item => serialize(item, assets))
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      out[key] = serialize(item, assets)
    return out
  }
  return value
}

/** Builds the JSON body and tells whether it needs the images header. Exported for tests. */
export function buildJevBody(model: string, request: JevRequest<JevQuestions>): { body: Record<string, unknown>, images: number, needsImages: boolean } {
  const assets = new Map<JevImage, string>()
  const state = serialize(request.state, assets)
  const questions = serialize(request.questions, assets) as Record<string, unknown>
  const hasBox = Object.values(request.questions).some(question => question.type === 'box')
  const body: Record<string, unknown> = { model, state, questions }
  if (assets.size) {
    body.assets = Object.fromEntries([...assets].map(([image, ref]) => [ref, { type: 'image', format: image.format, data_base64: image.data.toString('base64') }]))
  }
  return { body, images: assets.size, needsImages: assets.size > 0 || hasBox }
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

/** Checks that every question got an answer of its own type. Exported for tests. */
export function validateJevAnswers(questions: JevQuestions, data: unknown): Record<string, JevAnswer> {
  const answers = (data as { answers?: Record<string, unknown> } | null)?.answers
  if (!answers || typeof answers !== 'object')
    throw new JevError('JEV_BAD_RESPONSE', 'response has no answers object')
  const out: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name] as Record<string, any> | undefined
    if (!answer || typeof answer !== 'object')
      throw new JevError('JEV_BAD_RESPONSE', `no answer for question "${name}"`)
    const type = answer.type ?? question.type
    if (type !== question.type)
      throw new JevError('JEV_BAD_RESPONSE', `answer "${name}" is ${type}, expected ${question.type}`)
    if (type === 'noul' && !num(answer.noul))
      throw new JevError('JEV_BAD_RESPONSE', `noul answer "${name}" has no probability`)
    if (type === 'choice' && (typeof answer.choice !== 'string' || !num(answer.confidence)))
      throw new JevError('JEV_BAD_RESPONSE', `choice answer "${name}" is incomplete`)
    if (type === 'score' && !num(answer.score))
      throw new JevError('JEV_BAD_RESPONSE', `score answer "${name}" has no score`)
    if (type === 'box' && !['top', 'bottom', 'left', 'right'].every(edge => num(answer.box?.[edge])))
      throw new JevError('JEV_BAD_RESPONSE', `box answer "${name}" has no edges`)
    out[name] = { ...answer, type } as JevAnswer
    if (type === 'box')
      (out[name] as JevBoxAnswer).confidence = num(answer.confidence) ? answer.confidence : null
  }
  return out
}

function parseJevUsage(data: unknown): JevUsage | undefined {
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || !num(usage.input_tokens))
    return undefined
  return { inputTokens: usage.input_tokens as number, outputTokens: num(usage.output_tokens) ? usage.output_tokens as number : 0 }
}

export function createJevClient(options: JevClientOptions): JevClient {
  const primary = options.primary && { baseUrl: options.primary.baseUrl.trim().replace(/\/+$/, ''), apiKey: options.primary.apiKey.trim() }
  const fallback = options.fallback && { baseUrl: options.fallback.baseUrl.trim().replace(/\/+$/, ''), apiKey: options.fallback.apiKey.trim() }
  if (!primary?.apiKey && !fallback?.apiKey)
    throw new JevError('JEV_CONFIG', 'Jev needs an endpoint with an API key (llm.json "jev" section, the magpie vendor, or FLOW_JEV_API_KEY)')
  const model = options.model?.trim() || 'typesafe-ai/jev'
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxRetries = options.maxRetries ?? 1
  const retryDelayMs = options.retryDelayMs ?? 300
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const secrets = [primary?.apiKey, fallback?.apiKey].filter((key): key is string => !!key)
  const redact = (text: string) => secrets.reduce((acc, key) => redactSecret(acc, key), text)
  // Sticky: once the primary refused images, image requests go straight to the fallback.
  let imagesViaFallback = !primary?.apiKey && !!fallback

  async function attempt(endpoint: JevEndpoint, body: string, needsImages: boolean, signal?: AbortSignal): Promise<{ data: unknown } | { error: JevError }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const headers: Record<string, string> = { 'authorization': `Bearer ${endpoint.apiKey}`, 'content-type': 'application/json' }
      if (needsImages)
        headers['TypeSafe-Danger-Zone-Images'] = 'true'
      const response = await doFetch(`${endpoint.baseUrl}/v1/systemone`, { method: 'POST', headers, body, signal: controller.signal })
      if (!response.ok) {
        const detail = redact(await response.text().catch(() => '')).slice(0, 300)
        if (response.status === 400 && /images are not turned on/i.test(detail))
          return { error: new JevError('JEV_IMAGES_BLOCKED', `${endpoint.baseUrl} refused an image/Box request ("Images are not turned on"): the gateway did not forward the TypeSafe-Danger-Zone-Images header. Configure a fallback endpoint (llm.json jev.fallbackBaseUrl + jev.fallbackApiKeyEnv, or FLOW_JEV_FALLBACK_BASE_URL + FLOW_JEV_FALLBACK_API_KEY)`, 400) }
        return { error: new JevError('JEV_HTTP', `Jev returned ${response.status}: ${detail}`, response.status, RETRYABLE(response.status)) }
      }
      try {
        return { data: await response.json() }
      }
      catch {
        return { error: new JevError('JEV_BAD_RESPONSE', 'Jev response is not JSON') }
      }
    }
    catch (error) {
      if (signal?.aborted)
        return { error: new JevError('JEV_ABORTED', 'Jev request aborted') }
      if (controller.signal.aborted)
        return { error: new JevError('JEV_TIMEOUT', `Jev request timed out after ${timeoutMs} ms`, undefined, true) }
      return { error: new JevError('JEV_NETWORK', `Jev request failed: ${redact(error instanceof Error ? error.message : String(error))}`, undefined, true) }
    }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    describe: () => ({ model, ...(primary ? { primary: primary.baseUrl } : {}), ...(fallback ? { fallback: fallback.baseUrl } : {}), imagesViaFallback }),
    async ask(request, askOptions = {}) {
      const started = now()
      const { body: payload, images, needsImages } = buildJevBody(askOptions.model ?? model, request)
      const body = JSON.stringify(payload)
      const questions = Object.keys(request.questions).length
      let which: 'primary' | 'fallback' = needsImages && imagesViaFallback ? 'fallback' : 'primary'
      if (which === 'primary' && !primary?.apiKey)
        throw new JevError('JEV_CONFIG', 'no primary Jev endpoint with an API key for a text-only request')
      let attempts = 0
      let retries = 0
      for (;;) {
        attempts++
        const endpoint = which === 'primary' ? primary! : fallback!
        const result = await attempt(endpoint, body, needsImages, askOptions.signal)
        if ('data' in result) {
          let answers: Record<string, JevAnswer>
          try {
            answers = validateJevAnswers(request.questions, result.data)
          }
          catch (error) {
            options.onCall?.({ ok: false, latencyMs: now() - started, attempts, endpoint: which, questions, images, error: (error as Error).message })
            throw error
          }
          const usage = parseJevUsage(result.data)
          const response = {
            answers: answers as JevAnswers<typeof request.questions>,
            model: typeof (result.data as { model?: unknown }).model === 'string' ? (result.data as { model: string }).model : model,
            ...(usage ? { usage } : {}),
            latencyMs: now() - started,
            attempts,
            endpoint: which,
            images,
          }
          options.onCall?.({ ok: true, latencyMs: response.latencyMs, attempts, endpoint: which, questions, images, ...(usage ? { usage } : {}) })
          return response
        }
        const { error } = result
        if (error.code === 'JEV_IMAGES_BLOCKED' && which === 'primary' && fallback?.apiKey) {
          imagesViaFallback = true
          which = 'fallback'
          continue
        }
        if (error.retryable && retries < maxRetries) {
          retries++
          await sleep(retryDelayMs)
          continue
        }
        options.onCall?.({ ok: false, latencyMs: now() - started, attempts, endpoint: which, questions, images, error: error.message })
        throw error
      }
    },
  }
}

/** Client from explicitly resolved settings (see `resolveJevSettings`). */
export function createJevClientFromSettings(settings: ResolvedJevSettings, options: Omit<JevClientOptions, 'primary' | 'fallback' | 'model'> = {}): JevClient {
  return createJevClient({ ...options, primary: settings.primary, fallback: settings.fallback, model: settings.model, timeoutMs: options.timeoutMs ?? settings.timeoutMs })
}

/** Client from llm.json's `jev` section + FLOW_JEV_* env (default: magpie with the magpie vendor key). */
export function requireJevClient(options: Omit<JevClientOptions, 'primary' | 'fallback' | 'model'> & { configPath?: string, env?: NodeJS.ProcessEnv } = {}): JevClient {
  const { configPath, env, ...rest } = options
  return createJevClientFromSettings(resolveJevSettings(loadLlmConfig(configPath), env), rest)
}

// ---------------------------------------------------------------------------
// Helpers for code that acts on answers

/** Centre of a box as a 0..1 ratio point. */
export function jevBoxCenter(box: JevBox): { x: number, y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return { x: clamp((box.left + box.right) / 2), y: clamp((box.top + box.bottom) / 2) }
}

/** Compact, report-friendly form of an answer (probabilities rounded to 3 decimals). */
export function summarizeJevAnswer(answer: JevAnswer): Record<string, unknown> {
  const round = (value: number) => Math.round(value * 1000) / 1000
  const roundAll = (record: Record<string, number>) => Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, round(value)]))
  switch (answer.type) {
    case 'noul':
      return { noul: round(answer.noul) }
    case 'choice':
      return { choice: answer.choice, confidence: round(answer.confidence), probabilities: roundAll(answer.probabilities) }
    case 'score':
      return { score: round(answer.score), confidence: round(answer.confidence), probabilities: roundAll(answer.probabilities) }
    case 'box':
      return { box: { top: round(answer.box.top), bottom: round(answer.box.bottom), left: round(answer.box.left), right: round(answer.box.right) }, confidence: answer.confidence === null ? null : round(answer.confidence) }
  }
}
