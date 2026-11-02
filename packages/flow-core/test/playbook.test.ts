import type { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodePng, encodePng } from '@escrcpy/flow-device'
import type { ForegroundApp, RatioPoint } from '@escrcpy/flow-device'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productIdFromUrl, resolveRedirects, runPlaybook, TIKTOK_PACKAGE } from '../src/index.js'
import type { JevAnswer, JevClient, JevImage, JevQuestions, PlaybookOptions, VisionAgentDevice, VisionLlmClient } from '../src/index.js'

// ---------------------------------------------------------------------------
// A tiny simulated TikTok

type Page = 'video_feed' | 'shop_home' | 'search_input' | 'results_grid' | 'no_results' | 'product_detail' | 'live_room'

interface Card { id: string, live?: boolean, video?: boolean, ad?: boolean, opensApp?: string, /** The tap does nothing (grid still loading). */ dead?: boolean }

interface Box { top: number, bottom: number, left: number, right: number }

const BOXES: Record<string, Box> = {
  shop_tab: { top: 0.07, bottom: 0.11, left: 0.6, right: 0.7 },
  shop_search: { top: 0.05, bottom: 0.12, left: 0.1, right: 0.9 },
  search_button: { top: 0.04, bottom: 0.08, left: 0.85, right: 0.97 },
  popup_close: { top: 0.68, bottom: 0.71, left: 0.47, right: 0.53 },
  share_icon: { top: 0.07, bottom: 0.09, left: 0.71, right: 0.76 },
  copy_link: { top: 0.84, bottom: 0.92, left: 0.04, right: 0.18 },
  top_left_card: { top: 0.2, bottom: 0.47, left: 0.02, right: 0.48 },
  top_right_card: { top: 0.2, bottom: 0.47, left: 0.52, right: 0.98 },
  bottom_left_card: { top: 0.5, bottom: 0.8, left: 0.02, right: 0.48 },
  bottom_right_card: { top: 0.5, bottom: 0.8, left: 0.52, right: 0.98 },
}
const POSITIONS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
/** Grey level painted under each grid card, so a crop's ring centre tells which card a tap targets. */
const CARD_SHADES = [60, 80, 100, 120]
const PAGE_SHADES: Record<Page, number> = { video_feed: 30, shop_home: 140, search_input: 160, results_grid: 40, no_results: 180, product_detail: 200, live_room: 220 }
const W = 300
const H = 600

const inside = (point: RatioPoint, box: Box) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom

interface WorldOptions {
  grid: Card[]
  noResults?: boolean
  couponPopup?: boolean
  /** After a copy, Android's clipboard preview hides the bottom-left card's price (seen on device). */
  clipboardOverlay?: boolean
}

