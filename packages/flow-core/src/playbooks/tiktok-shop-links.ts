import { z } from 'zod'
import { CONSENT_NEEDS_HUMAN, describeConsent } from '../consent.js'
import { jevBoxCenter } from '../jev.js'
import type { JevBoxAnswer, JevNoulAnswer, JevNoulQuestion, JevQuestions } from '../jev.js'
import type { Observation, PlaybookDefinition, PlaybookOutcome, PlaybookRuntime } from './runtime.js'
import { findTreeTarget } from './tree-target.js'
import type { CenterRegion, CoordSource } from './tree-target.js'
import type { RatioPoint } from '@escrcpy/flow-device'

/**
 * TikTok Shop: search a keyword and collect product links (Share → Copy link).
 *
 * Code owns the flow; every observation is one Jev request that judges the
 * page type, popups, the share panel, "no results", and locates the controls
 * the current step may need. Cards are judged one position at a time (price?
 * sold count? LIVE badge? Ad label?) and code picks the next card with a price and no LIVE badge; product IDs come
 * from the copied link and are compared in code. When Jev is unsure or the
 * screen is unexpected, only that step goes to the vision agent.
 */

export const TIKTOK_PACKAGE = 'com.zhiliaoapp.musically'

export const tiktokShopLinksParams = z.object({
  keyword: z.string().trim().min(1, 'keyword is required'),
  count: z.coerce.number().int().min(1).max(10).default(3),
  /** Skip cards labelled "Ad"/"Sponsored". Default false: ads are products too, and are flagged per item. */
  skipAds: z.boolean().default(false),
  /** Grid scrolls before giving up on finding more cards. Default 4. */
  maxScrolls: z.coerce.number().int().min(0).max(20).default(4),
})

export type TiktokShopLinksParams = z.infer<typeof tiktokShopLinksParams>

export interface TiktokShopLinkItem {
  link: string
  /** Always present: a copied link whose product ID cannot be resolved goes to `unresolved`, not here. */
  productId: string
  /** The product URL the link resolves to, without its query string (https://www.tiktok.com/view/product/<id>). */
  finalUrl: string
  position: CardPosition
  ad: boolean
  /** The grid card showed a sold count (recorded, not required: the bottom row's count is often cut off). */
  sold?: boolean
  /** Jev Noul on the product page: is the product the kind of thing `keyword` names. */
  relevance?: number
  /** Which search produced the card: 1 for the first, higher after a re-search (e.g. TikTok was force-stopped). */
  searchEpoch: number
  /** The product was opened in TikTok's video + product half sheet (DetailActivity) rather than a full product page. */
  sheet?: boolean
}

/** A freshly copied link whose product ID could not be resolved; not counted toward `count`. */
export interface TiktokShopUnresolvedLink {
  link: string
  position: CardPosition
  searchEpoch: number
  reason: string
}

export interface TiktokShopLinksResult {
  keyword: string
  /** One per item: `links[i]`, `productIds[i]` and `items[i]` describe the same product. */
  links: string[]
  productIds: string[]
  noResults: boolean
  items: TiktokShopLinkItem[]
  duplicates: string[]
  /** Times the run ended up in a LIVE room (left at once with BACK, or force-stop + relaunch; nothing tapped there). */
  liveRoomEntries: number
  /** Copied links that did not resolve to a product ID (retried first); they are not in `items`. */
  unresolved: TiktokShopUnresolvedLink[]
  /** Searches run for this result. Above 1 the items do not all come from one results grid, so positions are per search. */
  searchEpochs: number
  researched: boolean
}

// ---------------------------------------------------------------------------
// Questions

export const TIKTOK_PAGES = {
  video_feed: { what: 'TikTok short-video feed: one full-screen video with Like, Comment and Share icons on the right edge and tabs such as Following, Shop and For You at the top' },
  live_room: { what: 'TikTok LIVE room: a host streaming live, a viewer count, scrolling chat messages and gifts' },
  shop_home: { what: 'TikTok Shop home page: a search box at the top, banners or category icons, and a feed of products, with no keyboard open' },
  search_input: { what: 'Search input page: a search text field at the top with a Search button beside it, recent searches or suggestions below, usually with a keyboard' },
  results_grid: { what: 'Product search results page: the search field shows the query at the top, filter tabs such as Best match below it, and a grid of product cards with prices', not_for: 'A page that says No results found' },
  no_results: { what: 'Search results page that shows a "No results found" message instead of product cards' },
  product_detail: { what: 'TikTok Shop product detail page: a large product photo, the price and title, and a Buy now button at the bottom' },
  other_app: { what: 'A screen of an app that is not TikTok, such as Shopee, MercadoLibre, Chrome or the Android home screen' },
  other: { what: 'Any other TikTok screen' },
} as const

type Page = keyof typeof TIKTOK_PAGES

const BASE_QUESTIONS = {
  page: { type: 'choice', instructions: 'Which kind of page is shown in `screen`? Judge the page itself and ignore any popup, dialog, share panel or keyboard drawn on top of it.', criteria: TIKTOK_PAGES },
  popup: {
    type: 'noul',
    instructions: 'Is a popup or dialog (such as a coupon offer, a promotion, a permission request or a tip) drawn on top of the page in `screen`, covering part of it?',
    criteria: {
      true: { what: 'A dialog or popup over the page that has to be closed first', examples: ['a "You\'ve got new offers!" coupon card with Claim all', 'a "Got it" tip dialog', 'an allow-notifications prompt'] },
      false: { what: 'No popup: the page is uncovered, or only a keyboard, a share panel or a small floating video window is shown', examples: ['an on-screen keyboard', 'a "Send to" share panel with Copy link', 'a small floating video player in a corner of a product page', 'a plain product grid'] },
    },
  },
  share_open: { type: 'noul', instructions: 'Is a share panel titled "Send to", with a Copy link button, open at the bottom of `screen`?' },
  no_results: { type: 'noul', instructions: 'Does `screen` show a message saying that no results were found for the search?' },
  popup_close: { type: 'box', instructions: 'the close button (an X) of the popup or dialog in `screen`' },
  // A cold start shows a blank (black) screen for a few seconds: wait it out instead of counting a miss.
  loading: {
    type: 'noul',
    instructions: 'Is `screen` blank or still loading: mostly empty or black, with no app content besides the status bar?',
    criteria: { false: { what: 'The app shows content', examples: ['a video', 'a product grid', 'a search page'] } },
  },
  // Pressing BACK here can leave TikTok, so code must know it: the Activity is the main signal, this the backup.
  home_feed: {
    type: 'noul',
    instructions: 'Is `screen` the TikTok home feed, with the Following and For You tabs at the top and the Home, Friends, +, Inbox and Profile bar at the bottom?',
    criteria: { false: { what: 'Not the home feed', examples: ['a single video opened from a product or a search, with a back arrow at the top-left and no Home / Inbox / Profile bar', 'the TikTok Shop page', 'a product page'] } },
  },
} as const satisfies JevQuestions

