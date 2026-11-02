import type { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodePng, encodePng, parseUiTree } from '@escrcpy/flow-device'
import type { ForegroundApp, RatioPoint, UiTree } from '@escrcpy/flow-device'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertItemsResolved, CONSENT_NEEDS_HUMAN, HopFetchError, productIdFromUrl, resolveLinkDetailed, resolveRedirects, runPlaybook, TIKTOK_PACKAGE, tiktokShopLinksParams } from '../src/index.js'
import type { HopFetcher, HopResponse, JevAnswer, JevClient, JevImage, JevQuestions, PlaybookDefinition, PlaybookOptions, VisionAgentDevice, VisionLlmClient } from '../src/index.js'

// ---------------------------------------------------------------------------
// A tiny simulated TikTok

type Page = 'video_feed' | 'shop_home' | 'search_input' | 'results_grid' | 'no_results' | 'product_detail' | 'live_room'

interface Card {
  id: string
  live?: boolean
  video?: boolean
  ad?: boolean
  opensApp?: string
  /** The tap does nothing (grid still loading). */
  dead?: boolean
  /** Opens as a video with the product in a half sheet (TikTok 46.5 DetailActivity). */
  sheet?: boolean
  /** A video card that still shows a price (so the playbook opens it). */
  priced?: boolean
  /** A LIVE card whose badge Jev misses (`once`: only until it was opened) and that opens a LIVE room. */
  liveHidden?: 'once' | 'always'
}

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
/** Where the half sheet's icons really are (Pixel 5a, TikTok 46.5.3): Share ≈0.71, cart ≈0.825. */
const SHEET_ICONS = {
  share: { top: 0.285, bottom: 0.315, left: 0.69, right: 0.735 },
  cart: { top: 0.285, bottom: 0.315, left: 0.8, right: 0.85 },
}
const SHARE_SHADE = 230
const CART_SHADE = 250
const ACTIVITY = {
  home: 'com.ss.android.ugc.aweme.splash.SplashActivity',
  detail: 'com.ss.android.ugc.aweme.detail.ui.DetailActivity',
  search: 'com.ss.android.ugc.aweme.ecommerce.search.page.EcSearchActivity',
  pdp: 'com.ss.android.ugc.aweme.ecommerce.base.pdp.sea.ui.SeaPdpActivity',
  live: 'com.ss.android.ugc.aweme.live.LivePlayActivity',
}
const LAUNCHER = 'com.google.android.apps.nexuslauncher'
const POSITIONS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
/** Grey level painted under each grid card, so a crop's ring centre tells which card a tap targets. */
const CARD_SHADES = [60, 80, 100, 120]
const PAGE_SHADES: Record<Page, number> = { video_feed: 30, shop_home: 140, search_input: 160, results_grid: 40, no_results: 180, product_detail: 200, live_room: 220 }
const W = 300
const H = 600

const inside = (point: RatioPoint, box: Box) => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom

/** UI tree of TikTok's policy update dialog (text as on device), or of a screen without one. */
function consentTree(shown: boolean): UiTree {
  const node = (text: string, bounds: string, clickable = false) => `<node class="android.widget.TextView" package="${TIKTOK_PACKAGE}" text="${text}" content-desc="" resource-id="" clickable="${clickable}" bounds="${bounds}" />`
  const dialog = shown
    ? node('Virtual Items and Rewards Policies update', '[80,700][1000,800]')
    + node('By continuing to use TikTok after that date, you agree to these policies.', '[80,820][1000,1200]')
    + node('Got it', '[80,1250][1000,1350]', true)
    : ''
  return parseUiTree(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="${TIKTOK_PACKAGE}" text="" content-desc="" resource-id="" clickable="false" bounds="[0,0][1080,2400]">${dialog}</node></hierarchy>`)
}

interface WorldOptions {
  grid: Card[]
  noResults?: boolean
  couponPopup?: boolean
  /** After a copy, Android's clipboard preview hides the bottom-left card's price (seen on device). */
  clipboardOverlay?: boolean
  /** Every Copy link yields a new short link, as on real TikTok (default: one fixed link per product). */
  uniqueLinks?: boolean
  /** BACK does not leave the LIVE room (a dialog without an X in front of it). */
  liveStuck?: boolean
  /** Observations of a black, still-loading LIVE room after a card opens one; BACK is swallowed meanwhile. */
  liveLoading?: number
  /** A terms / policy notice: named in the UI tree or only visible to Jev; shown on the results grid or at every launch. */
  consent?: { via: 'tree' | 'jev', when: 'results' | 'launch', clearsOnBack?: boolean }
  /** Physical half-sheet icons (default SHEET_ICONS). */
  sheetIcons?: { share: Box, cart: Box }
  /** Observations that show a blank, still-loading screen after each (re)launch. */
  loadingScreens?: number
  /** `am force-stop` right after the nth tap of this kind. */
  forceStopAfter?: { tap: 'card' | 'share', nth: number }
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
    sheet: false,
    /** On a video reached by BACK from a product (DetailActivity), not the home feed. */
    fromProduct: false,
    loading: 0,
    /** The last screenshot was a blank loading screen (Jev answers about it). */
    loadingShown: false,
    consent: false,
    consentShown: false,
    liveLoading: 0,
  }
  const sheetIcons = options.sheetIcons ?? SHEET_ICONS
  /** Page at every BACK, and how often BACK hit the home feed / the sheet's cart was tapped. */
  const backs: string[] = []
  /** liveTaps / consentTouches: touches that must never happen (inside a LIVE room, on a consent notice). */
  const counts = { homeBacks: 0, cartTaps: 0, card: 0, share: 0, liveTaps: 0, consentTouches: 0, restarts: 0 }
  const liveSeen = new Set<string>()
  const isHomeFeed = () => state.app === TIKTOK_PACKAGE && state.page === 'video_feed' && !state.fromCard && !state.fromProduct
  const activity = () => {
    if (state.app !== TIKTOK_PACKAGE)
      return `${state.app}.Main`
    switch (state.page) {
      case 'video_feed': return isHomeFeed() ? ACTIVITY.home : ACTIVITY.detail
      case 'shop_home': return ACTIVITY.home
      case 'product_detail': return state.sheet ? ACTIVITY.detail : ACTIVITY.pdp
      case 'live_room': return ACTIVITY.live
      default: return ACTIVITY.search
    }
  }
  const forceStop = () => Object.assign(state, { app: LAUNCHER, page: 'video_feed', fromCard: false, fromProduct: false, popup: false, share: false, sheet: false, scroll: 0 })
  const fault = (kind: 'card' | 'share') => {
    counts[kind]++
    if (options.forceStopAfter?.tap === kind && options.forceStopAfter.nth === counts[kind])
      forceStop()
  }
  const taps: RatioPoint[] = []
  let copies = 0
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
    if (state.page === 'product_detail' && state.sheet) {
      for (const [box, shade] of [[sheetIcons.share, SHARE_SHADE], [sheetIcons.cart, CART_SHADE]] as const) {
        for (let y = Math.round(box.top * H); y < Math.round(box.bottom * H); y++)
          data.fill(shade, (y * W + Math.round(box.left * W)) * 3, (y * W + Math.round(box.right * W)) * 3)
      }
    }
    return encodePng({ width: W, height: H, data })
  }

  const device: VisionAgentDevice = {
    screencap: async () => {
      state.loadingShown = state.app === TIKTOK_PACKAGE && (state.loading > 0 || (state.page === 'live_room' && state.liveLoading > 0))
      if (state.page === 'live_room' && state.liveLoading > 0)
        state.liveLoading--
      if (state.loading > 0)
        state.loading--
      return screen()
    },
    foregroundApp: async (): Promise<ForegroundApp> => ({ package: state.app, activity: activity() }),
    tap: async (_serial, point) => {
      taps.push(point)
      if (state.app !== TIKTOK_PACKAGE)
        return
      if (state.consent) {
        // Any touch on the notice (its button or the dimmed area) would confirm it.
        counts.consentTouches++
        state.consent = false
        return
      }
      if (state.page === 'live_room') {
        counts.liveTaps++
        return
      }
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
        state.page = card.live || card.liveHidden ? 'live_room' : card.video ? 'video_feed' : 'product_detail'
        if (card.liveHidden)
          liveSeen.add(card.id)
        if (state.page === 'live_room')
          state.liveLoading = options.liveLoading ?? 0
        state.fromCard = state.page === 'video_feed'
        state.sheet = !!card.sheet
        fault('card')
      }
      else if (state.page === 'product_detail' && state.share && inside(point, BOXES.copy_link)) {
        copies++
        state.clipboard = `https://vt.tiktok.com/ZS${state.current!.id}x${options.uniqueLinks ? `-${copies}` : ''}/`
        state.overlay = !!options.clipboardOverlay
        state.share = false
      }
      else if (state.page === 'product_detail' && state.sheet && !state.share) {
        if (inside(point, sheetIcons.cart))
          counts.cartTaps++
        if (inside(point, sheetIcons.share)) {
          state.share = true
          fault('share')
        }
      }
      else if (state.page === 'product_detail' && !state.share && inside(point, BOXES.share_icon)) {
        state.share = true
        fault('share')
      }
    },
    longPress: async () => {},
    swipe: async () => {
      if (state.consent)
        counts.consentTouches++
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
      backs.push(state.app === TIKTOK_PACKAGE ? state.page : state.app)
      if (isHomeFeed()) {
        // One BACK from the home feed leaves TikTok.
        counts.homeBacks++
        state.app = LAUNCHER
        return
      }
      if (state.consent) {
        if (options.consent?.clearsOnBack)
          state.consent = false
        return
      }
      if (state.page === 'live_room' && (options.liveStuck || state.loadingShown))
        return
      if (state.share)
        state.share = false
      else if (state.popup)
        state.popup = false
      else if (state.page === 'product_detail' && state.sheet)
        Object.assign(state, { page: 'video_feed', sheet: false, fromProduct: true })
      else if (state.page === 'product_detail' || state.page === 'live_room' || (state.page === 'video_feed' && (state.fromCard || state.fromProduct)))
        Object.assign(state, { page: 'results_grid', fromCard: false, fromProduct: false })
      else if (state.page === 'results_grid' || state.page === 'no_results')
        state.page = 'search_input'
      else if (state.page === 'search_input')
        state.page = 'shop_home'
      else if (state.page === 'shop_home')
        state.page = 'video_feed'
    },
    startApp: async (_serial, pkg, opts) => {
      starts.push({ pkg, restart: opts?.restart })
      if (opts?.restart)
        counts.restarts++
      Object.assign(state, { app: pkg, page: 'video_feed', fromCard: false, fromProduct: false, popup: false, share: false, sheet: false, scroll: 0, loading: options.loadingScreens ?? 0 })
      // An account-level notice pops up again at every launch.
      state.consent = options.consent?.when === 'launch'
    },
    ...(options.consent?.via === 'tree' ? { uiTree: async () => consentTree(state.consent) } : {}),
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
    if (options.consent?.when === 'results' && !state.consentShown) {
      state.consent = true
      state.consentShown = true
    }
    if (options.couponPopup && !state.popupShown) {
      state.popup = true
      state.popupShown = true
    }
  }

  return { state, device, taps, typed, starts, visible, backs, counts, liveSeen, consentVia: options.consent?.via }
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
          answers[name] = noul({ [CART_SHADE]: 0.97, ...options.riskByShade }[ringCentreShade(state.crop)] ?? 0.05)
          continue
        }
        if (name === 'confirm') {
          answers[name] = noul(ringCentreShade(state.crop) === SHARE_SHADE ? 0.95 : 0.05)
          continue
        }
        if (question.type === 'choice') {
          const page = s.app !== TIKTOK_PACKAGE ? 'other_app' : s.loadingShown ? 'other' : s.page
          const keys = Object.keys(question.criteria)
          answers[name] = { type: 'choice', choice: page, confidence: 0.95, probabilities: Object.fromEntries(keys.map(key => [key, key === page ? 0.96 : 0.04 / (keys.length - 1)])) }
          continue
        }
        if (question.type === 'box') {
          const sheetBox = name === 'sheet_share_icon' ? SHEET_ICONS.share : name === 'sheet_cart_icon' ? SHEET_ICONS.cart : undefined
          answers[name] = { type: 'box', box: options.boxes?.[name] ?? sheetBox ?? BOXES[name] ?? { top: 0.4, bottom: 0.6, left: 0.4, right: 0.6 }, confidence: options.boxConfidence?.[name] ?? 0.9 }
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
          const live = !!c?.live || (c?.liveHidden === 'once' && w.liveSeen.has(c.id))
          answers[name] = noul(flag === 'price' || flag === 'sold' ? (c && (!c.video || c.priced) ? 0.95 : 0.03) : flag === 'live' ? (live ? 0.93 : 0.04) : c?.ad ? 0.93 : 0.04)
          continue
        }
        const table: Record<string, number> = {
          // A consent notice also looks like a popup with a close button: the playbook must still not touch it.
          popup: s.popup || s.consent ? 0.97 : 0.03,
          consent_dialog: s.consent && w.consentVia === 'jev' ? 0.97 : 0.02,
          share_open: s.share ? 0.99 : 0.01,
          no_results: s.page === 'no_results' ? 0.98 : 0.02,
          field_has_keyword: s.field === state.keyword ? 0.95 : 0.03,
          relevant: 0.9,
          error_screen: 0.02,
          home_feed: s.app === TIKTOK_PACKAGE && s.page === 'video_feed' && !s.fromCard && !s.fromProduct ? 0.97 : 0.02,
          product_sheet: s.page === 'product_detail' && s.sheet ? 0.9 : 0.03,
          loading: s.loadingShown ? 0.95 : 0.02,
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

/** Scripted hop fetcher: short link `ZS<id>x` → 301 to the product URL, unless a scripted failure for that id comes first. */
type HopOutcome = 'timeout' | 'reset' | 429 | 503 | 200
function scriptedHops(script: Record<string, HopOutcome[]> = {}) {
  const calls: string[] = []
  const fetchHop: HopFetcher = async (url): Promise<HopResponse> => {
    calls.push(url)
    const id = url.match(/ZS(\d+)x/)?.[1]
    const next = id ? script[id]?.shift() : undefined
    if (next === 'timeout')
      throw new HopFetchError('timeout', 'timeout')
    if (next === 'reset')
      throw new HopFetchError('network', 'ECONNRESET')
    if (typeof next === 'number')
      return { status: next }
    return id ? { status: 301, location: `https://www.tiktok.com/view/product/${id}?user_id=42&device_id=7` } : { status: 302, location: 'https://www.tiktok.com/login' }
  }
  return { fetchHop, calls }
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
const tiktokParams = tiktokShopLinksParams

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

  it('taps the Share icon of the video + product half sheet (DetailActivity) without a takeover', async () => {
    const w = world({ grid: [{ id: '1737660200969930116', sheet: true }, { id: '1730001002' }] })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'massageador tens', count: 2 }, fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(model.calls).toHaveLength(0)
    expect((result.result as any).items.map((item: any) => [item.productId, item.sheet ?? false])).toEqual([['1737660200969930116', true], ['1730001002', false]])
    expect(w.counts.cartTaps).toBe(0)
    expect(w.counts.homeBacks).toBe(0)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const sheetTap = report.stepLog.flatMap((step: any) => step.actions).find((action: any) => action.target === 'sheet Share icon')
    // The visual check runs on the sheet even though nothing is unlabeled, and confirms the Share arrow.
    expect(sheetTap).toMatchObject({ visualCheck: { confirmed: 0.95, reason: 'required for this target' } })
    expect(sheetTap.blocked).toBeUndefined()
    expect(report.stepLog.some((step: any) => /half sheet/.test(step.decision ?? ''))).toBe(true)
    // The PDP top-bar Share rule was not used on the sheet.
    expect(report.stepLog.flatMap((step: any) => step.actions).filter((action: any) => action.target === 'Share icon')).toHaveLength(1)
  })

  it('refuses a sheet Share box that lands on the cart and taps the icon to its left', async () => {
    // Jev's Share box sits on the cart and its cart box is unusable: the cart tap is refused by the
    // visual check (p=0.97) and the playbook moves one icon left, onto Share.
    const w = world({ grid: [{ id: '1730001101', sheet: true }], sheetIcons: { share: { top: 0.285, bottom: 0.315, left: 0.62, right: 0.7 }, cart: { top: 0.285, bottom: 0.315, left: 0.74, right: 0.86 } } })
    const { jev } = fakeJev(w, { boxes: { sheet_share_icon: { top: 0.285, bottom: 0.315, left: 0.77, right: 0.79 } }, boxConfidence: { sheet_cart_icon: 0.05 } })
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(result.visualGuardBlocks).toBe(1)
    expect(w.counts.cartTaps).toBe(0)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const sheetTaps = report.stepLog.flatMap((step: any) => step.actions).filter((action: any) => action.target === 'sheet Share icon')
    expect(sheetTaps[0]).toMatchObject({ ratio: { x: 0.78 }, blocked: expect.stringMatching(/social \/ purchase/) })
    expect(sheetTaps[1].ratio.x).toBeCloseTo(0.67, 2)
    expect(sheetTaps[1].blocked).toBeUndefined()
  })

  it('after a force-stop on the product page, searches again from the home feed without BACK or a takeover', async () => {
    const w = world({ grid: products('1730001201', '1730001202', '1730001203', '1730001204'), forceStopAfter: { tap: 'share', nth: 2 } })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(w.counts.homeBacks).toBe(0)
    // No BACK at all on any video page: the home feed is re-located, not backed out of.
    expect(w.backs.filter(page => page === 'video_feed')).toEqual([])
    const res = result.result as any
    expect(res.productIds).toEqual(['1730001201', '1730001202', '1730001203'])
    expect(res).toMatchObject({ researched: true, searchEpochs: 2 })
    expect(res.items.map((item: any) => item.searchEpoch)).toEqual([1, 2, 2])
    expect(res.duplicates).toEqual(['1730001201'])
    expect(w.starts).toEqual([{ pkg: TIKTOK_PACKAGE, restart: true }, { pkg: TIKTOK_PACKAGE, restart: undefined }])
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.stepLog.some((step: any) => /TikTok was relaunched: re-locate to reach_search/.test(step.decision ?? ''))).toBe(true)
  })

  it('after a force-stop right after a card tap, also searches again without BACK', async () => {
    const w = world({ grid: products('1730001301', '1730001302', '1730001303'), forceStopAfter: { tap: 'card', nth: 2 } })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 2 } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(w.counts.homeBacks).toBe(0)
    expect(result.result).toMatchObject({ productIds: ['1730001301', '1730001302'], researched: true, searchEpochs: 2 })
  })

  it('skips a card that opened a video with exactly one BACK', async () => {
    const w = world({ grid: [{ id: '1730001401', video: true, priced: true }, { id: '1730001402' }] })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('done')
    expect(w.backs.filter(page => page === 'video_feed')).toHaveLength(1)
    expect(w.counts.homeBacks).toBe(0)
    expect(result.result).toMatchObject({ researched: false, searchEpochs: 1 })
  })

  it('waits out the blank screen of a cold start instead of handing it to a takeover', async () => {
    const w = world({ grid: products('1730001501'), loadingScreens: 2 })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.stepLog.filter((step: any) => /still loading/.test(step.decision ?? ''))).toHaveLength(2)
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
    const fetchHop: HopFetcher = async url => hops[url] ? { status: 301, location: hops[url] } : { status: 200 }
    expect(await resolveRedirects('https://vt.tiktok.com/ZSabc/', /\/product\/\d{6,}/, { fetchHop })).toBe('https://www.tiktok.com/view/product/1735031026643470004?_d=x')
    expect(await resolveRedirects('https://vt.tiktok.com/ZSabc/', undefined, { fetchHop })).toBe('https://www.tiktok.com/login')
  })

  it('resolver: retries a timeout, a reset, 429 and 5xx with backoff and returns as soon as the product URL shows', async () => {
    const PRODUCT = /\/product\/(\d{6,})/
    const sleeps: number[] = []
    const sleep = async (ms: number) => void sleeps.push(ms)
    const t = 0
    const now = () => t
    const ok = await resolveLinkDetailed('https://vt.tiktok.com/ZS1730002001x/', { stopAt: PRODUCT, ...scriptedHops({ 1730002001: ['timeout', 429, 'reset'] }), sleep, now })
    expect(ok).toMatchObject({ matched: true, attempts: 4, url: 'https://www.tiktok.com/view/product/1730002001?user_id=42&device_id=7' })
    expect(sleeps).toEqual([500, 1000, 2000])
    expect(ok.hops.map(hop => hop.error ?? hop.status)).toEqual(['timeout', 'status', 'network', 301])
    expect(ok.hops[2]).toMatchObject({ code: 'ECONNRESET' })
    // Diagnostics never carry query strings (product URLs hold user / device identifiers).
    expect(JSON.stringify(ok.hops)).not.toMatch(/user_id|device_id/)
    expect(ok.hops.at(-1)!.to).toBe('https://www.tiktok.com/view/product/1730002001')

    const failed = await resolveLinkDetailed('https://vt.tiktok.com/ZS1730002002x/', { stopAt: PRODUCT, ...scriptedHops({ 1730002002: [503, 503, 503, 503] }), sleep, now })
    expect(failed).toMatchObject({ matched: false, attempts: 4 })
    expect(failed.reason).toMatch(/status 503 .*after 4 attempts/)

    // A 200 / 4xx without a redirect is not retried.
    const notRetried = await resolveLinkDetailed('https://vt.tiktok.com/ZS1730002003x/', { stopAt: PRODUCT, ...scriptedHops({ 1730002003: [200] }), sleep, now })
    expect(notRetried).toMatchObject({ matched: false, attempts: 1, reason: expect.stringMatching(/status 200 without a redirect/) })
  })

  it('resolver: stays within the total time budget', async () => {
    let t = 0
    const timeouts: number[] = []
    // Like the real fetcher, a hop never runs past the timeout it is given (what is left of the budget).
    const slow: HopFetcher = async (_url, timeoutMs) => {
      timeouts.push(timeoutMs)
      t += Math.min(8000, timeoutMs)
      throw new HopFetchError('timeout', 'timeout')
    }
    const resolution = await resolveLinkDetailed('https://vt.tiktok.com/ZS1x/', { stopAt: /\/product\/\d+/, fetchHop: slow, now: () => t, sleep: async ms => void (t += ms), totalBudgetMs: 20_000 })
    expect(resolution.matched).toBe(false)
    expect(resolution.attempts).toBe(3)
    expect(timeouts).toEqual([8000, 8000, 2500])
    expect(t).toBeLessThanOrEqual(20_000)
  })

  it('counts a link whose first resolve times out once the retry resolves it, and records the attempts', async () => {
    const w = world({ grid: products('1730002101', '1730002102', '1730002103') })
    const { jev } = fakeJev(w)
    const hops = scriptedHops({ 1730002101: ['timeout'], 1730002102: [429] })
    const result = await runTikTok(options(w, jev, { resolveLink: undefined, fetchHop: hops.fetchHop }))
    expect(result.status).toBe('done')
    const res = result.result as any
    expect(res.productIds).toEqual(['1730002101', '1730002102', '1730002103'])
    expect(res.unresolved).toEqual([])
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const resolves = report.stepLog.flatMap((step: any) => step.actions).filter((action: any) => action.type === 'resolve_link')
    expect(resolves.map((action: any) => [action.ok, action.attempts])).toEqual([[true, 2], [true, 2], [true, 1]])
    expect(resolves[0].hops[0]).toMatchObject({ attempt: 1, error: 'timeout' })
    expect(JSON.stringify(report)).not.toMatch(/user_id=|device_id=/)
  })

  it('does not count a link that never resolves: it goes to unresolved and the next card is taken', async () => {
    const w = world({ grid: products('1730002201', '1730002202', '1730002203', '1730002204') })
    const { jev } = fakeJev(w)
    const hops = scriptedHops({ 1730002201: ['reset', 'reset', 'reset', 'reset'] })
    const result = await runTikTok(options(w, jev, { resolveLink: undefined, fetchHop: hops.fetchHop }))
    expect(result.status).toBe('done')
    const res = result.result as any
    expect(res.productIds).toEqual(['1730002202', '1730002203', '1730002204'])
    expect(res.items.map((item: any) => item.position)).toEqual(['top_right', 'bottom_left', 'bottom_right'])
    expect(res.items.every((item: any) => item.productId && item.finalUrl === `https://www.tiktok.com/view/product/${item.productId}`)).toBe(true)
    expect(res.links).toHaveLength(res.productIds.length)
    expect(res.unresolved).toEqual([{ link: 'https://vt.tiktok.com/ZS1730002201x/', position: 'top_left', searchEpoch: 1, reason: expect.stringMatching(/ECONNRESET.*after 4 attempts/) }])
  })

  it('does not report success when links keep failing until the cards run out', async () => {
    const w = world({ grid: products('1730002301', '1730002302') })
    const { jev } = fakeJev(w)
    const fail = Array.from({ length: 4 }).fill('reset') as HopOutcome[]
    const hops = scriptedHops({ 1730002301: [...fail], 1730002302: [...fail] })
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 2, maxScrolls: 0 }, resolveLink: undefined, fetchHop: hops.fetchHop }))
    expect(result.success).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/no product cards|only 0 of 2/)
    const res = result.result as any
    expect(res.items).toEqual([])
    expect(res.productIds).toEqual([])
    expect(res.unresolved.map((entry: any) => entry.position)).toEqual(['top_left', 'top_right'])
  })

  it('deduplicates by product ID when a product that once failed to resolve resolves later', async () => {
    const w = world({ grid: products('1730002401', '1730002401', '1730002402', '1730002403'), uniqueLinks: true })
    const { jev } = fakeJev(w)
    const hops = scriptedHops({ 1730002401: ['reset', 'reset', 'reset', 'reset'] })
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 2 }, resolveLink: undefined, fetchHop: hops.fetchHop }))
    expect(result.status).toBe('done')
    const res = result.result as any
    // The second copy of 1730002401 resolves and counts once; the failed first copy stays in unresolved only.
    expect(res.productIds).toEqual(['1730002401', '1730002402'])
    expect(res.unresolved).toHaveLength(1)
  })

  it('asserts that every counted item has a product ID and product URL', () => {
    expect(() => assertItemsResolved([{ link: 'https://vt.tiktok.com/ZSx/', productId: '', finalUrl: '', position: 'top_left', ad: false, searchEpoch: 1 } as any])).toThrow(/invariant violated/)
    expect(() => assertItemsResolved([{ link: 'l', productId: '1730002501', finalUrl: 'https://www.tiktok.com/view/product/1730002502', position: 'top_left', ad: false, searchEpoch: 1 }])).toThrow(/invariant violated/)
    expect(() => assertItemsResolved([{ link: 'l', productId: '1730002501', finalUrl: 'https://www.tiktok.com/view/product/1730002501', position: 'top_left', ad: false, searchEpoch: 1 }])).not.toThrow()
  })

  it('leaves a LIVE room opened by a card with one BACK, touches nothing in it, and takes the next card', async () => {
    const w = world({ grid: [{ id: '1730003001', liveHidden: 'always' }, { id: '1730003002' }] })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(w.counts.liveTaps).toBe(0)
    expect(w.backs.filter(page => page === 'live_room')).toHaveLength(1)
    const res = result.result as any
    expect(res).toMatchObject({ liveRoomEntries: 1, researched: false, productIds: ['1730003002'] })
    expect(res.items[0].position).toBe('top_right')
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.stepLog.some((step: any) => /top_left card opened a LIVE room: marked LIVE/.test(step.decision ?? ''))).toBe(true)
    expect(report.stepLog.some((step: any) => /top_left\(opened a LIVE room\)/.test(step.decision ?? ''))).toBe(true)
  })

  it('waits for a LIVE room that is still loading before its BACK, so no relaunch is needed', async () => {
    const w = world({ grid: [{ id: '1730003051', liveHidden: 'always' }, { id: '1730003052' }], liveLoading: 1 })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('done')
    expect(w.counts.liveTaps).toBe(0)
    expect(w.counts.restarts).toBe(1)
    expect(result.result).toMatchObject({ liveRoomEntries: 1, researched: false, productIds: ['1730003052'] })
  })

  it('force-stops and relaunches when BACK does not leave the LIVE room, then searches again', async () => {
    const w = world({ grid: [{ id: '1730003101', liveHidden: 'once' }, { id: '1730003102' }], liveStuck: true })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('done')
    expect(result.fallbacks).toBe(0)
    expect(w.counts.liveTaps).toBe(0)
    // The initial restart plus one for the LIVE room; no takeover was asked to close its dialog.
    expect(w.counts.restarts).toBe(2)
    expect(w.counts.homeBacks).toBe(0)
    expect(result.result).toMatchObject({ liveRoomEntries: 1, researched: true, searchEpochs: 2, productIds: ['1730003102'] })
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.stepLog.flatMap((step: any) => step.actions).filter((action: any) => action.type === 'restart_app')).toHaveLength(1)
  })

  it('stops as failed on the third LIVE room of a run instead of looping', async () => {
    const w = world({ grid: [{ id: '1730003201', liveHidden: 'always' }, { id: '1730003202' }], liveStuck: true })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 } }))
    expect(result.status).toBe('failed')
    expect(result.success).toBe(false)
    expect(result.reason).toMatch(/LIVE room 3 times/)
    expect(w.counts.liveTaps).toBe(0)
    expect(result.result).toMatchObject({ liveRoomEntries: 3, items: [] })
  })

  it('does not touch a consent notice found in the UI tree (not even the popup X): BACK closes it and the run goes on', async () => {
    const w = world({ grid: products('1730003301', '1730003302'), consent: { via: 'tree', when: 'results', clearsOnBack: true } })
    const { jev } = fakeJev(w)
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 2 } }))
    expect(result.status).toBe('done')
    expect(w.counts.consentTouches).toBe(0)
    expect(result.result).toMatchObject({ productIds: ['1730003301', '1730003302'] })
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    const flagged = report.stepLog.find((step: any) => step.consent)
    expect(flagged.consent).toMatchObject({ present: true, source: 'tree', term: 'agree' })
    expect(flagged.actions).toEqual([expect.objectContaining({ type: 'key', key: 'BACK' })])
  })

  it('stops with consent_dialog_needs_human when a notice seen only by Jev is back after BACK and a relaunch', async () => {
    const w = world({ grid: products('1730003401'), consent: { via: 'jev', when: 'launch' } })
    const { jev } = fakeJev(w)
    const model = fakeModel([])
    const result = await runTikTok(options(w, jev, { params: { keyword: 'k', count: 1 }, fallback: { client: model.client } }))
    expect(result.status).toBe('failed')
    expect(result.success).toBe(false)
    expect(result.reason.startsWith(CONSENT_NEEDS_HUMAN)).toBe(true)
    expect(result.consent).toMatchObject({ present: true, source: 'jev', screenshot: expect.stringMatching(/^step-\d{3}\.(jpg|png)$/) })
    expect(w.counts.consentTouches).toBe(0)
    expect(w.counts.restarts).toBe(2)
    expect(model.calls).toHaveLength(0)
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8'))
    expect(report.consent.screenshot).toBe(result.consent!.screenshot)
    expect(report.status).toBe('failed')
  })

  it('runtime: refuses every tap and swipe while a consent notice is on screen, whatever the playbook asks', async () => {
    const w = world({ grid: [], consent: { via: 'jev', when: 'launch' } })
    const { jev } = fakeJev(w)
    const attempts: boolean[] = []
    const greedy: PlaybookDefinition = {
      id: 'greedy',
      description: 'taps the notice on purpose',
      params: tiktokParams,
      allowedPackages: [TIKTOK_PACKAGE],
      async run(rt) {
        const obs = await rt.observe('poke', {})
        attempts.push(await rt.tap(obs, { x: 0.5, y: 0.55 }, 'Got it'))
        attempts.push(await rt.tap(obs, { x: 0.5, y: 0.1 }, 'dimmed area'))
        attempts.push(await rt.swipe({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.3 }, 300))
        attempts.push(await rt.key('ENTER'))
        return { success: true, reason: 'tried' }
      },
    }
    const result = await runPlaybook(greedy, options(w, jev))
    expect(attempts).toEqual([false, false, false, false])
    expect(w.taps).toEqual([])
    expect(w.counts.consentTouches).toBe(0)
    expect(result.consentBlocks).toBe(4)
  })

  it('extracts product ids from canonical links', () => {
    expect(productIdFromUrl('https://www.tiktok.com/view/product/1735758438214894952?x=1')).toBe('1735758438214894952')
    expect(productIdFromUrl('https://vt.tiktok.com/ZS9yg/')).toBeUndefined()
  })
})