function world(options: WorldOptions) {
  const state = {
    app: 'com.google.android.apps.nexuslauncher',
    page: 'video_feed' as Page,
    fromCard: false,
    popup: false,
    share: false,
    field: '',
    clipboard: 'old clipboard text',
    scroll: 0,
    current: undefined as Card | undefined,
    popupShown: false,
    overlay: false,
  }
  const taps: RatioPoint[] = []
  const typed: string[] = []
  const starts: Array<{ pkg: string, restart?: boolean }> = []
  const visible = () => options.grid.slice(state.scroll * 4, state.scroll * 4 + 4)

  function screen(): Buffer {
    const data = new Uint8Array(W * H * 3).fill(PAGE_SHADES[state.page])
    if (state.page === 'results_grid') {
      POSITIONS.forEach((position, index) => {
        const box = BOXES[`${position}_card`]
        for (let y = Math.round(box.top * H); y < Math.round(box.bottom * H); y++)
          data.fill(CARD_SHADES[index], (y * W + Math.round(box.left * W)) * 3, (y * W + Math.round(box.right * W)) * 3)
      })
    }
    return encodePng({ width: W, height: H, data })
  }

  const device: VisionAgentDevice = {
    screencap: async () => screen(),
    foregroundApp: async (): Promise<ForegroundApp> => ({ package: state.app, activity: `${state.app}.Main` }),
    tap: async (_serial, point) => {
      taps.push(point)
      if (state.app !== TIKTOK_PACKAGE)
        return
      if (state.page === 'video_feed' && !state.fromCard && inside(point, BOXES.shop_tab)) {
        state.page = 'shop_home'
      }
      else if (state.page === 'shop_home' && inside(point, BOXES.shop_search)) {
        state.page = 'search_input'
        state.field = ''
      }
      else if (state.page === 'search_input' && inside(point, BOXES.search_button)) {
        submit()
      }
      else if (state.page === 'results_grid' && state.popup) {
        if (inside(point, BOXES.popup_close))
          state.popup = false
      }
      else if (state.page === 'results_grid') {
        const index = POSITIONS.findIndex(position => inside(point, BOXES[`${position}_card`]))
        const card = visible()[index]
        if (!card)
          return
        if (card.dead)
          return
        state.current = card
        if (card.opensApp) {
          state.app = card.opensApp
          return
        }
        state.page = card.live ? 'live_room' : card.video ? 'video_feed' : 'product_detail'
        state.fromCard = state.page === 'video_feed'
      }
      else if (state.page === 'product_detail' && state.share && inside(point, BOXES.copy_link)) {
        state.clipboard = `https://vt.tiktok.com/ZS${state.current!.id}x/`
        state.overlay = !!options.clipboardOverlay
        state.share = false
      }
      else if (state.page === 'product_detail' && !state.share && inside(point, BOXES.share_icon)) {
        state.share = true
      }
    },
    longPress: async () => {},
    swipe: async () => {
      if (state.page === 'results_grid')
        state.scroll++
    },
    inputText: async (_serial, text) => {
      typed.push(text)
      if (state.page === 'search_input')
        state.field += text
    },
    clearText: async () => {
      state.field = ''
    },
    key: async (_serial, key) => {
      if (key === 'ENTER' && state.page === 'search_input')
        return submit()
      if (key !== 'BACK')
        return
      if (state.share)
        state.share = false
      else if (state.popup)
        state.popup = false
      else if (state.page === 'product_detail' || state.page === 'live_room' || (state.page === 'video_feed' && state.fromCard))
        Object.assign(state, { page: 'results_grid', fromCard: false })
      else if (state.page === 'results_grid' || state.page === 'no_results')
        state.page = 'search_input'
      else if (state.page === 'search_input')
        state.page = 'shop_home'
      else if (state.page === 'shop_home')
        state.page = 'video_feed'
    },
    startApp: async (_serial, pkg, opts) => {
      starts.push({ pkg, restart: opts?.restart })
      Object.assign(state, { app: pkg, page: 'video_feed', fromCard: false, popup: false, share: false, scroll: 0 })
    },
    readClipboard: async () => state.clipboard,
    writeClipboard: async (_serial, text) => {
      state.clipboard = text
    },
    wake: async () => {},
  }

  function submit() {
    state.scroll = 0
    if (options.noResults) {
      state.page = 'no_results'
      return
    }
    state.page = 'results_grid'
    if (options.couponPopup && !state.popupShown) {
      state.popup = true
      state.popupShown = true
    }
  }

  return { state, device, taps, typed, starts, visible }
}

type World = ReturnType<typeof world>

// ---------------------------------------------------------------------------
// Fake Jev answering from the simulated state

interface JevOptions {
  /** Box confidence overrides by question name. */
  boxConfidence?: Record<string, number>
  /** Box edge overrides by question name. */
  boxes?: Record<string, Box>
  /** Visual risk probability by the grey level under the tap (see CARD_SHADES / PAGE_SHADES). */
  riskByShade?: Record<number, number>
}

/** Shade under the red ring of a visual-check crop: the colour at the ring's centroid. */
function ringCentreShade(image: JevImage): number {
  const rgb = decodePng(image.data)!
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = 0; y < rgb.height; y++) {
    for (let x = 0; x < rgb.width; x++) {
      const i = (y * rgb.width + x) * 3
      if (rgb.data[i] === 255 && rgb.data[i + 1] === 0 && rgb.data[i + 2] === 64) {
        sx += x
        sy += y
        n++
      }
    }
  }
  const cx = Math.round(sx / n)
  const cy = Math.round(sy / n)
  return rgb.data[(cy * rgb.width + cx) * 3]
}