const NAV_QUESTIONS = {
  shop_tab_present: { type: 'noul', instructions: 'Is there a "Shop" tab in the top navigation bar of `screen`?' },
  shop_tab: { type: 'box', instructions: 'the "Shop" tab in the top navigation bar of `screen`' },
  shop_search_present: { type: 'noul', instructions: 'Is there a search box at the top of the TikTok Shop page in `screen`?' },
  shop_search: { type: 'box', instructions: 'the search box at the top of the TikTok Shop page in `screen`' },
} as const satisfies JevQuestions

const SEARCH_QUESTIONS = {
  field_has_keyword: {
    type: 'noul',
    instructions: 'Does the search text field at the top of `screen` contain exactly the text in `keyword`?',
    criteria: { false: { what: 'The field is empty, shows only grey placeholder or suggestion text, or shows different text' } },
  },
  search_button_present: { type: 'noul', instructions: 'Is there a "Search" button next to the search field at the top of `screen`?' },
  search_button: { type: 'box', instructions: 'the "Search" button next to the search field at the top of `screen`' },
} as const satisfies JevQuestions

export const CARD_POSITIONS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
export type CardPosition = typeof CARD_POSITIONS[number]

const POSITION_WORDS: Record<CardPosition, string> = {
  top_left: 'top-left',
  top_right: 'top-right',
  bottom_left: 'bottom-left',
  bottom_right: 'bottom-right',
}

function cardQuestions(): JevQuestions {
  const questions: JevQuestions = {}
  for (const position of CARD_POSITIONS) {
    // What counts as a product card is decided in code from these literal facts (price, LIVE badge),
    // never by asking "is this a product / a video": a product photo with a play icon is still a
    // product, and the model judged those inconsistently (tk-shop-erp D2).
    const where = `the ${POSITION_WORDS[position]} card of the product results grid in \`screen\``
    questions[`${position}_price`] = { type: 'noul', instructions: `Does ${where} show a price, such as "R$ 17,99"?` }
    questions[`${position}_sold`] = { type: 'noul', instructions: `Does ${where} show how many were sold, such as "2.4K sold" or "40.8K shop sales"?` }
    questions[`${position}_live`] = {
      type: 'noul',
      instructions: `Does ${where} have a "LIVE" badge on its picture, showing a live stream?`,
      criteria: { false: { what: 'No LIVE badge on the picture', examples: ['a play triangle icon on a product photo', 'a discount badge such as -43%', 'the LIVE filter chip above the grid'] } },
    }
    questions[`${position}_ad`] = { type: 'noul', instructions: `Does ${where} show an "Ad" or "Sponsored" label?` }
    questions[`${position}_card`] = { type: 'box', instructions: where }
  }
  return questions
}

const CARD_QUESTIONS = cardQuestions()

const PRODUCT_QUESTIONS = {
  share_icon_present: { type: 'noul', instructions: 'Is there a Share icon (a curved arrow) in the top bar of `screen`?' },
  share_icon: { type: 'box', instructions: 'the Share icon (a curved arrow) in the top bar of `screen`' },
  copy_link_present: { type: 'noul', instructions: 'Is there a "Copy link" button in a share panel in `screen`?' },
  copy_link: { type: 'box', instructions: 'the "Copy link" button in the share panel of `screen`' },
  relevant: { type: 'noul', instructions: 'Is the product shown in `screen` the kind of product that the search text in `keyword` names?' },
  // TikTok 46.5 opens video-thumbnail cards as a video with the product in a half sheet below it
  // (DetailActivity); its Share icon sits at the sheet's top-right, right next to the cart icon.
  product_sheet: {
    type: 'noul',
    instructions: 'Is the product in `screen` shown in a sheet that covers only the lower part of the screen, with a video still visible above the sheet?',
    criteria: { false: { what: 'A full-screen product page whose top bar (back or close button, search box, share and cart icons) sits at the very top of the screen, or any page that is not a product page' } },
  },
  sheet_share_icon: { type: 'box', instructions: 'the Share icon (a curved arrow) at the top-right of the product sheet in `screen`' },
  sheet_cart_icon: { type: 'box', instructions: 'the shopping cart icon at the top-right of the product sheet in `screen`' },
} as const satisfies JevQuestions

/** Asked on the crop around a candidate sheet Share point, with the forbidden-control question (same request). */
export const SHEET_SHARE_CONFIRM: JevNoulQuestion = {
  type: 'noul',
  instructions: 'Is the control inside the red circle in `crop` a Share icon (a curved arrow pointing right)?',
  criteria: { false: { what: 'Any other control or empty space', examples: ['a shopping cart icon', 'a three-dots menu icon', 'empty space between two icons'] } },
}

/** Horizontal distance between the sheet's round icons (share → cart → more) as a share of the screen width; measured on a Pixel 5a. */
export const SHEET_ICON_SPACING = 0.11

/** Where a correctly located control sits (box centre, as 0..1 of the screen) and how big its box is. */
export interface BoxRegion {
  x?: [number, number]
  y?: [number, number]
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}

/** Expected regions on a portrait phone; a low-confidence box that fits one is still used (see thresholds.boxGeometry). */
export const TIKTOK_BOX_REGIONS: Record<string, BoxRegion> = {
  shop_tab: { y: [0, 0.15], maxWidth: 0.25 },
  /** A close X is small; used as an extra requirement, never to lower the confidence bar. */
  popup_close: { maxWidth: 0.15, maxHeight: 0.08 },
  shop_search: { y: [0, 0.2], minWidth: 0.3 },
  search_button: { x: [0.6, 1], y: [0, 0.15], maxWidth: 0.3 },
  share_icon: { x: [0.5, 1], y: [0, 0.15], maxWidth: 0.15 },
  // Half sheet (DetailActivity on TikTok 46.5): icons on the sheet's top edge, which sits around 0.3 of the height.
  // Share is the left one (≈0.71), the cart next to it (≈0.83). Used only when the page is a sheet.
  sheet_share_icon: { x: [0.6, 0.79], y: [0.15, 0.7], maxWidth: 0.12, maxHeight: 0.08 },
  sheet_cart_icon: { x: [0.74, 0.9], y: [0.15, 0.7], maxWidth: 0.12, maxHeight: 0.08 },
  copy_link: { x: [0, 0.5], y: [0.6, 1], maxWidth: 0.3 },
  // A card cut off by the header after a scroll is too short to tap safely.
  top_left_card: { x: [0, 0.5], y: [0.2, 0.75], minWidth: 0.3, maxWidth: 0.55, minHeight: 0.15 },
  top_right_card: { x: [0.5, 1], y: [0.2, 0.75], minWidth: 0.3, maxWidth: 0.55, minHeight: 0.15 },
  bottom_left_card: { x: [0, 0.5], y: [0.45, 1], minWidth: 0.3, maxWidth: 0.55, minHeight: 0.15 },
  bottom_right_card: { x: [0.5, 1], y: [0.45, 1], minWidth: 0.3, maxWidth: 0.55, minHeight: 0.15 },
}

