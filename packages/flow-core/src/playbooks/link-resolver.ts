import http from 'node:http'
import https from 'node:https'

/**
 * Resolves a copied short link by following its redirects by hand, with
 * per-hop diagnostics and retries.
 *
 * On device runs, Node's pooled fetch to TikTok's short-link edge (Akamai)
 * was reset (ECONNRESET, 0.1–0.4 s) on roughly one request in five when
 * requests came in bursts or reused a keep-alive connection; curl and fresh
 * connections almost never were. So every hop opens its own connection, and
 * transient failures (timeout, network error, 429, 5xx) are retried with
 * backoff within a total time cap.
 */

export interface HopResponse {
  status: number
  location?: string
}

/** One HTTP GET without following redirects. Rejects on network errors; `timeoutMs` aborts it. */
export type HopFetcher = (url: string, timeoutMs: number) => Promise<HopResponse>

export type HopError = 'timeout' | 'network' | 'status'

export interface RedirectHop {
  attempt: number
  /** origin + path only: query strings of product URLs carry account and device identifiers. */
  url: string
  ms: number
  status?: number
  /** Where the hop redirects to (origin + path). */
  to?: string
  error?: HopError
  /** Network error code (ECONNRESET, ENOTFOUND, …) or the non-redirect status. */
  code?: string
}

export interface LinkResolution {
  /** The first URL matching `stopAt`, else the last URL reached; undefined when no attempt got anywhere. */
  url?: string
  /** True when `stopAt` matched (always false without `stopAt`). */
  matched: boolean
  attempts: number
  ms: number
  hops: RedirectHop[]
  /** Why it did not reach `stopAt`. */
  reason?: string
}

export interface ResolveOptions {
  stopAt?: RegExp
  /** Attempts in total (1 + retries). Default 4. */
  maxAttempts?: number
  /** Cap on the whole resolution, retries and backoff included. Default 20 s. */
  totalBudgetMs?: number
  /** Per hop. Default 8 s (shortened to what is left of the budget). */
  hopTimeoutMs?: number
  /** Backoff before retry n (1-based). Default 500 ms, 1 s, 2 s. */
  backoffMs?: readonly number[]
  maxHops?: number
  fetchHop?: HopFetcher
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) flow-playbook'

/** origin + path; query and fragment dropped. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }
  catch {
    return url.split(/[?#]/)[0]
  }
}

/** Thrown by a hop fetcher: `timeout` or `network` (with the error code). Other errors count as network errors. */
export class HopFetchError extends Error {
  constructor(readonly kind: Exclude<HopError, 'status'>, readonly code: string) {
    super(code)
    this.name = 'HopFetchError'
  }
}

/** GET over a fresh connection (no keep-alive pool), body discarded. */
export const fetchHopFresh: HopFetcher = (url, timeoutMs) => new Promise((resolve, reject) => {
  const target = new URL(url)
  const client = target.protocol === 'http:' ? http : https
  const request = client.request(target, { method: 'GET', agent: false, headers: { 'user-agent': USER_AGENT, 'accept': '*/*' } }, (response) => {
    response.resume()
    const location = response.headers.location
    resolve({ status: response.statusCode ?? 0, ...(location ? { location } : {}) })
  })
  const timer = setTimeout(() => request.destroy(new HopFetchError('timeout', 'timeout')), timeoutMs)
  request.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timer)
    reject(error instanceof HopFetchError ? error : new HopFetchError('network', error.code ?? error.message))
  })
  request.on('close', () => clearTimeout(timer))
  request.end()
})

const retryableStatus = (status: number) => status === 429 || status >= 500

export async function resolveLinkDetailed(url: string, options: ResolveOptions = {}): Promise<LinkResolution> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const fetchHop = options.fetchHop ?? fetchHopFresh
  const maxAttempts = options.maxAttempts ?? 4
  const budget = options.totalBudgetMs ?? 20_000
  const hopTimeout = options.hopTimeoutMs ?? 8000
  const backoff = options.backoffMs ?? [500, 1000, 2000]
  const maxHops = options.maxHops ?? 5
  const started = now()
  const hops: RedirectHop[] = []
  const done = (fields: Omit<LinkResolution, 'attempts' | 'ms' | 'hops'>, attempts: number): LinkResolution => ({ ...fields, attempts, ms: now() - started, hops })
  if (options.stopAt?.test(url))
    return done({ url, matched: true }, 0)

  let lastReason = 'no attempt made'
  let lastUrl: string | undefined
  let attempt = 0
  while (attempt < maxAttempts) {
    if (attempt > 0) {
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0
      if (now() + wait >= started + budget)
        break
      await sleep(wait)
    }
    attempt++
    let current = url
    let retry = false
    let stopped = false
    for (let hop = 0; hop < maxHops; hop++) {
      const left = started + budget - now()
      if (left <= 0) {
        lastReason = `time budget of ${budget} ms spent`
        return done({ ...(lastUrl ? { url: lastUrl } : {}), matched: false, reason: lastReason }, attempt)
      }
      const record: RedirectHop = { attempt, url: redactUrl(current), ms: 0 }
      hops.push(record)
      const hopStarted = now()
      let response: HopResponse
      try {
        response = await fetchHop(current, Math.min(hopTimeout, left))
      }
      catch (error) {
        record.ms = now() - hopStarted
        const failure = error instanceof HopFetchError ? error : new HopFetchError('network', (error as NodeJS.ErrnoException)?.code ?? String((error as Error)?.message ?? error))
        record.error = failure.kind
        record.code = failure.code
        lastReason = failure.kind === 'timeout' ? `timeout at ${record.url}` : `network error ${failure.code} at ${record.url}`
        retry = true
        stopped = true
        break
      }
      record.ms = now() - hopStarted
      record.status = response.status
      if (response.status >= 300 && response.status < 400 && response.location) {
        current = new URL(response.location, current).toString()
        record.to = redactUrl(current)
        lastUrl = current
        if (options.stopAt?.test(current))
          return done({ url: current, matched: true }, attempt)
        continue
      }
      lastUrl = current
      record.error = 'status'
      record.code = String(response.status)
      if (!options.stopAt)
        return done({ url: current, matched: false }, attempt)
      lastReason = `status ${response.status} without a redirect at ${record.url}`
      retry = retryableStatus(response.status)
      stopped = true
      break
    }
    if (!stopped)
      lastReason = `more than ${maxHops} redirects`
    if (!retry) {
      return done({ ...(lastUrl ? { url: lastUrl } : {}), matched: false, reason: lastReason }, attempt)
    }
  }
  return done({ ...(lastUrl ? { url: lastUrl } : {}), matched: false, reason: `${lastReason} (after ${attempt} attempt${attempt === 1 ? '' : 's'})` }, attempt)
}

/**
 * Follows redirects and returns the first URL matching `stopAt`, else the last one reached;
 * undefined when nothing was reached. Stopping matters: a TikTok product page itself
 * redirects cookie-less clients on to /login.
 */
export async function resolveRedirects(url: string, stopAt?: RegExp, options: Omit<ResolveOptions, 'stopAt'> = {}): Promise<string | undefined> {
  return (await resolveLinkDetailed(url, { ...options, stopAt })).url
}
