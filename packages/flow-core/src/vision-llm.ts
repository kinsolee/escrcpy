import { HealError, llmRequestHeaders, llmRequestUrl, llmResponseText, normalizeLlmApiType } from './heal.js'
import type { LlmApiType } from './heal.js'

/**
 * Image-capable LLM client for the vision agent. One request = system prompt +
 * one user turn (text + one screenshot). Speaks all three wire formats the
 * shared llm.json supports, with a per-request timeout, retries with
 * exponential backoff for 429/5xx/network failures, and token usage parsing.
 */

export interface VisionLlmEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** `messages` (Anthropic), `chat_completions` (OpenAI Chat) or `responses` (OpenAI Responses). Default `messages`. */
  apiType?: string
}

export interface VisionImage {
  /** Base64 without a data: prefix. */
  data: string
  mimeType: string
}

export interface VisionLlmRequest {
  system: string
  text: string
  image?: VisionImage
  /** Extra user turns appended after the first one, e.g. a parse-error re-ask. Text only. */
  followUps?: Array<{ assistant: string, user: string }>
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface VisionLlmResponse {
  text: string
  /** Undefined when the gateway did not report usage. */
  usage?: LlmUsage
  latencyMs: number
  /** HTTP attempts spent on this call (1 + retries). */
  attempts: number
}

export interface VisionLlmClient {
  complete: (request: VisionLlmRequest, signal?: AbortSignal) => Promise<VisionLlmResponse>
  /** Safe-to-log description: no key. */
  describe: () => { baseUrl: string, model: string, apiType: LlmApiType }
}

export interface VisionLlmClientOptions {
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number
  /** Retries for 429/5xx/network/timeout failures. Default 2. */
  maxRetries?: number
  /** First backoff delay; doubles per retry. Default 1000 ms. */
  backoffMs?: number
  maxTokens?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export class VisionLlmError extends HealError {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message, status === undefined ? undefined : { status })
    this.name = 'VisionLlmError'
  }
}

/** Builds the provider-specific request body. Exported for tests. */
export function buildVisionRequestBody(apiType: LlmApiType, model: string, request: VisionLlmRequest, maxTokens: number): Record<string, unknown> {
  const dataUrl = request.image ? `data:${request.image.mimeType};base64,${request.image.data}` : undefined
  const followUps = request.followUps ?? []
  if (apiType === 'messages') {
    return {
      model,
      max_tokens: maxTokens,
      system: request.system,
      messages: [
        {
          role: 'user',
          content: [
            ...(request.image ? [{ type: 'image', source: { type: 'base64', media_type: request.image.mimeType, data: request.image.data } }] : []),
            { type: 'text', text: request.text },
          ],
        },
        ...followUps.flatMap(turn => [{ role: 'assistant', content: turn.assistant }, { role: 'user', content: turn.user }]),
      ],
    }
  }
  if (apiType === 'chat_completions') {
    return {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: request.text },
            ...(dataUrl ? [{ type: 'image_url', image_url: { url: dataUrl } }] : []),
          ],
        },
        ...followUps.flatMap(turn => [{ role: 'assistant', content: turn.assistant }, { role: 'user', content: turn.user }]),
      ],
    }
  }
  return {
    model,
    max_output_tokens: maxTokens,
    instructions: request.system,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: request.text },
          ...(dataUrl ? [{ type: 'input_image', image_url: dataUrl }] : []),
        ],
      },
      ...followUps.flatMap(turn => [
        { role: 'assistant', content: [{ type: 'output_text', text: turn.assistant }] },
        { role: 'user', content: [{ type: 'input_text', text: turn.user }] },
      ]),
    ],
  }
}

/** Token usage from any of the three response shapes; undefined when absent. */
export function parseUsage(data: unknown): LlmUsage | undefined {
  const usage = (data as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage !== 'object')
    return undefined
  const prompt = numberOf(usage.prompt_tokens) ?? numberOf(usage.input_tokens)
  const completion = numberOf(usage.completion_tokens) ?? numberOf(usage.output_tokens)
  if (prompt === undefined && completion === undefined)
    return undefined
  // Anthropic reports cached prompt tokens separately from input_tokens.
  const cached = (numberOf(usage.cache_read_input_tokens) ?? 0) + (numberOf(usage.cache_creation_input_tokens) ?? 0)
  return { promptTokens: (prompt ?? 0) + cached, completionTokens: completion ?? 0 }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(signal.reason ?? new Error('aborted'))
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value)
    return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** Replaces every occurrence of `secret` so gateway error bodies can never leak the key into reports. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4)
    return text
  return text.split(secret).join('***')
}

export function createVisionLlmClient(endpoint: VisionLlmEndpoint, options: VisionLlmClientOptions = {}): VisionLlmClient {
  const apiType = normalizeLlmApiType(endpoint.apiType)
  const baseUrl = endpoint.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = endpoint.apiKey.trim()
  const model = endpoint.model.trim()
  if (!baseUrl || !apiKey || !model)
    throw new VisionLlmError('vision LLM endpoint needs baseUrl, apiKey and model')
  const timeoutMs = options.timeoutMs ?? 60_000
  const maxRetries = options.maxRetries ?? 2
  const backoffMs = options.backoffMs ?? 1000
  const maxTokens = options.maxTokens ?? 4096
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? abortableSleep
  const now = options.now ?? Date.now
  const url = llmRequestUrl(apiType, baseUrl)
  const headers = llmRequestHeaders(apiType, apiKey)

  async function attempt(body: string, signal?: AbortSignal): Promise<{ data: unknown } | { error: VisionLlmError, delayMs?: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal })
      if (!response.ok) {
        const detail = redactSecret(await response.text().catch(() => ''), apiKey).slice(0, 300)
        const retryable = response.status === 429 || response.status === 408 || response.status >= 500
        return { error: new VisionLlmError(`LLM request returned ${response.status}: ${detail}`, response.status, retryable), delayMs: retryAfterMs(response) }
      }
      return { data: await response.json() }
    }
    catch (error) {
      if (signal?.aborted)
        throw new VisionLlmError('LLM request aborted')
      const timedOut = controller.signal.aborted
      const message = timedOut ? `LLM request timed out after ${timeoutMs} ms` : `LLM request failed: ${redactSecret(error instanceof Error ? error.message : String(error), apiKey)}`
      return { error: new VisionLlmError(message, undefined, true) }
    }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    describe: () => ({ baseUrl, model, apiType }),
    async complete(request, signal) {
      const body = JSON.stringify(buildVisionRequestBody(apiType, model, request, maxTokens))
      const started = now()
      let attempts = 0
      for (;;) {
        attempts++
        const result = await attempt(body, signal)
        if ('data' in result) {
          let text: string
          try {
            text = llmResponseText(apiType, result.data)
          }
          catch (error) {
            throw new VisionLlmError(error instanceof Error ? error.message : String(error))
          }
          return { text, usage: parseUsage(result.data), latencyMs: now() - started, attempts }
        }
        if (!result.error.retryable || attempts > maxRetries)
          throw result.error
        const delay = Math.min(30_000, result.delayMs ?? backoffMs * 2 ** (attempts - 1))
        await sleep(delay, signal)
      }
    },
  }
}