/**
 * Labels that name each tappable target (case-insensitive, whole word; en / pt / es). A tap is
 * refused when the UI tree has labels at the point and none of them is one of these, and the
 * UI-tree element carrying one of them (inside the target's region) supplies the point when there
 * is exactly one. Product cards and the Shop search box have no rule: the grid is not in the UI
 * tree, and the search box shows rotating suggested searches.
 */
export const TIKTOK_EXPECTED_LABELS = {
  shop_tab: ['Shop', 'Loja', 'Tienda'],
  share_icon: ['Share', 'Compartilhar', 'Compartir'],
  sheet_share_icon: ['Share', 'Compartilhar', 'Compartir'],
  copy_link: ['Copy link', 'Copiar link', 'Copiar enlace'],
  popup_close: ['Close', 'Fechar', 'Cerrar', 'Dismiss'],
} as const satisfies Record<string, readonly string[]>

export type LabelledTarget = keyof typeof TIKTOK_EXPECTED_LABELS

/** A popup's close X has no fixed place: its UI-tree element must lie this close to Jev's box centre. */
const POPUP_CLOSE_TREE_RADIUS = 0.1

export function boxFitsRegion(box: { top: number, bottom: number, left: number, right: number }, region: BoxRegion | undefined): boolean {
  if (!region)
    return false
  const cx = (box.left + box.right) / 2
  const cy = (box.top + box.bottom) / 2
  const width = box.right - box.left
  const inside = (value: number, range?: [number, number]) => !range || (value >= range[0] && value <= range[1])
  return inside(cx, region.x) && inside(cy, region.y) && (region.minWidth === undefined || width >= region.minWidth) && (region.maxWidth === undefined || width <= region.maxWidth) && (region.maxHeight === undefined || box.bottom - box.top <= region.maxHeight) && (region.minHeight === undefined || box.bottom - box.top >= region.minHeight)
}

type Goal = 'reach_search' | 'type' | 'results' | 'pick' | 'open_share' | 'copy' | 'return'

const GOAL_QUESTIONS: Record<Goal, JevQuestions> = {
  reach_search: { ...BASE_QUESTIONS, ...NAV_QUESTIONS },
  type: { ...BASE_QUESTIONS, ...SEARCH_QUESTIONS },
  results: { ...BASE_QUESTIONS, ...SEARCH_QUESTIONS, ...CARD_QUESTIONS },
  pick: { ...BASE_QUESTIONS, ...CARD_QUESTIONS },
  open_share: { ...BASE_QUESTIONS, ...PRODUCT_QUESTIONS },
  copy: { ...BASE_QUESTIONS, ...PRODUCT_QUESTIONS },
  return: { ...BASE_QUESTIONS, ...CARD_QUESTIONS },
}

// ---------------------------------------------------------------------------
// Helpers

const URL_RE = /https?:\/\/\S+/i
/** The home feed and the Shop tab live in the launcher Activity; BACK there can leave TikTok. */
const HOME_ACTIVITY_RE = /\.(?:splash\.SplashActivity|main\.MainActivity)$/
/** Videos opened from a card or a product, and (on 46.5) the video + product half sheet. */
const DETAIL_ACTIVITY_RE = /\.detail\.ui\.DetailActivity$/
/** LIVE rooms (com.ss.android.ugc.aweme.live.LivePlayActivity on 46.5 / 47.5). */
const LIVE_ACTIVITY_RE = /\.live\.[A-Za-z]*Activity$/
/** LIVE rooms entered by mistake that a run tolerates; the next one ends it as failed. */
export const MAX_LIVE_ROOM_ENTRIES = 2
const CONSENT_SENTENCE = 'Terms, policy, privacy or consent notices are not yours to handle: do not tap them or anything around them, reply fail.'
const PRODUCT_ID_RE = /\/product\/(\d{6,})/

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }
  catch {
    return url
  }
}

/** Every counted item carries its product ID and product URL (so `productIds.length === items.length`). */
export function assertItemsResolved(items: readonly TiktokShopLinkItem[]): void {
  for (const item of items) {
    if (!item.productId || !item.finalUrl || productIdFromUrl(item.finalUrl) !== item.productId)
      throw new Error(`invariant violated: item ${item.link} has no resolved product (productId ${item.productId ?? 'missing'}, finalUrl ${item.finalUrl ?? 'missing'})`)
  }
}

export function productIdFromUrl(url: string | undefined): string | undefined {
  return url?.match(PRODUCT_ID_RE)?.[1]
}

type Answers = Record<string, any>

interface CardView {
  position: CardPosition
  /** Price visible: the card is a product (code's definition; LIVE cards are excluded separately). */
  product: number
  sold: number
  live: number
  ad: number
  box: JevBoxAnswer
}

/** Text of the first EditText in the UI tree, when the tree has one. */
function searchFieldText(obs: Observation<any>): string | undefined {
  const field = obs.tree?.nodes.find(node => node.className.endsWith('EditText'))
  return field ? field.text.trim() : undefined
}

// ---------------------------------------------------------------------------
// Playbook