function fakeJev(w: World, options: JevOptions = {}) {
  const requests: Array<{ questions: string[] }> = []
  const jev: JevClient = {
    describe: () => ({ model: 'fake-jev', primary: 'http://fake', imagesViaFallback: false }),
    async ask(request) {
      const questions = request.questions as JevQuestions
      requests.push({ questions: Object.keys(questions) })
      const state = request.state as Record<string, any>
      const { state: s } = w
      const answers: Record<string, JevAnswer> = {}
      const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value })
      for (const [name, question] of Object.entries(questions)) {
        if (name === 'risky') {
          answers[name] = noul(options.riskByShade?.[ringCentreShade(state.crop)] ?? 0.05)
          continue
        }
        if (question.type === 'choice') {
          const page = s.app === TIKTOK_PACKAGE ? s.page : 'other_app'
          const keys = Object.keys(question.criteria)
          answers[name] = { type: 'choice', choice: page, confidence: 0.95, probabilities: Object.fromEntries(keys.map(key => [key, key === page ? 0.96 : 0.04 / (keys.length - 1)])) }
          continue
        }
        if (question.type === 'box') {
          answers[name] = { type: 'box', box: options.boxes?.[name] ?? BOXES[name] ?? { top: 0.4, bottom: 0.6, left: 0.4, right: 0.6 }, confidence: options.boxConfidence?.[name] ?? 0.9 }
          continue
        }
        const card = (position: string) => w.visible()[POSITIONS.indexOf(position as typeof POSITIONS[number])]
        const cardMatch = name.match(/^(top_left|top_right|bottom_left|bottom_right)_(price|sold|live|ad)$/)
        if (cardMatch) {
          const c = s.page === 'results_grid' ? card(cardMatch[1]) : undefined
          const flag = cardMatch[2]
          if (s.overlay && cardMatch[1] === 'bottom_left' && (flag === 'price' || flag === 'sold')) {
            answers[name] = noul(0.04)
            continue
          }
          // A "video" card here is a video post: no price, no sold count.
          answers[name] = noul(flag === 'price' || flag === 'sold' ? (c && !c.video ? 0.95 : 0.03) : c?.[flag as 'live' | 'ad'] ? 0.93 : 0.04)
          continue
        }
        const table: Record<string, number> = {
          popup: s.popup ? 0.97 : 0.03,
          share_open: s.share ? 0.99 : 0.01,
          no_results: s.page === 'no_results' ? 0.98 : 0.02,
          field_has_keyword: s.field === state.keyword ? 0.95 : 0.03,
          relevant: 0.9,
          error_screen: 0.02,
        }
        answers[name] = noul(table[name] ?? (name.endsWith('_present') ? 0.95 : 0.1))
      }
      return { answers: answers as never, model: 'fake-jev', usage: { inputTokens: 2600, outputTokens: 30 }, latencyMs: 900, attempts: 1, endpoint: 'primary', images: 1 }
    },
  }
  return { jev, requests }
}

/** Scripted takeover model; every call reports 1000/50 tokens. */
function fakeModel(replies: string[]) {
  const calls: string[] = []
  const client: VisionLlmClient = {
    describe: () => ({ baseUrl: 'http://fake-llm', model: 'fake-vision', apiType: 'chat_completions' }),
    async complete(request) {
      calls.push(request.text)
      const reply = replies.shift()
      if (reply === undefined)
        throw new Error('no scripted reply left')
      return { text: reply, usage: { promptTokens: 1000, completionTokens: 50 }, latencyMs: 5, attempts: 1 }
    },
  }
  return { client, calls }
}

const products = (...ids: string[]): Card[] => ids.map(id => ({ id }))

