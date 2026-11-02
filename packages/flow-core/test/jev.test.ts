import { Buffer } from 'node:buffer'
import { encodePng } from '@escrcpy/flow-device'
import { describe, expect, it } from 'vitest'
import {
  buildJevBody,
  createJevClient,
  cropAroundPoint,
  imageDimensions,
  JevError,
  jevImage,
  JevImage,
  resolveJevSettings,
  validateJevAnswers,
} from '../src/index.js'
import type { LlmConfig } from '../src/index.js'

const KEY = 'sk-primary-secret-123'
const FALLBACK_KEY = 'sk-fallback-secret-456'

function png(width: number, height: number, shade = 100): Buffer {
  return encodePng({ width, height, data: new Uint8Array(width * height * 3).fill(shade) })
}

/** Minimal baseline JPEG header: SOI, APP0, SOF0 with the given size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  const sof = [0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  return Buffer.from([0xFF, 0xD8, ...app0, ...sof, 0xFF, 0xD9])
}

interface Call { url: string, headers: Record<string, string>, body: any }

type Reply = { status: number, body: unknown } | 'hang' | 'network'

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    const reply = replies.shift() ?? { status: 500, body: { error: 'no reply scripted' } }
    if (reply === 'network')
      throw new Error(`connect ECONNREFUSED (key ${KEY})`)
    if (reply === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const OK_NOUL = { status: 200, body: { model: 'typesafe-ai/jev', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 12 } } }
const BLOCKED = { status: 400, body: { message: 'Images are not turned on. Send the `TypeSafe-Danger-Zone-Images: true` header with requests that contain images or Box questions.' } }
const BOX_OK = { status: 200, body: { model: 'typesafe-ai/jev', answers: { b: { type: 'box', box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 }, confidence: 0.8 }, q: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 2600, output_tokens: 30 } } }

describe('jev client', () => {
  it('reads PNG and JPEG sizes from their headers', () => {
    expect(imageDimensions(png(300, 640))).toEqual({ width: 300, height: 640, format: 'png' })
    expect(imageDimensions(jpegHeader(576, 1280))).toEqual({ width: 576, height: 1280, format: 'jpg' })
    expect(imageDimensions(Buffer.from('not an image'))).toBeUndefined()
    expect(jevImage(jpegHeader(576, 1280))).toMatchObject({ format: 'jpg', width: 576, height: 1280 })
  })

  it('replaces images with one UUID reference each and flags image/Box requests', () => {
    const screen = jevImage(png(300, 600))
    const { body, images, needsImages } = buildJevBody('m', {
      state: { screen, again: screen },
      questions: { q: { type: 'noul', instructions: ['Is `screen` like', screen] } },
    })
    expect(images).toBe(1)
    expect(needsImages).toBe(true)
    const ref = (body.state as Record<string, string>).screen
    expect(ref).toMatch(/^[0-9a-f-]{36}$/)
    expect((body.state as Record<string, string>).again).toBe(ref)
    expect((body.questions as any).q.instructions[1]).toBe(ref)
    expect((body.assets as any)[ref]).toEqual({ type: 'image', format: 'png', data_base64: screen.data.toString('base64') })
    const textOnly = buildJevBody('m', { state: 'hi', questions: { q: { type: 'noul', instructions: 'x?' } } })
    expect(textOnly.needsImages).toBe(false)
    expect(textOnly.body.assets).toBeUndefined()
    expect(buildJevBody('m', { state: 'hi', questions: { b: { type: 'box', instructions: 'the cat' } } }).needsImages).toBe(true)
  })

  it('rejects images outside 280..1568 px before sending', async () => {
    const { fetchImpl, calls } = fakeFetch([OK_NOUL])
    const client = createJevClient({ primary: { baseUrl: 'http://gw', apiKey: KEY }, fetchImpl })
    await expect(client.ask({ state: { s: new JevImage(png(108, 240), 'png', 108, 240) }, questions: { q: { type: 'noul', instructions: '?' } } })).rejects.toMatchObject({ code: 'JEV_IMAGE_SIZE' })
    await expect(client.ask({ state: { s: new JevImage(Buffer.alloc(1), 'png', 300, 1600) }, questions: { q: { type: 'noul', instructions: '?' } } })).rejects.toMatchObject({ code: 'JEV_IMAGE_SIZE' })
    expect(calls).toHaveLength(0)
  })

  it('sends the images header only when needed and returns typed answers with latency and usage', async () => {
    const { fetchImpl, calls } = fakeFetch([OK_NOUL, BOX_OK])
    const records: unknown[] = []
    const client = createJevClient({ primary: { baseUrl: 'http://gw/', apiKey: KEY }, fetchImpl, onCall: record => records.push(record) })
    const text = await client.ask({ state: 'msg', questions: { q: { type: 'noul', instructions: 'Billing?' } } })
    expect(text.answers.q.noul).toBe(0.9)
    expect(text.usage).toEqual({ inputTokens: 120, outputTokens: 12 })
    expect(text.endpoint).toBe('primary')
    expect(calls[0].url).toBe('http://gw/v1/systemone')
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers['TypeSafe-Danger-Zone-Images']).toBeUndefined()
    expect(calls[0].body.model).toBe('typesafe-ai/jev')
    const image = await client.ask({ state: { screen: jevImage(png(300, 600)) }, questions: { b: { type: 'box', instructions: 'the button in `screen`' }, q: { type: 'noul', instructions: 'Visible?' } } })
    expect(image.answers.b.box).toEqual({ top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 })
    expect(image.answers.b.confidence).toBe(0.8)
    expect(image.images).toBe(1)
    expect(calls[1].headers['TypeSafe-Danger-Zone-Images']).toBe('true')
    expect(records).toHaveLength(2)
    expect(JSON.stringify(records)).not.toContain(KEY)
  })

  it('switches image requests to the fallback endpoint after JEV_IMAGES_BLOCKED and stays there', async () => {
    const { fetchImpl, calls } = fakeFetch([BLOCKED, BOX_OK, OK_NOUL, BOX_OK])
    const client = createJevClient({ primary: { baseUrl: 'http://magpie', apiKey: KEY }, fallback: { baseUrl: 'https://upstream/typesafe', apiKey: FALLBACK_KEY }, fetchImpl })
    const ask = () => client.ask({ state: { screen: jevImage(png(300, 600)) }, questions: { b: { type: 'box', instructions: 'x' }, q: { type: 'noul', instructions: 'y' } } })
    const first = await ask()
    expect(first.endpoint).toBe('fallback')
    expect(first.attempts).toBe(2)
    expect(calls.map(call => call.url)).toEqual(['http://magpie/v1/systemone', 'https://upstream/typesafe/v1/systemone'])
    expect(calls[1].headers.authorization).toBe(`Bearer ${FALLBACK_KEY}`)
    // Text-only requests keep using the primary.
    expect((await client.ask({ state: 's', questions: { q: { type: 'noul', instructions: '?' } } })).endpoint).toBe('primary')
    // Later image requests go straight to the fallback.
    expect((await ask()).attempts).toBe(1)
    expect(calls.map(call => call.url).slice(2)).toEqual(['http://magpie/v1/systemone', 'https://upstream/typesafe/v1/systemone'])
    expect(client.describe()).toMatchObject({ imagesViaFallback: true, primary: 'http://magpie', fallback: 'https://upstream/typesafe' })
  })

  it('throws JEV_IMAGES_BLOCKED with a configuration hint when no fallback is set', async () => {
    const { fetchImpl } = fakeFetch([BLOCKED])
    const client = createJevClient({ primary: { baseUrl: 'http://magpie', apiKey: KEY }, fetchImpl })
    const error = await client.ask({ state: { s: jevImage(png(300, 600)) }, questions: { q: { type: 'noul', instructions: '?' } } }).catch(e => e)
    expect(error).toBeInstanceOf(JevError)
    expect(error.code).toBe('JEV_IMAGES_BLOCKED')
    expect(error.message).toContain('TypeSafe-Danger-Zone-Images')
    expect(error.message).toContain('fallbackBaseUrl')
  })

  it('retries a timeout once, then succeeds', async () => {
    const { fetchImpl, calls } = fakeFetch(['hang', OK_NOUL])
    const client = createJevClient({ primary: { baseUrl: 'http://gw', apiKey: KEY }, fetchImpl, timeoutMs: 20, retryDelayMs: 0 })
    const response = await client.ask({ state: 's', questions: { q: { type: 'noul', instructions: '?' } } })
    expect(response.attempts).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('retries 429/5xx/network once and reports the last error without the key', async () => {
    const twice = fakeFetch([{ status: 503, body: { error: `upstream down for ${KEY}` } }, { status: 502, body: { error: `again ${KEY}` } }])
    const client = createJevClient({ primary: { baseUrl: 'http://gw', apiKey: KEY }, fetchImpl: twice.fetchImpl, retryDelayMs: 0 })
    const error = await client.ask({ state: 's', questions: { q: { type: 'noul', instructions: '?' } } }).catch(e => e)
    expect(error.code).toBe('JEV_HTTP')
    expect(error.status).toBe(502)
    expect(twice.calls).toHaveLength(2)
    expect(error.message).not.toContain(KEY)
    const network = fakeFetch(['network', 'network'])
    const netClient = createJevClient({ primary: { baseUrl: 'http://gw', apiKey: KEY }, fetchImpl: network.fetchImpl, retryDelayMs: 0 })
    const netError = await netClient.ask({ state: 's', questions: { q: { type: 'noul', instructions: '?' } } }).catch(e => e)
    expect(netError.code).toBe('JEV_NETWORK')
    expect(netError.message).not.toContain(KEY)
    // 4xx other than 408/429 is not retried.
    const bad = fakeFetch([{ status: 422, body: { detail: 'bad' } }])
    await createJevClient({ primary: { baseUrl: 'http://gw', apiKey: KEY }, fetchImpl: bad.fetchImpl }).ask({ state: 's', questions: { q: { type: 'noul', instructions: '?' } } }).catch(() => {})
    expect(bad.calls).toHaveLength(1)
  })

  it('rejects answers that are missing or of the wrong type', () => {
    expect(() => validateJevAnswers({ q: { type: 'noul', instructions: '?' } }, { answers: {} })).toThrow(/no answer/)
    expect(() => validateJevAnswers({ q: { type: 'noul', instructions: '?' } }, { answers: { q: { type: 'choice', choice: 'a', confidence: 1 } } })).toThrow(/expected noul/)
    expect(() => validateJevAnswers({ b: { type: 'box', instructions: '?' } }, { answers: { b: { type: 'box', box: { top: 0 } } } })).toThrow(/no edges/)
    expect(validateJevAnswers({ b: { type: 'box', instructions: '?' } }, { answers: { b: { type: 'box', box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: null } } }).b).toMatchObject({ confidence: null })
  })

  it('resolves settings: magpie by default with the magpie vendor key, env and config overrides, opt-in fallback', () => {
    const config: LlmConfig = { vendors: [{ id: 'magpie', baseUrl: 'http://127.0.0.1:3425', apiKey: 'magpie-key', models: [] }] }
    expect(resolveJevSettings(config, {})).toEqual({ primary: { baseUrl: 'http://127.0.0.1:3425', apiKey: 'magpie-key' }, model: 'typesafe-ai/jev' })
    const configured: LlmConfig = { ...config, jev: { baseUrl: 'https://gw/typesafe/', apiKeyEnv: 'MY_JEV', model: 'jev-1.14', fallbackBaseUrl: 'https://up', fallbackApiKeyEnv: 'UP_KEY' } }
    expect(resolveJevSettings(configured, { MY_JEV: 'k1', UP_KEY: 'k2' })).toEqual({ primary: { baseUrl: 'https://gw/typesafe', apiKey: 'k1' }, fallback: { baseUrl: 'https://up', apiKey: 'k2' }, model: 'jev-1.14' })
    // Fallback stays off unless both URL and key are present.
    expect(resolveJevSettings(configured, { MY_JEV: 'k1' }).fallback).toBeUndefined()
    expect(resolveJevSettings(config, { FLOW_JEV_FALLBACK_BASE_URL: 'https://up', FLOW_JEV_FALLBACK_API_KEY: 'k3', FLOW_JEV_API_KEY: 'k4', FLOW_JEV_MODEL: 'x' })).toEqual({ primary: { baseUrl: 'http://127.0.0.1:3425', apiKey: 'k4' }, fallback: { baseUrl: 'https://up', apiKey: 'k3' }, model: 'x' })
    expect(resolveJevSettings(undefined, {}).primary).toBeUndefined()
    expect(() => createJevClient({})).toThrow(/JEV_CONFIG/)
  })

  it('crops around a tap point at Jev size and marks it with a red ring', () => {
    const screen = png(1080, 2400, 200)
    const crop = cropAroundPoint(screen, { x: 0.98, y: 0.02 })!
    expect(crop.rect).toEqual({ left: 1080 - 454, top: 0, width: 454, height: 454 })
    expect(imageDimensions(crop.image.data)).toMatchObject({ width: 454, height: 454 })
    expect(cropAroundPoint(Buffer.from('jpeg?'), { x: 0.5, y: 0.5 })).toBeUndefined()
  })
})