async function run(rt: PlaybookRuntime, params: TiktokShopLinksParams): Promise<PlaybookOutcome> {
  const T = rt.thresholds
  const keyword = params.keyword.trim()
  rt.allowedInput = [keyword]
  const items: TiktokShopLinkItem[] = []
  const duplicates: string[] = []
  const unresolved: TiktokShopUnresolvedLink[] = []
  // LIVE rooms: nothing in them is touched. Entering one is left with one BACK, then force-stop + relaunch.
  let liveRoomEntries = 0
  let inLiveRoom = false
  let liveBackTried = false
  let liveRestarted = false
  let liveLoadWaits = 0
  // Consent notices: BACK once, then force-stop + relaunch once per run; seen again after that, a human decides.
  let consentBackTried = false
  let consentRestarts = 0
  const seen = new Set<string>()
  /** Searches submitted so far (a re-search after a relaunch starts a new epoch). */
  let searchEpoch = 0
  let epochCounted = true
  const result = (): TiktokShopLinksResult => {
    assertItemsResolved(items)
    return { keyword, links: items.map(item => item.link), productIds: items.map(item => item.productId), noResults: false, items: [...items], duplicates: [...duplicates], unresolved: [...unresolved], searchEpochs: searchEpoch, researched: searchEpoch > 1, liveRoomEntries }
  }
  rt.partial = result()

  const pageOf = (a: Answers): Page | 'uncertain' => a.page.confidence >= T.page ? a.page.choice as Page : 'uncertain'
  const yes = (answer: JevNoulAnswer) => answer.noul >= T.popup
  /** A box is used on confidence alone, or at a lower confidence when it fits the target's expected region. */
  const located = (present: JevNoulAnswer | undefined, box: JevBoxAnswer, name: string, quiet = false) => {
    if (present && present.noul < T.present)
      return false
    const confidence = box.confidence ?? 0
    if (confidence >= T.box)
      return true
    if (confidence >= T.boxGeometry && boxFitsRegion(box.box, TIKTOK_BOX_REGIONS[name])) {
      if (!quiet)
        rt.decide(`${name} box ${confidence.toFixed(2)} accepted by its expected region`)
      return true
    }
    return false
  }
  let gridWaits = 0

  /**
   * Point for a labelled target: the UI-tree element when exactly one names it inside the target's
   * region (coordinate rule: the element wins), else the Jev box when one is usable.
   */
  const aim = (obs: Observation<any>, name: LabelledTarget, box: JevBoxAnswer | undefined): { point: RatioPoint, source: CoordSource } | undefined => {
    let region: CenterRegion = TIKTOK_BOX_REGIONS[name]
    if (name === 'popup_close') {
      if (!box)
        return undefined
      const c = jevBoxCenter(box.box)
      region = { x: [c.x - POPUP_CLOSE_TREE_RADIUS, c.x + POPUP_CLOSE_TREE_RADIUS], y: [c.y - POPUP_CLOSE_TREE_RADIUS, c.y + POPUP_CLOSE_TREE_RADIUS] }
    }
    const lookup = findTreeTarget(obs.tree, TIKTOK_EXPECTED_LABELS[name], region)
    if (lookup.found) {
      rt.decide(`${name} from the UI tree ("${lookup.found.label}")`)
      return { point: lookup.found.point, source: 'tree' }
    }
    if (lookup.candidates > 1)
      rt.decide(`${name}: ${lookup.reason} in the UI tree; using the Jev box`)
    return box ? { point: jevBoxCenter(box.box), source: 'jev_box' } : undefined
  }

  /** The TikTok home feed (For You). Never press BACK here: it is one step from leaving the app. */
  const isHome = (obs: Observation<any>, a: Answers, page: Page | 'uncertain') => {
    if (page === 'shop_home')
      return false
    const activity = obs.app?.activity ?? ''
    if (DETAIL_ACTIVITY_RE.test(activity) || activity.includes('.ecommerce.'))
      return false
    if (HOME_ACTIVITY_RE.test(activity))
      return page === 'video_feed' || (page === 'uncertain' && a.home_feed.noul >= 0.5)
    return (page === 'video_feed' || page === 'uncertain') && a.home_feed.noul >= T.popup
  }

  /** The video + product half sheet: Jev says so clearly, or the Activity is DetailActivity and Jev / the sheet icons agree. */
  const isSheet = (obs: Observation<any>, a: Answers, page: Page | 'uncertain') => {
    if (page !== 'product_detail' || !a.product_sheet)
      return false
    if (a.product_sheet.noul >= T.popup)
      return true
    if (!DETAIL_ACTIVITY_RE.test(obs.app?.activity ?? ''))
      return false
    const iconsOnSheet = (a.sheet_share_icon.confidence ?? 0) >= 0.6 && boxFitsRegion(a.sheet_share_icon.box, TIKTOK_BOX_REGIONS.sheet_share_icon)
    return a.product_sheet.noul >= 0.25 || iconsOnSheet
  }

  /** BACK, unless this is the home feed; the runtime re-checks the live foreground (TikTok, and not freshly on the home Activity). */
  const back = async (obs: Observation<any>, reason: string): Promise<boolean> => {
    const a = obs.answers as Answers
    if (isHome(obs, a, pageOf(a))) {
      rt.decide(`BACK refused on the home feed (${reason})`)
      return false
    }
    const observedHome = HOME_ACTIVITY_RE.test(obs.app?.activity ?? '')
    return rt.key('BACK', reason, { guard: app => !observedHome && HOME_ACTIVITY_RE.test(app.activity) ? `the screen changed to ${app.activity.split('.').at(-1)} (home)` : undefined })
  }

  /**
   * Sheet Share candidates, leftmost first: the Box centre when it sits in the sheet's icon row and
   * not on the cart, then one icon left of the cart. Each tap first passes the visual check, which
   * also confirms the ringed control is a Share arrow, so a point on the cart is refused.
   */
  const sheetShareCandidates = (obs: Observation<any>, a: Answers): Array<{ point: RatioPoint, source: CoordSource }> => {
    const usable = (box: JevBoxAnswer, name: string) => (box.confidence ?? 0) >= T.boxGeometry && boxFitsRegion(box.box, TIKTOK_BOX_REGIONS[name])
    const cart = usable(a.sheet_cart_icon, 'sheet_cart_icon') ? jevBoxCenter(a.sheet_cart_icon.box) : undefined
    const points: Array<{ point: RatioPoint, source: CoordSource }> = []
    if (usable(a.sheet_share_icon, 'sheet_share_icon')) {
      const share = jevBoxCenter(a.sheet_share_icon.box)
      if (!cart || cart.x - share.x >= SHEET_ICON_SPACING / 2)
        points.push({ point: share, source: 'jev_box' })
    }
    if (cart)
      points.push({ point: { x: cart.x - SHEET_ICON_SPACING, y: cart.y }, source: 'derived' })
    const sorted = points
      .filter((candidate, i) => points.findIndex(other => Math.abs(other.point.x - candidate.point.x) < 0.015 && Math.abs(other.point.y - candidate.point.y) < 0.015) === i)
      .sort((p, q) => p.point.x - q.point.x)
    // A UI-tree element in the sheet's icon row comes first (the video's right-rail Share is outside that region).
    const lookup = findTreeTarget(obs.tree, TIKTOK_EXPECTED_LABELS.sheet_share_icon, TIKTOK_BOX_REGIONS.sheet_share_icon)
    if (lookup.found) {
      rt.decide(`sheet_share_icon from the UI tree ("${lookup.found.label}")`)
      const tree = lookup.found.point
      return [{ point: tree, source: 'tree' as const }, ...sorted.filter(other => Math.abs(other.point.x - tree.x) >= 0.015 || Math.abs(other.point.y - tree.y) >= 0.015)]
    }
    return sorted
  }
  /** Share-icon taps for the current product, and observations waited since the last one (the panel slides in slowly). */
  let shareTaps = 0
  let shareWaits = 0

  let goal = 'reach_search' as Goal
  let misses = 0
  let actions = 0
  let typed = 0
  let popupCloses = 0
  /**
   * Per scroll page: positions that showed a price (and no LIVE badge) on any observation, and
   * positions already opened. Sticky because overlays come and go: after Copy link, Android's
   * clipboard preview sits over the bottom-left card and hides its price on the next look.
   */
  const pageQualified = new Set<CardPosition>()
  /** Positions that opened a LIVE room on this page (their LIVE badge was missed). */
  const liveMarked = new Set<CardPosition>()
  const opened = new Set<CardPosition>()
  const newPage = () => {
    pageQualified.clear()
    opened.clear()
    liveMarked.clear()
  }
  let scrolls = 0
  let backs = 0
  let card: { position: CardPosition, ad: boolean, sold: boolean, relevance?: number, sheet?: boolean } | undefined
  /** Set when the last action was a card tap; read (and cleared) by the next observation. */
  let cardJustTapped = false
  let lastRelaunches = rt.relaunches
  let relocateWaits = 0
  let loadingWaits = 0
  let videoBacks = 0
  let takenLink: string | undefined
  const setGoal = (next: Goal) => {
    if (next !== goal) {
      misses = 0
      actions = 0
    }
    goal = next
  }

  /** Records a miss; on the second miss of the same goal, hands the step to the vision agent. */
  const miss = async (why: string, intent: string, expect: Parameters<PlaybookRuntime['takeover']>[1]) => {
    misses++
    rt.decide(`miss ${misses}: ${why}`)
    if (misses >= 2) {
      misses = 0
      await rt.takeover(intent, expect, why)
    }
  }

  /** Reads the clipboard after a copy; accepts it only when it changed from `before` and holds a URL. */
  const takeClipboard = async (before: string): Promise<string | undefined> => {
    const value = await rt.waitClipboardChange(before)
    const link = value.match(URL_RE)?.[0]
    if (!link || value === before)
      return undefined
    return link
  }

  /**
   * Stores a freshly copied link; returns true when the target count is reached. Only links that
   * resolve to a product ID count: others go to `unresolved` and the playbook moves on to the next card.
   */
  const store = async (link: string): Promise<boolean> => {
    let productUrl: string | undefined = productIdFromUrl(link) ? link : undefined
    let failure: string | undefined
    if (!productUrl) {
      const resolution = await rt.resolveLink(link, PRODUCT_ID_RE)
      if (resolution.matched && productIdFromUrl(resolution.url))
        productUrl = resolution.url
      else
        failure = resolution.reason ?? 'no product URL'
    }
    const productId = productIdFromUrl(productUrl)
    if (!productUrl || !productId) {
      unresolved.push({ link, position: card?.position ?? 'top_left', searchEpoch: Math.max(1, searchEpoch), reason: failure ?? 'no product ID in the link' })
      rt.decide(`link ${link} did not resolve to a product ID (${failure}); not counted, next card`)
    }
    else if (seen.has(productId)) {
      duplicates.push(productId)
      rt.decide(`duplicate product ${productId}; not counted`)
    }
    else {
      seen.add(productId)
      items.push({ link, productId, finalUrl: stripQuery(productUrl), position: card?.position ?? 'top_left', ad: card?.ad ?? false, sold: card?.sold ?? false, ...(card?.relevance !== undefined ? { relevance: Math.round(card.relevance * 1000) / 1000 } : {}), searchEpoch: Math.max(1, searchEpoch), ...(card?.sheet ? { sheet: true } : {}) })
      rt.decide(`stored link ${items.length}/${params.count}: ${productId}`)
    }
    rt.partial = result()
    card = undefined
    return items.length >= params.count
  }

  /** Clears the field, types the keyword, and lets the next observation verify it. */
  const typeKeyword = async () => {
    typed++
    epochCounted = false
    await rt.clearText()
    await rt.inputText(keyword)
  }

  for (;;) {
    const obs = await rt.observe(goal, GOAL_QUESTIONS[goal], { keyword })
    const a = obs.answers as Answers
    const page = pageOf(a)
    const shareOpen = yes(a.share_open)
    const tappedCard = cardJustTapped
    cardJustTapped = false
    const relaunched = rt.relaunches !== lastRelaunches
    lastRelaunches = rt.relaunches
    const home = isHome(obs, a, page)

    // Copy link handed to a takeover: its check read the clipboard already.
    if (takenLink) {
      const link = takenLink
      takenLink = undefined
      if (await store(link))
        return { success: true, result: result(), reason: `collected ${items.length} links` }
      setGoal('return')
    }

    if (yes(a.no_results) || page === 'no_results') {
      if (!epochCounted) {
        searchEpoch++
        epochCounted = true
      }
      rt.decide('search returned no results')
      return { success: true, result: { ...result(), noResults: true }, reason: 'no results for the keyword' }
    }

    // LIVE room (a card whose LIVE badge was missed, or any other way in): bookkeeping first.
    const inLive = page === 'live_room' || LIVE_ACTIVITY_RE.test(obs.app?.activity ?? '')
    if (inLive && !inLiveRoom) {
      inLiveRoom = true
      liveBackTried = false
      liveRestarted = false
      liveLoadWaits = 0
      liveRoomEntries++
      if (tappedCard && card) {
        liveMarked.add(card.position)
        rt.decide(`the ${card.position} card opened a LIVE room: marked LIVE for this search`)
      }
      card = undefined
      rt.decide(`in a LIVE room (${liveRoomEntries} of ${MAX_LIVE_ROOM_ENTRIES} tolerated); nothing here is touched`)
      rt.partial = result()
      if (liveRoomEntries > MAX_LIVE_ROOM_ENTRIES)
        throw new PlaybookEnd(`entered a LIVE room ${liveRoomEntries} times (cards whose LIVE badge was not recognised); stopped instead of retrying`)
    }
    if (!inLive)
      inLiveRoom = false

    // Terms / policy / consent notice: nothing on the screen may be touched (the runtime refuses
    // taps anyway). BACK, then force-stop + relaunch; still there after that → a human decides.
    if (obs.consent.present) {
      rt.decide(`terms / policy / consent notice on screen (${describeConsent(obs.consent)}): not touched`)
      if (consentRestarts >= 1) {
        rt.stopForConsent(obs)
        throw new PlaybookEnd(`${CONSENT_NEEDS_HUMAN}: a terms / policy / consent notice is still on screen after BACK and a relaunch (${describeConsent(obs.consent)}); a person has to handle it${obs.step.screenshot ? ` (frame ${obs.step.screenshot})` : ''}`)
      }
      if (!consentBackTried) {
        consentBackTried = true
        if (await back(obs, 'leave the consent notice without confirming it'))
          continue
      }
      consentRestarts++
      consentBackTried = false
      await rt.restartApp('consent notice still on screen after BACK')
      continue
    }
    consentBackTried = false

    // In a LIVE room: leave without touching anything (no popups closed, no takeover).
    if (inLive) {
      // A LIVE room renders black for a moment; a BACK sent then is swallowed (seen on 16091).
      if (!liveBackTried && a.loading.noul >= T.popup && liveLoadWaits < 2) {
        liveLoadWaits++
        rt.decide(`LIVE room still loading (${a.loading.noul.toFixed(2)}); wait before BACK`)
        await rt.sleep(1500)
        continue
      }
      if (!liveBackTried) {
        liveBackTried = true
        if (await back(obs, 'leave the LIVE room'))
          continue
      }
      if (liveRestarted)
        throw new PlaybookEnd('still in a LIVE room after BACK and a relaunch')
      liveRestarted = true
      liveBackTried = false
      await rt.restartApp('still in the LIVE room after BACK')
      continue
    }

    // A popup over the page comes first (a share panel the playbook opened is not one).
    if (yes(a.popup) && !shareOpen) {
      popupCloses++
      if (popupCloses > 3) {
        popupCloses = 0
        await rt.takeover(`A popup or dialog covers the TikTok screen. Close it with its close (X) button or the back key; never tap its action button (Claim, Buy, Follow, etc.). ${CONSENT_SENTENCE}`, o => !yes((o.answers as Answers).popup), 'popup did not close')
        continue
      }
      if ((a.popup_close.confidence ?? 0) >= T.box && boxFitsRegion(a.popup_close.box, TIKTOK_BOX_REGIONS.popup_close)) {
        rt.decide('close popup with its X')
        const target = aim(obs, 'popup_close', a.popup_close)!
        if (await rt.tap(obs, target.point, 'popup close X', { coordSource: target.source, expectLabels: TIKTOK_EXPECTED_LABELS.popup_close }))
          continue
      }
      rt.decide('close popup with BACK')
      if (!(await back(obs, 'close popup')))
        await rt.takeover(`A popup or dialog covers the TikTok home screen. Close it with its close (X) button; never tap its action button (Claim, Buy, Follow, etc.) and do not press back. ${CONSENT_SENTENCE}`, o => !yes((o.answers as Answers).popup), 'popup on the home feed has no usable close button')
      continue
    }

    if ((page === 'uncertain' || page === 'other') && a.loading.noul >= T.popup && loadingWaits < 4) {
      loadingWaits++
      rt.decide(`screen is blank / still loading (${a.loading.noul.toFixed(2)}); wait`)
      await rt.sleep(1500)
      continue
    }
    if (a.loading.noul < 0.5)
      loadingWaits = 0

    // After a relaunch (TikTok restarted, e.g. force-stopped) the old step goal no longer applies,
    // and the home feed is never a place to press BACK: re-locate by what the screen shows.
    if (relaunched || (home && goal !== 'reach_search')) {
      const next = relocate(page, home, shareOpen)
      if (next === 'wait' && relocateWaits < 2) {
        relocateWaits++
        rt.decide(`after a relaunch the screen is ${page}; wait for it to settle`)
        await rt.sleep(1500)
        continue
      }
      relocateWaits = 0
      if (next && next !== 'wait') {
        rt.decide(`${relaunched ? 'TikTok was relaunched' : 'on the home feed'}: re-locate to ${next} (page ${page})`)
        if (next !== goal) {
          setGoal(next)
          continue
        }
      }
    }

    switch (goal) {
      case 'reach_search': {
        if (page === 'search_input') {
          setGoal('type')
          await typeKeyword()
          break
        }
        if (page === 'results_grid' || page === 'product_detail') {
          await back(obs, `leave ${page}`)
          break
        }
        if (++actions > 4) {
          actions = 0
          await rt.takeover('Open the TikTok Shop search input page: tap the Shop tab at the top of the video feed, then the search box at the top of the Shop page. Stop when the search text field (usually with a keyboard) is showing.', o => pageOf(o.answers as Answers) === 'search_input', 'search page not reached')
          break
        }
        if (page === 'video_feed') {
          const target = aim(obs, 'shop_tab', located(a.shop_tab_present, a.shop_tab, 'shop_tab') ? a.shop_tab : undefined)
          if (target) {
            const mismatches = rt.labelMismatchBlocks
            if (!(await rt.tap(obs, target.point, 'Shop tab', { coordSource: target.source, expectLabels: TIKTOK_EXPECTED_LABELS.shop_tab })) && rt.labelMismatchBlocks > mismatches)
              await miss('Shop tab point is labelled as something else', 'Open the TikTok Shop search input page: from the video feed tap the Shop tab at the top, then tap the search box at the top of the Shop page. Stop when the search text field (usually with a keyboard) is showing.', o => pageOf(o.answers as Answers) === 'search_input')
            break
          }
        }
        if (page === 'shop_home' && located(a.shop_search_present, a.shop_search, 'shop_search')) {
          await rt.tap(obs, jevBoxCenter(a.shop_search.box), 'Shop search box', { coordSource: 'jev_box' })
          break
        }
        await miss(`page ${page} (${a.page.choice} ${a.page.confidence.toFixed(2)}) has no usable control`, 'Open the TikTok Shop search input page: from the video feed tap the Shop tab at the top, then tap the search box at the top of the Shop page. Stop when the search text field (usually with a keyboard) is showing.', o => pageOf(o.answers as Answers) === 'search_input')
        break
      }

      case 'type': {
        if (page === 'results_grid') {
          setGoal('results')
          break
        }
        if (page !== 'search_input') {
          await miss(`expected the search page, saw ${page}`, 'Go back to the TikTok Shop search input page (the search text field with the keyboard). Do not type anything.', o => pageOf(o.answers as Answers) === 'search_input')
          if (misses === 0)
            setGoal('reach_search')
          break
        }
        const fieldText = searchFieldText(obs)
        const verified = fieldText === keyword || (fieldText !== undefined && fieldText.toLowerCase() === keyword.toLowerCase()) || (fieldText === undefined && a.field_has_keyword.noul >= T.popup)
        const wrong = fieldText !== undefined ? !verified && a.field_has_keyword.noul < 0.5 : a.field_has_keyword.noul <= 1 - T.popup
        if (verified || (!wrong && typed > 0 && a.field_has_keyword.noul >= 0.5)) {
          rt.decide(`field holds the keyword (tree: ${fieldText === undefined ? 'n/a' : JSON.stringify(fieldText)}, jev ${a.field_has_keyword.noul.toFixed(2)}); submit`)
          setGoal('results')
          await rt.key('ENTER', 'submit search')
          break
        }
        if (typed < 2) {
          rt.decide(`field text ${fieldText === undefined ? '(no tree)' : JSON.stringify(fieldText)} is not the keyword; (re)type`)
          await typeKeyword()
          break
        }
        await rt.takeover(`Make the search field at the top of this TikTok Shop search page contain exactly "${keyword}" (clear other text with the field's clear button first), then stop without submitting.`, o => (o.answers as Answers).field_has_keyword?.noul >= 0.5, 'keyword could not be verified in the field')
        typed = 1
        break
      }

      case 'results': {
        if (page === 'results_grid') {
          if (!epochCounted) {
            searchEpoch++
            epochCounted = true
            if (searchEpoch > 1)
              rt.decide(`search ${searchEpoch}: a new results grid, positions restart`)
          }
          if (a.field_has_keyword.noul <= 1 - T.popup)
            rt.decide(`warning: results page query may differ from the keyword (jev ${a.field_has_keyword.noul.toFixed(2)})`)
          setGoal('pick')
          // Same observation carries the card questions: pick right away.
          await pick(obs, a)
          break
        }
        if (page === 'search_input') {
          if (misses === 0 && located(a.search_button_present, a.search_button, 'search_button')) {
            misses++
            await rt.tap(obs, jevBoxCenter(a.search_button.box), 'Search button')
            break
          }
          await miss('search did not submit', `Submit the search on this TikTok Shop search page by tapping its Search button. Do not change the text in the field ("${keyword}").`, o => ['results_grid', 'no_results'].includes(pageOf(o.answers as Answers)) || yes((o.answers as Answers).no_results))
          break
        }
        await miss(`expected search results, saw ${page}`, `Show the TikTok Shop product search results for "${keyword}" (the results grid). Do not type a different search.`, o => ['results_grid', 'no_results'].includes(pageOf(o.answers as Answers)))
        break
      }

      case 'pick':
      case 'return': {
        if (shareOpen) {
          await back(obs, 'close share panel')
          break
        }
        if (page === 'results_grid') {
          backs = 0
          videoBacks = 0
          setGoal('pick')
          await pick(obs, a)
          break
        }
        if (page === 'product_detail' || page === 'video_feed' || page === 'other') {
          if (++backs > 4) {
            backs = 0
            await rt.takeover(`Go back to the TikTok Shop search results grid for "${keyword}" using the back key.`, o => pageOf(o.answers as Answers) === 'results_grid', 'could not return to the results grid')
            break
          }
          // A video opened from the product (not the home feed: that was re-located above) is one or
          // two BACKs from the grid; past that, search again instead of pressing on.
          if (page === 'video_feed' && ++videoBacks > 2) {
            rt.decide('still on a video after two BACKs: search again')
            videoBacks = 0
            setGoal('reach_search')
            newPage()
            scrolls = 0
            typed = 0
            break
          }
          if (!(await back(obs, `return from ${page}`))) {
            setGoal('reach_search')
            newPage()
            scrolls = 0
            typed = 0
          }
          break
        }
        if (page === 'search_input') {
          rt.decide('back at the search page: search again (seen products are skipped by ID)')
          newPage()
          scrolls = 0
          typed = 0
          setGoal('type')
          await typeKeyword()
          break
        }
        if (page === 'shop_home') {
          setGoal('reach_search')
          newPage()
          scrolls = 0
          typed = 0
          break
        }
        await miss(`expected the results grid, saw ${page}`, `Go back to the TikTok Shop search results grid for "${keyword}" using the back key.`, o => pageOf(o.answers as Answers) === 'results_grid')
        break
      }

      case 'open_share':
      case 'copy': {
        if (page === 'product_detail' && card && card.relevance === undefined)
          card.relevance = a.relevant.noul
        const sheet = isSheet(obs, a, page)
        if (sheet && card)
          card.sheet = true
        if (shareOpen || (goal === 'copy' && a.share_open.noul >= 0.5 && located(a.copy_link_present, a.copy_link, 'copy_link'))) {
          setGoal('copy')
          const copyTarget = aim(obs, 'copy_link', located(a.copy_link_present, a.copy_link, 'copy_link') ? a.copy_link : undefined)
          if (copyTarget) {
            // Read, never write, before copying: a write pops Android's clipboard preview over the
            // bottom-left corner, exactly where Copy link sits.
            const before = await rt.readClipboard()
            if (!(await rt.tap(obs, copyTarget.point, 'Copy link', { coordSource: copyTarget.source, expectLabels: TIKTOK_EXPECTED_LABELS.copy_link }))) {
              await miss('Copy link tap refused', 'Tap "Copy link" in the open share panel. Do not tap any friend, contact or other app.', async () => !!(takenLink = await takeClipboard(before)))
              break
            }
            const link = await takeClipboard(before)
            // Unchanged and already one of ours: the same product copied again (same short link).
            if (!link && items.some(item => item.link === before.match(URL_RE)?.[0])) {
              duplicates.push(items.find(item => item.link === before.match(URL_RE)?.[0])!.productId ?? before)
              rt.decide('Copy link produced a link already collected; duplicate product, not counted')
              card = undefined
              rt.partial = result()
              setGoal('return')
              await back(obs, 'back to results')
              break
            }
            if (!link) {
              await miss('clipboard has no fresh link after Copy link', 'Tap "Copy link" in the open share panel. Do not tap any friend, contact or other app.', async () => !!(takenLink = await takeClipboard(before)))
              break
            }
            if (await store(link))
              return { success: true, result: result(), reason: `collected ${items.length} links` }
            setGoal('return')
            await back(obs, 'back to results')
            break
          }
          const before = rt.clipboardReads.at(-1) ?? ''
          await miss(`Copy link not located (box ${(a.copy_link.confidence ?? 0).toFixed(2)})`, 'Tap "Copy link" in the open share panel. Do not tap any friend, contact or other app.', async () => !!(takenLink = await takeClipboard(before)))
          break
        }
        if (page === 'product_detail') {
          // A second tap while the panel is still sliding in would dismiss it: wait first.
          if (goal === 'copy' && shareWaits < 2) {
            shareWaits++
            rt.decide('share panel not open yet after tapping Share; wait')
            await rt.sleep(800)
            break
          }
          if (goal === 'copy')
            setGoal('open_share')
          if (sheet) {
            // Half sheet: its own icon row and rules; the cart is right next to Share, so every
            // candidate passes the visual check (forbidden control + "is this the Share arrow").
            rt.decide(`product half sheet over a video (${obs.app?.activity.split('.').at(-1) ?? 'activity unknown'}, sheet ${a.product_sheet.noul.toFixed(2)})`)
            if (shareTaps < 2) {
              const candidates = sheetShareCandidates(obs, a)
              for (let i = 0; i < candidates.length && i < 3; i++) {
                const { point, source } = candidates[i]
                const blocksBefore = rt.visualGuardBlocks
                if (await rt.tap(obs, point, 'sheet Share icon', { settleMs: 2000, confirm: SHEET_SHARE_CONFIRM, coordSource: source, expectLabels: TIKTOK_EXPECTED_LABELS.sheet_share_icon })) {
                  shareTaps++
                  shareWaits = 0
                  goal = 'copy'
                  break
                }
                // Refused as a forbidden control: that point was on the cart, so Share is one icon to its left.
                const left = { x: point.x - SHEET_ICON_SPACING, y: point.y }
                if (rt.visualGuardBlocks > blocksBefore && left.x > 0.5 && !candidates.some(other => Math.abs(other.point.x - left.x) < 0.015)) {
                  rt.decide(`sheet Share candidate (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) was refused as a forbidden control; try one icon to its left`)
                  candidates.push({ point: left, source: 'derived' })
                }
              }
              if (goal === 'copy')
                break
            }
            await miss(`sheet Share icon not usable (box ${(a.sheet_share_icon.confidence ?? 0).toFixed(2)})`, 'Open the share panel ("Send to") of this product with the curved-arrow Share icon at the top-right of the product sheet, the icon left of the shopping cart. Never tap the shopping cart. Stop when the panel with Copy link shows.', o => yes((o.answers as Answers).share_open))
            break
          }
          const shareTarget = aim(obs, 'share_icon', located(a.share_icon_present, a.share_icon, 'share_icon') ? a.share_icon : undefined)
          if (shareTarget && shareTaps < 2) {
            shareTaps++
            shareWaits = 0
            // The share panel loads its targets before sliding in (~2 s on a Pixel 5a).
            if (await rt.tap(obs, shareTarget.point, 'Share icon', { settleMs: 2000, coordSource: shareTarget.source, expectLabels: TIKTOK_EXPECTED_LABELS.share_icon }))
              goal = 'copy'
            break
          }
          await miss(`Share icon not usable (box ${(a.share_icon.confidence ?? 0).toFixed(2)})`, 'Open the share panel ("Send to") of this TikTok Shop product with the Share arrow icon in the top bar. Stop when the panel with Copy link shows.', o => yes((o.answers as Answers).share_open))
          break
        }
        if (page === 'video_feed') {
          // Skipping a card that opened a video takes exactly one BACK, and only right after the card
          // tap (the home feed never gets here: it was re-located above; LIVE rooms are left above).
          setGoal('return')
          if (tappedCard) {
            rt.decide(`card opened a ${page}, not a product; one BACK to skip it`)
            card = undefined
            await back(obs, `leave ${page} opened by the card`)
          }
          else {
            rt.decide(`on a ${page} without a fresh card tap; return to the grid`)
          }
          break
        }
        if (page === 'results_grid') {
          // The card tap did not open anything. This observation carried product-page questions,
          // not card questions: pick the next card on the next observation (this one counts as opened).
          rt.decide('still on the grid after the card tap; next card on the next observation')
          setGoal('pick')
          break
        }
        await miss(`expected a product page, saw ${page}`, `Go back to the TikTok Shop search results grid for "${keyword}" using the back key.`, o => pageOf(o.answers as Answers) === 'results_grid')
        if (misses === 0)
          setGoal('return')
        break
      }
    }
  }

  /**
   * Where to continue after a relaunch or on the home feed: home / Shop → search again (seen
   * products stay deduplicated by ID), search page → type, grid → pick, product → copy.
   * `wait` when the screen is not recognisable yet (splash).
   */
  function relocate(page: Page | 'uncertain', home: boolean, shareOpen: boolean): Goal | 'wait' | undefined {
    const searching = goal === 'reach_search' || goal === 'type' || goal === 'results'
    if (home || page === 'shop_home') {
      newPage()
      scrolls = 0
      typed = 0
      card = undefined
      videoBacks = 0
      return 'reach_search'
    }
    if (page === 'search_input') {
      typed = 0
      return 'type'
    }
    // Before the search was submitted, other screens are handled by the current step.
    if (searching)
      return page === 'uncertain' || page === 'other' ? 'wait' : undefined
    // A video opened from a product or card (not the home feed): back out to the grid.
    if (page === 'video_feed' || page === 'live_room')
      return 'return'
    if (page === 'results_grid')
      return goal === 'return' ? 'return' : 'pick'
    if (page === 'product_detail' || shareOpen)
      return goal === 'copy' ? 'copy' : 'open_share'
    return page === 'uncertain' || page === 'other' ? 'wait' : undefined
  }

  /** Picks the next qualifying card on the grid, scrolling when the visible ones are used up. */
  async function pick(obs: Observation<any>, a: Answers): Promise<void> {
    const cards: CardView[] = CARD_POSITIONS.map(position => ({
      position,
      product: a[`${position}_price`].noul,
      sold: a[`${position}_sold`].noul,
      live: a[`${position}_live`].noul,
      ad: a[`${position}_ad`].noul,
      box: a[`${position}_card`],
    }))
    // Right-column boxes often come back wrong on the real grid (spanning both columns, or a copy
    // of the left card). The grid is two symmetric columns, so mirror the left card of the row.
    const mirrored = new Set<CardPosition>()
    for (const [right, left] of [[1, 0], [3, 2]] as const) {
      const view = cards[right]
      const partner = cards[left]
      if ((view.product < 0.5 && !pageQualified.has(view.position)) || located(undefined, view.box, `${view.position}_card`, true) || !located(undefined, partner.box, `${partner.position}_card`, true))
        continue
      const { top, bottom, left: l, right: r } = partner.box.box
      view.box = { type: 'box', box: { top, bottom, left: 1 - r, right: 1 - l }, confidence: partner.box.confidence }
      mirrored.add(view.position)
      rt.decide(`${view.position} box mirrored from ${partner.position}`)
    }
    // A product card is a card with a visible price and no LIVE badge (optionally no Ad label).
    for (const view of cards) {
      if (view.product >= 0.5 && view.live < 0.5 && (!params.skipAds || view.ad < 0.5))
        pageQualified.add(view.position)
    }
    const qualified = cards.filter(view => pageQualified.has(view.position) && view.live < 0.5 && !liveMarked.has(view.position))
    const skipped = cards.filter(view => view.product >= 0.5 && !qualified.includes(view)).map(view => `${view.position}(${view.live >= 0.5 ? 'LIVE' : liveMarked.has(view.position) ? 'opened a LIVE room' : 'ad'})`)
    rt.decide(`cards: ${qualified.map(view => view.position).join(', ') || 'none'} qualify${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}; opened ${[...opened].join(', ') || 'none'}`)
    const view = qualified.find(candidate => !opened.has(candidate.position))
    if (view) {
      opened.add(view.position)
      card = { position: view.position, ad: view.ad >= 0.5, sold: view.sold >= 0.5 }
      shareTaps = 0
      shareWaits = 0
      if (located(undefined, view.box, `${view.position}_card`)) {
        setGoal('open_share')
        if (await rt.tap(obs, jevBoxCenter(view.box.box), `${view.position} card`, { coordSource: mirrored.has(view.position) ? 'jev_box_mirrored' : 'jev_box' }))
          cardJustTapped = true
        else
          setGoal('pick')
        return
      }
      setGoal('open_share')
      await rt.takeover(`Open the product card in the ${POSITION_WORDS[view.position]} position of the TikTok Shop results grid by tapping its photo. Stop when its product page shows.`, o => pageOf(o.answers as Answers) === 'product_detail', `card box confidence ${(view.box.confidence ?? 0).toFixed(2)} is below ${T.box}`)
      return
    }
    // Cards not rendered yet (the grid loads after the results header): wait instead of scrolling.
    if (!cards.some(view => view.product >= 0.5) && gridWaits < 2) {
      gridWaits++
      rt.decide('no product cards visible yet; wait for the grid')
      await rt.sleep(1200)
      return
    }
    gridWaits = 0
    if (scrolls >= params.maxScrolls)
      throw new PlaybookEnd(items.length ? `only ${items.length} of ${params.count} links after ${scrolls} scrolls` : `no product cards found after ${scrolls} scrolls`)
    // Slow drag (no fling) that brings the bottom row up under the header, then start from the top-left again.
    const bottomTop = cards[2].product >= 0.5 && located(undefined, cards[2].box, 'bottom_left_card', true) ? cards[2].box.box.top : undefined
    const distance = bottomTop === undefined ? 0.45 : Math.min(0.7, Math.max(0.25, bottomTop - 0.22))
    scrolls++
    newPage()
    await rt.swipe({ x: 0.5, y: 0.85 }, { x: 0.5, y: 0.85 - distance }, 900, `scroll ${scrolls}`)
  }
}

/** Ends the playbook as failed with the partial result. */
class PlaybookEnd extends Error {}

export const tiktokShopLinks: PlaybookDefinition<TiktokShopLinksParams> = {
  id: 'tiktok-shop-links',
  description: 'TikTok Shop: search a keyword and copy the first N product links (Share → Copy link). Result: {keyword, links, productIds, noResults, items, duplicates, unresolved, searchEpochs, researched}; only links that resolve to a product ID count.',
  params: tiktokShopLinksParams,
  allowedPackages: [TIKTOK_PACKAGE],
  async run(rt, params) {
    try {
      return await run(rt, params)
    }
    catch (error) {
      if (error instanceof PlaybookEnd)
        return { success: false, result: rt.partial, reason: error.message }
      throw error
    }
  },
}