const resolveLink = async (url: string) => {
  const id = url.match(/ZS(\d+)x/)?.[1]
  return id ? `https://www.tiktok.com/view/product/${id}?utm=share` : undefined
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flow-playbook-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function options(w: World, jev: JevClient, extra: Partial<PlaybookOptions> = {}): PlaybookOptions {
  return {
    serial: 'FAKE01',
    params: { keyword: 'removedor de fiapos', count: 3 },
    device: w.device,
    jev,
    fallback: false,
    resolveLink,
    runDir: path.join(dir, 'run'),
    sleep: async () => {},
    ...extra,
  }
}

const runTikTok = (opts: PlaybookOptions) => runPlaybook('tiktok-shop-links', opts)

// ---------------------------------------------------------------------------

describe('tiktok-shop-links playbook', () => {
  it('collects three product links end to end, closing the coupon popup, with no takeover', async () => {
    const w = world({ grid: products('1730000101', '1730000102', '1730000103', '1730000104', '1730000105'), couponPopup: true })
    const { jev, requests } = fakeJev(w)
    const result = await runTikTok(options(w, jev))
    expect(result.status).toBe('done')
    expect(result.success).toBe(true)
    expect(result.result).toMatchObject({
      keyword: 'removedor de fiapos',
      links: ['https://vt.tiktok.com/ZS1730000101x/', 'https://vt.tiktok.com/ZS1730000102x/', 'https://vt.tiktok.com/ZS1730000103x/'],
      productIds: ['1730000101', '1730000102', '1730000103'],
      noResults: false,
    })
    expect((result.result as any).items[0]).toMatchObject({ position: 'top_left', finalUrl: 'https://www.tiktok.com/view/product/1730000101', relevance: 0.9 })
    expect(result.fallbacks).toBe(0)
    expect(result.modelCalls).toBe(0)
    expect(result.jevCalls).toBeGreaterThanOrEqual(requests.length)
    expect(w.typed).toEqual(['removedor de fiapos'])
    expect(w.starts[0]).toEqual({ pkg: TIKTOK_PACKAGE, restart: true })
    // Every step asks page / popup / share / no-results in the same request as its boxes.
    const observeRequests = requests.filter(request => request.questions.includes('page'))
    expect(observeRequests.every(request => ['popup', 'share_open', 'no_results', 'popup_close'].every(name => request.questions.includes(name)))).toBe(true)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.kind).toBe('playbook')
    expect(report.stepLog[0].jev).toMatchObject({ latencyMs: 900, questions: expect.arrayContaining(['page', 'shop_tab']), answers: { page: { choice: 'video_feed' } } })
    expect(report.questionCatalog.page.type).toBe('choice')
    expect(report.stepLog.some((step: any) => step.actions.some((action: any) => action.target === 'popup close X'))).toBe(true)
    expect(report.status).toBe('done')
  })

  it('returns noResults without any takeover', async () => {
    const w = world({ grid: [], noResults: true })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'pistola massageadora' }, fallback: { client: model.client } }))
    expect(result.success).toBe(true)
    expect(result.result).toMatchObject({ noResults: true, links: [] })
    expect(result.fallbacks).toBe(0)
    expect(model.calls).toHaveLength(0)
  })

  it('skips LIVE and video cards', async () => {
    const w = world({ grid: [{ id: '1730000201', live: true }, { id: '1730000202', video: true }, { id: '1730000203' }, { id: '1730000204' }] })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 2 } }))
    expect(result.success).toBe(true)
    expect((result.result as any).items.map((item: any) => [item.position, item.productId])).toEqual([['bottom_left', '1730000203'], ['bottom_right', '1730000204']])
    // The LIVE / video cards were never tapped.
    expect(w.taps.some(point => inside(point, BOXES.top_left_card) || inside(point, BOXES.top_right_card))).toBe(false)
  })

  it('mirrors the left card of the row when a right-column box comes back wrong', async () => {
    const w = world({ grid: [{ id: '1730000801', live: true }, { id: '1730000802' }] })
    const { jev } = fakeJev(w, { boxes: { top_right_card: { top: 0.2, bottom: 0.47, left: 0.01, right: 0.98 } }, boxConfidence: { top_right_card: 0.2 } })
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.success).toBe(true)
    expect(result.fallbacks).toBe(0)
    expect((result.result as any).items[0]).toMatchObject({ position: 'top_right', productId: '1730000802' })
    const cardTap = w.taps.find(point => inside(point, BOXES.top_right_card))!
    expect(cardTap.x).toBeCloseTo(0.75, 2)
  })

  it('moves on to the next card when a card tap opens nothing (no crash on missing card answers)', async () => {
    const w = world({ grid: [{ id: '1730000901', dead: true }, { id: '1730000902' }] })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('done')
    expect((result.result as any).items[0]).toMatchObject({ position: 'top_right', productId: '1730000902' })
  })

  it('keeps grid order when the clipboard preview hides the bottom-left price after a copy', async () => {
    const w = world({ grid: products('1730000961', '1730000962', '1730000963', '1730000964'), clipboardOverlay: true })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev))
    expect(result.success).toBe(true)
    expect((result.result as any).items.map((item: any) => item.position)).toEqual(['top_left', 'top_right', 'bottom_left'])
  })

  it('does not count a product it already copied', async () => {
    const w = world({ grid: products('1730000301', '1730000301', '1730000302', '1730000303') })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev))
    expect(result.success).toBe(true)
    expect((result.result as any).productIds).toEqual(['1730000301', '1730000302', '1730000303'])
    expect((result.result as any).duplicates).toEqual(['1730000301'])
  })

  it('hands a low-confidence step to the vision agent, then continues; the takeover cannot change the keyword', async () => {
    const w = world({ grid: products('1730000401', '1730000402') })
    const { jev } = fakeJev(w, { boxConfidence: { share_icon: 0.1 } })
    const model = fakeModel([
      '{"thought":"type something","action":{"type":"input_text","text":"other words"}}',
      '{"thought":"open share","action":{"type":"tap","x":735,"y":80}}',
      '{"thought":"panel open","action":{"type":"done","success":true,"result":{}}}',
    ])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(1)
    expect(result.fallbackFailures).toBe(0)
    expect(result.modelCalls).toBe(3)
    expect(result.tokens).toEqual({ prompt: 3000, completion: 150, total: 3150 })
    expect((result.result as any).productIds).toEqual(['1730000401'])
    expect(w.typed).toEqual(['k'])
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const takeover = report.stepLog.find((step: any) => step.fallback)
    expect(takeover.fallback).toMatchObject({ status: 'done', success: true, modelCalls: 3, verified: true })
    const takeoverReport = JSON.parse(await readFile(takeover.fallback.reportPath, 'utf8'))
    expect(takeoverReport.options.maxSteps).toBeLessThanOrEqual(6)
    expect(takeoverReport.stepLog[0].execution.error).toMatch(/refused to type/)
  })

  it('fails after two takeovers in a row do not reach their step', async () => {
    const w = world({ grid: products('1730000501') })
    const { jev } = fakeJev(w, { boxConfidence: { share_icon: 0.1 } })
    const model = fakeModel(Array.from({ length: 4 }).fill('{"action":{"type":"fail","reason":"cannot find it"}}'))
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/two takeovers in a row/)
    expect(result.fallbacks).toBe(2)
    expect(result.fallbackFailures).toBe(2)
  })

  it('relaunches TikTok again when a cold start drops back to the launcher, without using the recovery', async () => {
    const w = world({ grid: products('1730000951') })
    const startApp = w.device.startApp
    let launches = 0
    w.device.startApp = async (serial, pkg, opts) => {
      await startApp(serial, pkg, opts)
      if (++launches <= 2)
        w.state.app = 'com.google.android.apps.nexuslauncher'
    }
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('done')
    expect(launches).toBe(3)
  })

  it('stops with guardrail when a tap keeps leaving TikTok', async () => {
    const w = world({ grid: [{ id: '1730000601', opensApp: 'com.shopee.br' }, { id: '1730000602', opensApp: 'com.shopee.br' }] })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('guardrail')
    expect(result.reason).toMatch(/com\.shopee\.br/)
    // The initial restart plus exactly one recovery.
    expect(w.starts.map(start => start.pkg)).toEqual([TIKTOK_PACKAGE, TIKTOK_PACKAGE])
  })

  it('refuses a tap the visual check flags and moves on to the next card', async () => {
    const w = world({ grid: products('1730000701', '1730000702') })
    const { jev } = fakeJev(w, { riskByShade: { [CARD_SHADES[0]]: 0.92 } })
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.success).toBe(true)
    expect(result.visualGuardBlocks).toBe(1)
    expect((result.result as any).items[0]).toMatchObject({ position: 'top_right', productId: '1730000702' })
    expect(w.taps.some(point => inside(point, BOXES.top_left_card))).toBe(false)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const blocked = report.stepLog.flatMap((step: any) => step.actions).find((action: any) => action.blocked)
    expect(blocked).toMatchObject({ target: 'top_left card', visualCheck: { probability: 0.92 } })
  })

  it('stops following redirects at the product URL (the product page itself redirects to /login)', async () => {
    const hops: Record<string, string> = {
      'https://vt.tiktok.com/ZSabc/': 'https://www.tiktok.com/view/product/1735031026643470004?_d=x',
      'https://www.tiktok.com/view/product/1735031026643470004?_d=x': 'https://www.tiktok.com/login',
    }
    vi.stubGlobal('fetch', async (url: string) => new Response(null, { status: hops[url] ? 301 : 200, headers: hops[url] ? { location: hops[url] } : {} }))
    try {
      expect(await resolveRedirects('https://vt.tiktok.com/ZSabc/', /\/product\/\d{6,}/)).toBe('https://www.tiktok.com/view/product/1735031026643470004?_d=x')
      expect(await resolveRedirects('https://vt.tiktok.com/ZSabc/')).toBe('https://www.tiktok.com/login')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('extracts product ids from canonical links', () => {
    expect(productIdFromUrl('https://www.tiktok.com/view/product/1735758438214894952?x=1')).toBe('1735758438214894952')
    expect(productIdFromUrl('https://vt.tiktok.com/ZS9yg/')).toBeUndefined()
  })
})
