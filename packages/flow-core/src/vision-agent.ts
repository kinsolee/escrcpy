import type { Buffer } from 'node:buffer'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import {
  ancestorsOf,
  boundsArea,
  boundsContain,
  closestClickable,
  encodeScreenshot,
  extractElements,
  fingerprintDistance,
  parseUiTree,
  screenFingerprint,
  withLease,
  withTimeout,
} from '@escrcpy/flow-device'
import type { DeviceLease, EncodedImage, EncodeOptions, ForegroundApp, RatioPoint, ScreenFingerprint, UiNode, UiTree } from '@escrcpy/flow-device'
import { HealError } from './heal.js'
import { JevImage, requireJevClient, summarizeJevAnswer } from './jev.js'
import type { JevClient, JevNoulQuestion, JevQuestions } from './jev.js'
import { visualRiskCheck } from './jev-vision.js'
import { CONSENT_NEEDS_HUMAN, CONSENT_QUESTION, CONSENT_THRESHOLD, describeConsent, detectConsentInTree } from './consent.js'
import type { ConsentDetection } from './consent.js'
import { createVisionLlmClient, redactSecret } from './vision-llm.js'
import type { LlmUsage, VisionLlmClient, VisionLlmClientOptions, VisionLlmEndpoint, VisionLlmResponse } from './vision-llm.js'

/**
 * Vision agent: a model looks at the live screen and drives the device step by
 * step toward a natural-language goal, with no recorded script. Safety is
 * enforced here, not left to the model: actions only run while an allowed app
 * is in the foreground, taps on controls labelled with forbidden texts are
 * refused, and step / time / model-call budgets are hard limits.
 */

// ---------------------------------------------------------------------------
// Device surface

/** Everything the vision agent needs from a device. `visionDeviceFromFlowDevice` adapts the flow-device + adbx stack. */
export interface VisionAgentDevice {
  /** Raw PNG screencap. */
  screencap: (serial: string) => Promise<Buffer>
  foregroundApp: (serial: string) => Promise<ForegroundApp | undefined>
  /** One UI dump, no retries; the runner applies its own short timeout. */
  uiTree?: (serial: string) => Promise<UiTree>
  tap: (serial: string, point: RatioPoint) => Promise<unknown>
  longPress: (serial: string, point: RatioPoint, durationMs: number) => Promise<unknown>
  swipe: (serial: string, from: RatioPoint, to: RatioPoint, durationMs: number) => Promise<unknown>
  inputText: (serial: string, text: string) => Promise<unknown>
  key: (serial: string, key: 'BACK' | 'HOME' | 'ENTER') => Promise<unknown>
  /** Launch an app by package, optionally force-stopping it first. Used only by the runner's own recovery. */
  startApp: (serial: string, pkg: string, options?: { restart?: boolean }) => Promise<void>
  readClipboard?: (serial: string) => Promise<string>
  /** Used by playbooks to put a sentinel on the clipboard before "Copy link", so a read proves a fresh copy. */
  writeClipboard?: (serial: string, text: string) => Promise<void>
  /** Clears the focused text field (move to end + delete). Used by playbooks before typing a keyword. */
  clearText?: (serial: string) => Promise<void>
  /** Turns the screen on (KEYCODE_WAKEUP: never toggles it off). A dozing device screencaps solid black. */
  wake?: (serial: string) => Promise<void>
  /** Defaults to flow-device's `encodeScreenshot`. */
  encode?: (png: Buffer, options: EncodeOptions) => Promise<EncodedImage>
  /** Defaults to flow-device's `screenFingerprint`. */
  fingerprint?: (png: Buffer) => Promise<ScreenFingerprint | undefined>
}

/** Structural slice of a flow-device `FlowDevice`. */
export interface VisionFlowDeviceLike {
  screencap: (serial: string) => Promise<Buffer>
  foregroundApp: (serial: string) => Promise<ForegroundApp | undefined>
  tap: (serial: string, target: RatioPoint) => Promise<unknown>
  longPress: (serial: string, target: RatioPoint, opts?: { durationMs?: number }) => Promise<unknown>
  swipe: (serial: string, from: RatioPoint, to: RatioPoint, durationMs?: number) => Promise<unknown>
  inputText: (serial: string, text: string) => Promise<unknown>
  key: (serial: string, key: number | string) => Promise<unknown>
}

/** Structural slice of an adbx backend. */
export interface VisionBackendLike {
  shell: (serial: string, command: string) => Promise<string>
  ui?: { dumpLayout: (serial: string) => Promise<string> }
  clipboard?: { read: (serial: string) => Promise<string>, write?: (serial: string, text: string) => Promise<unknown> }
  yadb?: { isAvailable: () => boolean }
}

const PACKAGE_RE = /^[A-Z][\w.]*$/i

export function visionDeviceFromFlowDevice(device: VisionFlowDeviceLike, backend: VisionBackendLike): VisionAgentDevice {
  return {
    screencap: serial => device.screencap(serial),
    foregroundApp: serial => device.foregroundApp(serial),
    ...(backend.ui ? { uiTree: async (serial: string) => parseUiTree(await backend.ui!.dumpLayout(serial)) } : {}),
    tap: (serial, point) => device.tap(serial, point),
    longPress: (serial, point, durationMs) => device.longPress(serial, point, { durationMs }),
    swipe: (serial, from, to, durationMs) => device.swipe(serial, from, to, durationMs),
    inputText: (serial, text) => device.inputText(serial, text),
    key: (serial, key) => device.key(serial, key),
    async startApp(serial, pkg, options) {
      if (!PACKAGE_RE.test(pkg))
        throw new HealError(`invalid package name: ${pkg}`)
      if (options?.restart)
        await backend.shell(serial, `am force-stop ${pkg}`)
      await backend.shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
    },
    ...(backend.clipboard && (backend.yadb?.isAvailable() ?? true) ? { readClipboard: (serial: string) => backend.clipboard!.read(serial) } : {}),
    ...(backend.clipboard?.write && (backend.yadb?.isAvailable() ?? true) ? { writeClipboard: async (serial: string, text: string) => void await backend.clipboard!.write!(serial, text) } : {}),
    async clearText(serial) {
      await backend.shell(serial, `input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(48).trim()}`)
    },
    async wake(serial) {
      await backend.shell(serial, 'input keyevent KEYCODE_WAKEUP')
    },
  }
}

// ---------------------------------------------------------------------------
// Forbidden texts

/** Default labels that must never be tapped: social actions, purchases, coupons, messaging (en / zh / pt / es). */
export const DEFAULT_FORBIDDEN_TEXTS: readonly string[] = [
  'Like',
  'Follow',
  'Add to cart',
  'Buy now',
  'Checkout',
  'Place order',
  'Send',
  'Claim',
  'Subscribe',
  'Message',
  'Chat',
  'Comment',
  // The cart page holds checkout buttons; opening it is already outside a read-only task.
  'Cart',
  '关注',
  '点赞',
  '加入购物车',
  '立即购买',
  '下单',
  '发送',
  '领取',
  '私信',
  '评论',
  'Seguir',
  'Curtir',
  'Comprar',
  'Adicionar ao carrinho',
  'Añadir al carrito',
  'Agregar al carrito',
  'Finalizar',
  'Enviar',
  'Resgatar',
  'Mensagem',
  'Mensaje',
  'Conversar',
  'Me gusta',
  'Comentar',
  'Carrinho',
  'Carrito',
  '购物车',
  // Accepting terms / policies / agreements is a human's decision (see consent.ts).
  'Agree',
  'I agree',
  'Accept',
  'Accept all',
  'Concordo',
  'Aceito',
  'Aceitar',
  'Acepto',
  'Aceptar',
  '同意',
  '接受',
  '我同意',
]

/** Hiragana/Katakana, CJK ideographs, Hangul: scripts written without spaces between words. */
const CJK_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The forbidden term a label contains, if any. Latin terms match whole words
 * (so "Follow" blocks "Follow" and "Follow back" but not "Following"), CJK
 * terms match as substrings. Case and width are ignored.
 */
export function matchForbiddenText(label: string, terms: readonly string[]): string | undefined {
  const text = normalizeLabel(label)
  if (!text)
    return undefined
  for (const term of terms) {
    const needle = normalizeLabel(term)
    if (!needle)
      continue
    if (CJK_RE.test(needle)) {
      if (text.includes(needle))
        return term
      continue
    }
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, 'u').test(text))
      return term
  }
  return undefined
}

export interface TapCheck {
  /** `blocked`: a label on the tap path matches a forbidden term. `unverified`: no UI tree to check against. */
  verdict: 'ok' | 'blocked' | 'unverified'
  term?: string
  label?: string
  /** Labels collected from the hit node, its ancestors up to the clickable one, and a small clickable's descendants. */
  labels: string[]
  /** True when the tap path carries no text at all, so the check could not see what the control is. */
  unlabeled?: boolean
  /** Set when an unlabeled control was blocked because its small group (e.g. a purchase bar) holds a forbidden label. */
  grouped?: boolean
}

/** Clickable containers up to this share of the screen are treated as buttons whose child labels name them. */
const BUTTON_AREA_SHARE = 0.03
/** An unlabeled control is judged by the labels of its enclosing group up to this share of the screen (an action bar, not a page). */
const GROUP_AREA_SHARE = 0.1

function descendantLabels(tree: UiTree, root: UiNode): string[] {
  const labels: string[] = []
  const stack = [...root.children]
  while (stack.length) {
    const node = tree.nodes[stack.pop()!]
    if (!node)
      continue
    labels.push(...nodeLabels(node))
    stack.push(...node.children)
  }
  return labels
}

/**
 * A label that says what the control is. Unresolved resource references such as "@2131823611"
 * and other letter-free strings name nothing: treat them as no label, so the control counts as
 * unlabeled (and gets the visual check) instead of passing the forbidden-text check.
 */
export function isMeaningfulLabel(value: string | undefined): value is string {
  return !!value && /\p{L}/u.test(value) && !/^@\d+$/.test(value.trim())
}

function nodeLabels(node: UiNode): string[] {
  return [node.text, node.contentDesc].filter(isMeaningfulLabel)
}

/**
 * Resolves a tap point (device pixels) to the element it lands on and checks
 * every label that names that control: the hit node, its ancestors up to the
 * nearest clickable one, and — for button-sized clickables — their descendants
 * (a "Follow" button is often a clickable frame around a "Follow" TextView).
 */
export function checkTapTarget(tree: UiTree | undefined, point: { x: number, y: number }, terms: readonly string[]): TapCheck {
  if (!tree || !tree.nodes.length)
    return { verdict: 'unverified', labels: [] }
  const screenArea = Math.max(1, tree.size.width * tree.size.height)
  const isSmall = (node: UiNode, share: number) => boundsArea(node.bounds) / screenArea <= share
  // Every node under the finger, in drawing order. The topmost one can be a transparent,
  // non-clickable overlay (TikTok's video page has a full-screen one); Android lets such a
  // view pass the touch through, so the control that really receives the tap is the topmost
  // clickable node, and small labelled nodes under the finger name it.
  const containing = tree.nodes.filter(node => boundsArea(node.bounds) > 0 && boundsContain(node.bounds, point))
  const hit = containing.at(-1)
  if (!hit)
    return { verdict: 'ok', labels: [], unlabeled: true }
  const touchTarget = [...containing].reverse().find(node => node.clickable || node.longClickable) ?? closestClickable(tree, hit)
  const path: UiNode[] = [hit]
  for (const start of [hit, touchTarget]) {
    if (!start)
      continue
    const clickable = closestClickable(tree, start)
    path.push(start)
    if (clickable && clickable !== start) {
      for (const ancestor of ancestorsOf(tree, start)) {
        path.push(ancestor)
        if (ancestor === clickable)
          break
      }
    }
  }
  path.push(...containing.filter(node => isSmall(node, BUTTON_AREA_SHARE)))
  if (touchTarget && isSmall(touchTarget, BUTTON_AREA_SHARE)) {
    const stack = [...touchTarget.children]
    while (stack.length) {
      const node = tree.nodes[stack.pop()!]
      if (!node)
        continue
      path.push(node)
      stack.push(...node.children)
    }
  }
  const labels = [...new Set(path.flatMap(nodeLabels))]
  for (const label of labels) {
    const term = matchForbiddenText(label, terms)
    if (term)
      return { verdict: 'blocked', term, label, labels }
  }
  if (labels.length)
    return { verdict: 'ok', labels }
  // An icon-only control (TikTok's add-to-cart button is a bare FrameLayout) cannot be named
  // directly; when its action bar also holds "Buy now" / "Follow" etc., refuse it conservatively.
  let group: UiNode | undefined
  for (const ancestor of ancestorsOf(tree, touchTarget ?? hit)) {
    if (!isSmall(ancestor, GROUP_AREA_SHARE))
      break
    group = ancestor
  }
  if (group) {
    for (const label of new Set(descendantLabels(tree, group))) {
      const term = matchForbiddenText(label, terms)
      if (term)
        return { verdict: 'blocked', term, label: `unlabeled control beside "${label}"`, labels: [], unlabeled: true, grouped: true }
    }
  }
  return { verdict: 'ok', labels, unlabeled: true }
}

// ---------------------------------------------------------------------------
// Actions

const coord = z.coerce.number().finite()
const point2 = z.tuple([coord, coord])

export const visionActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: coord.optional(), y: coord.optional(), element: z.coerce.number().int().min(0).optional() }),
  z.object({ type: z.literal('long_press'), x: coord.optional(), y: coord.optional(), element: z.coerce.number().int().min(0).optional(), duration_ms: z.coerce.number().int().min(200).max(5000).optional() }),
  z.object({ type: z.literal('swipe'), from: point2, to: point2, duration_ms: z.coerce.number().int().min(50).max(5000).optional() }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.coerce.number().min(0.1).max(0.9).optional() }),
  z.object({ type: z.literal('input_text'), text: z.string() }),
  z.object({ type: z.literal('key'), key: z.string().transform(value => value.trim().toLowerCase()).pipe(z.enum(['back', 'home', 'enter'])) }),
  z.object({ type: z.literal('wait'), ms: z.coerce.number().int().min(0).max(10_000).optional() }),
  z.object({ type: z.literal('read_clipboard') }),
  z.object({ type: z.literal('done'), success: z.boolean().optional(), result: z.unknown().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal('fail'), reason: z.string().optional() }),
])

export type VisionAction = z.infer<typeof visionActionSchema>

export const VISION_ACTION_TYPES = ['tap', 'long_press', 'swipe', 'scroll', 'input_text', 'key', 'wait', 'read_clipboard', 'done', 'fail'] as const

export interface VisionDecision {
  thought?: string
  action: VisionAction
}

/** Candidate JSON objects in model output: the whole text, fenced blocks, then balanced `{…}` spans from last to first. */
function jsonCandidates(text: string): unknown[] {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const found: unknown[] = []
  const tryParse = (value: string) => {
    try {
      found.push(JSON.parse(value))
    }
    catch {
      // not JSON
    }
  }
  tryParse(cleaned)
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    tryParse(match[1].trim())
  const starts: number[] = []
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{')
      starts.push(i)
  }
  for (const start of starts) {
    let depth = 0
    let inString = false
    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i]
      if (inString) {
        if (char === '\\')
          i++
        else if (char === '"')
          inString = false
        continue
      }
      if (char === '"') {
        inString = true
      }
      else if (char === '{') {
        depth++
      }
      else if (char === '}' && --depth === 0) {
        tryParse(cleaned.slice(start, i + 1))
        break
      }
    }
    if (found.length)
      break
  }
  return found
}

function normalizeActionObject(raw: Record<string, unknown>): Record<string, unknown> {
  const action: Record<string, unknown> = { ...raw }
  // Models sometimes write the action type as the key: {"tap":"element=5"}, {"tap":"element","element":10}, {"tap":[300,400]}.
  if (action.type === undefined && action.action === undefined && action.tool === undefined && action.name === undefined) {
    const key = (VISION_ACTION_TYPES as readonly string[]).find(type => type in action)
    if (key) {
      const value = action[key]
      delete action[key]
      action.type = key
      if (typeof value === 'string') {
        const element = value.match(/element\D*(\d+)/i)
        if (element && action.element === undefined)
          action.element = Number(element[1])
      }
      else if (Array.isArray(value) && value.length === 2 && action.x === undefined) {
        action.x = value[0]
        action.y = value[1]
      }
      else if (typeof value === 'number' && action.element === undefined) {
        action.element = value
      }
      else if (value && typeof value === 'object') {
        Object.assign(action, value)
      }
    }
  }
  const type = action.type ?? action.action ?? action.tool ?? action.name
  if (typeof type === 'string')
    action.type = type.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (Array.isArray(action.point) && action.x === undefined) {
    action.x = action.point[0]
    action.y = action.point[1]
  }
  if (action.type === 'swipe' && !action.from && action.x1 !== undefined) {
    action.from = [action.x1, action.y1]
    action.to = [action.x2, action.y2]
  }
  if (action.type === 'press_key' || action.type === 'keyevent')
    action.type = 'key'
  if (action.type === 'type' || action.type === 'input')
    action.type = 'input_text'
  return action
}

/**
 * Parses `{"thought": …, "action": {"type": …}}` (also accepts the flat
 * `{"type": …}` / `{"action": "tap", …}` shapes, code fences, prose around the
 * JSON and `<think>` blocks). Throws a HealError with a model-readable message.
 */
export function parseVisionDecision(text: string): VisionDecision {
  const candidates = jsonCandidates(text).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
  if (!candidates.length)
    throw new HealError(`reply is not a JSON object: ${text.slice(0, 160)}`)
  let lastError = ''
  for (const value of candidates) {
    const nested = value.action && typeof value.action === 'object' ? value.action as Record<string, unknown> : undefined
    const raw = normalizeActionObject(nested ?? value)
    const checked = visionActionSchema.safeParse(raw)
    if (checked.success) {
      const action = checked.data
      if ((action.type === 'tap' || action.type === 'long_press') && action.element === undefined && (action.x === undefined || action.y === undefined)) {
        lastError = `${action.type} needs x and y, or element`
        continue
      }
      return { thought: typeof value.thought === 'string' ? value.thought : undefined, action }
    }
    const issue = checked.error.issues[0]
    lastError = typeof raw.type === 'string' && !(VISION_ACTION_TYPES as readonly string[]).includes(raw.type)
      ? `action type "${raw.type}" is not allowed; use one of ${VISION_ACTION_TYPES.join(', ')}`
      : `invalid action: ${issue ? `${issue.path.join('.') || 'action'} ${issue.message}` : 'unknown shape'}`
  }
  throw new HealError(lastError)
}

// ---------------------------------------------------------------------------
// Options, events, results

export type VisionObserveMode = 'screenshot' | 'screenshot+tree'

export interface VisionAgentOptions {
  serial: string
  goal: string
  /** Shape the caller expects in `done.result`, e.g. `{ links: 'string[]', noResults: 'boolean' }` or a JSON-schema-ish object/string. */
  resultSchema?: unknown
  /** Foreground packages the agent may act in. Empty/undefined disables the foreground guard. */
  allowedPackages?: string[]
  /** Extra forbidden labels, added to `DEFAULT_FORBIDDEN_TEXTS` unless `replaceDefaultForbiddenTexts`. */
  forbiddenTexts?: string[]
  replaceDefaultForbiddenTexts?: boolean
  /** Default 30. */
  maxSteps?: number
  /** Hard cap on LLM requests (re-asks included). Default `maxSteps * 2`. */
  maxModelCalls?: number
  /** Wall-clock budget for the whole run. Default 10 min. */
  timeBudgetMs?: number
  /** Default `screenshot+tree`: the tree is attached only when it arrives within `treeTimeoutMs`. */
  observe?: VisionObserveMode
  /** Default 2000. */
  treeTimeoutMs?: number
  /** Model coordinates run 0..coordinateScale on both axes. Default 1000. */
  coordinateScale?: number
  /** Screenshot longest edge sent to the model. Default 1280. */
  imageMaxEdge?: number
  imageFormat?: 'jpeg' | 'png'
  /** Delay after each executed action before the next observation. Default 1200 ms. */
  settleMs?: number
  /** Consecutive actions without a visible screen change before the run ends as stuck. Default 3. */
  stuckThreshold?: number
  /** Mean grayscale difference (0~255) below which two screens count as unchanged. Default 0.6. */
  changeThreshold?: number
  /** How many times the runner relaunches an allowed app after the foreground left the allow-list. Default 1. */
  maxForegroundRecoveries?: number
  /** At start: launch the first allowed package when it is not in front (`if-needed`, default), force-restart it, or do nothing. */
  launch?: 'if-needed' | 'restart' | 'never'
  /** Endpoint (the client is built here, with retries) or a ready client. */
  endpoint?: VisionLlmEndpoint
  client?: VisionLlmClient
  llm?: VisionLlmClientOptions
  device: VisionAgentDevice
  /** When given, the run holds this device lease (reusing one this process already holds). */
  lease?: DeviceLease
  leaseHolder?: string
  signal?: AbortSignal
  onEvent?: (event: VisionAgentEvent) => void
  /** Directory for report.json and per-step screenshots. */
  runDir?: string
  /** Extra instructions appended to the system prompt. */
  instructions?: string
  /**
   * Jev assist (`true` = client from llm.json / FLOW_JEV_*): a visual check refuses taps on
   * social / purchase controls the UI tree cannot name, and a successful `done` is verified
   * (links must come from read_clipboard, the final screen must fit the claim). Jev never plans.
   */
  jev?: JevClient | boolean
  /** Extra yes/no checks on the final screen for a successful `done` (each must be ≥ 0.5); refer to the screenshot as \`screen\`. */
  jevDoneQuestions?: Record<string, JevNoulQuestion>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type VisionRunStatus = 'done' | 'failed' | 'stuck' | 'budget_exhausted' | 'guardrail' | 'aborted' | 'error'

export interface VisionStepRecord {
  index: number
  at: string
  screenshot?: string
  screen?: { width: number, height: number, sourceWidth: number, sourceHeight: number, mimeType: string }
  app?: ForegroundApp | null
  tree?: { elements: number, ms: number } | { error: string, ms: number }
  model?: { latencyMs: number, attempts: number, usage?: LlmUsage, raw: string, reask?: { raw: string, latencyMs: number, usage?: LlmUsage, error: string } }
  thought?: string
  action?: VisionAction | { type: 'recover', package: string } | { type: 'wake' }
  /** Device-space detail of the executed action, e.g. the tap point as a 0~1 ratio. */
  resolved?: Record<string, unknown>
  execution?: { ok: boolean, error?: string, durationMs: number, output?: string }
  guard?: { blocked: boolean, reason: string, term?: string, label?: string } | { unverifiedTap?: true, unlabeled?: true }
  screenChanged?: boolean
  /** Jev visual check of the tap target (jev assist). */
  visualCheck?: { probability?: number, latencyMs?: number, error?: string }
  /** Verification of a successful done (jev assist). */
  doneCheck?: { ok: boolean, reason?: string, links?: { count: number, missing: string[] }, answers?: Record<string, Record<string, unknown>>, latencyMs?: number, error?: string }
  /** Consent notice check before a touch: what was found (or the Jev probability / error when nothing was). */
  consent?: ConsentDetection & { latencyMs?: number, error?: string }
  error?: string
}

export interface VisionAgentResult {
  status: VisionRunStatus
  success: boolean
  result?: unknown
  reason: string
  steps: number
  modelCalls: number
  tokens: { prompt: number, completion: number, total: number }
  /** Calls whose response carried no usage block. */
  callsWithoutUsage: number
  durationMs: number
  /** Every read_clipboard value, in order — evidence for links the model reports. */
  clipboardReads: string[]
  guardrailBlocks: number
  unverifiedTaps: number
  /** Present when the Jev assist is on. */
  jev?: { calls: number, latencyMs: number, visualBlocks: number, doneRejections: number }
  /** Set when the run stopped at a terms / policy / consent notice (reason starts with consent_dialog_needs_human). */
  consent?: ConsentDetection & { screenshot?: string }
  runDir?: string
  reportPath?: string
}

export type VisionAgentEvent
  = | { type: 'step', step: VisionStepRecord }
    | { type: 'log', message: string }
    | { type: 'finish', result: VisionAgentResult }

export interface VisionAgentReport extends Omit<VisionAgentResult, 'status'> {
  /** `running` until the run ends. A report still `running` (no `finishedAt`) whose `pid` is dead was killed. */
  status: VisionRunStatus | 'running'
  pid: number
  /** Last time the report was written; a heartbeat for readers. */
  updatedAt?: string
  version: 1
  serial: string
  goal: string
  resultSchema?: unknown
  allowedPackages: string[]
  forbiddenTexts: string[]
  model?: { baseUrl: string, model: string, apiType: string }
  options: Record<string, unknown>
  startedAt: string
  finishedAt?: string
  stepLog: VisionStepRecord[]
}

// ---------------------------------------------------------------------------
// Prompt

function describeSchema(schema: unknown): string {
  if (schema === undefined)
    return '(none given: return a JSON object with whatever answers the goal)'
  return typeof schema === 'string' ? schema : JSON.stringify(schema)
}

export function buildVisionSystemPrompt(options: { allowedPackages: string[], coordinateScale: number, instructions?: string }): string {
  const s = options.coordinateScale
  const lines = [
    'You are an Android UI automation agent. Each turn you get the goal, a screenshot of the phone, the foreground app, an optional list of UI elements and the history of your previous actions. You reply with exactly ONE action as JSON; the runtime executes it and shows you the new screen next turn.',
    '',
    `Coordinates are integers in 0..${s} on both axes, relative to the screenshot: (0,0) is the top-left corner, (${s},${s}) the bottom-right, whatever its pixel size.`,
    '',
    'Actions:',
    `{"type":"tap","x":${s / 2},"y":${s * 0.3}}  or  {"type":"tap","element":12}  (element = index from the element list; prefer it when the target is listed)`,
    '{"type":"long_press","x":…,"y":…,"duration_ms":800}',
    '{"type":"scroll","direction":"down"}  direction = where you want to see more content ("down" reveals content below); optional "amount" 0.1~0.9 of the screen',
    '{"type":"swipe","from":[x,y],"to":[x,y],"duration_ms":300}',
    '{"type":"input_text","text":"…"}  types into the focused field; tap the field first',
    '{"type":"key","key":"back"}  key is back, home or enter (enter submits a search)',
    '{"type":"wait","ms":1500}  when the screen is still loading',
    '{"type":"read_clipboard"}  the clipboard text appears in your history next turn; use it after "Copy link"',
    '{"type":"done","success":true,"result":{…},"reason":"…"}  goal reached (or success:false when it provably cannot be reached)',
    '{"type":"fail","reason":"…"}  give up',
    '',
    'Reply format, and nothing else (no Markdown): {"thought":"one short sentence about what you see and why","action":{…}}',
    '',
    'Rules:',
    `- Stay inside the allowed app${options.allowedPackages.length > 1 ? 's' : ''}: ${options.allowedPackages.length ? options.allowedPackages.join(', ') : '(any)'}. Leaving it is reverted by the runtime and counts against you.`,
    '- Read-only: never like, follow, comment, message, share to a contact, add to cart, buy, check out, claim coupons, subscribe, log in or out, or change settings. The runtime blocks taps on such controls; when blocked, pick a different control.',
    '- Close pop-ups (coupons, promotions, permission prompts) with their close (X) button or the back key, never with their action button.',
    '- Never accept, agree to or acknowledge terms, policy, privacy or consent notices (not even with Got it / OK, and not by tapping around them). When one is on screen, reply fail; the runtime refuses every touch while it is there.',
    '- After every action, look at the new screenshot to confirm the effect before moving on. If nothing changed, do something different instead of repeating.',
    '- Never invent data. Every value in result must come from the screen or from read_clipboard output. Links must be copied with read_clipboard, not typed from memory.',
    '- When the goal is reached, return done with result in the requested shape.',
  ]
  if (options.instructions)
    lines.push('', 'Additional instructions:', options.instructions)
  return lines.join('\n')
}

interface PromptElement {
  index: number
  label: string
  box: [number, number, number, number]
  clickable: boolean
}

function promptElements(tree: UiTree, scale: number, limit = 60): PromptElement[] {
  const { width, height } = tree.size
  if (!width || !height)
    return []
  const norm = (value: number, size: number) => Math.round(Math.min(1, Math.max(0, value / size)) * scale)
  return extractElements(tree)
    .filter(element => isMeaningfulLabel(element.text) || isMeaningfulLabel(element.contentDesc) || element.clickable || element.className.endsWith('EditText'))
    .filter(element => element.bounds.width > 0 && element.bounds.height > 0)
    .slice(0, limit)
    .map((element, index) => {
      const text = isMeaningfulLabel(element.text) ? element.text : ''
      const desc = isMeaningfulLabel(element.contentDesc) ? element.contentDesc : ''
      const label = [text && `"${text.slice(0, 60)}"`, desc && `desc="${desc.slice(0, 60)}"`, !text && !desc && element.resourceId ? `id=${element.resourceId.split('/').at(-1)}` : '']
        .filter(Boolean)
        .join(' ')
      return {
        index,
        label: `${element.type}${label ? ` ${label}` : ''}`,
        box: [
          norm(element.bounds.x, width),
          norm(element.bounds.y, height),
          norm(element.bounds.x + element.bounds.width, width),
          norm(element.bounds.y + element.bounds.height, height),
        ],
        clickable: !!element.clickable,
      }
    })
}

function describeAction(action: VisionStepRecord['action']): string {
  if (!action)
    return '(none)'
  const { type, ...rest } = action as Record<string, unknown>
  const detail = Object.entries(rest).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : JSON.stringify(value)}`).join(' ')
  return `${type}${detail ? ` ${detail}` : ''}`
}

function describeStep(step: VisionStepRecord): string {
  const parts = [describeAction(step.action)]
  if (step.guard && 'blocked' in step.guard && step.guard.blocked)
    parts.push(`→ BLOCKED by runtime: ${step.guard.reason}`)
  else if (step.execution && !step.execution.ok)
    parts.push(`→ failed: ${step.execution.error}`)
  else if (step.execution?.output !== undefined)
    parts.push(`→ ${step.execution.output}`)
  else if (step.error)
    parts.push(`→ ${step.error}`)
  else if (step.execution)
    parts.push('→ ok')
  if (step.screenChanged === false)
    parts.push('(screen did not change)')
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Runner

const MAX_HISTORY = 12
/** Relaunches during cold start (before the first model call) that do not count as recoveries. */
const MAX_COLD_RECOVERIES = 3
/** Automatic screen wake-ups per run before a black screen is left to the model. */
const MAX_WAKES = 3

/** A screen whose brightest fingerprint pixel is this dark is off (dozing) rather than a dark UI. */
export function isBlackScreen(fingerprint: ScreenFingerprint | undefined): boolean {
  if (!fingerprint)
    return false
  let max = 0
  for (const value of fingerprint.data)
    max = Math.max(max, value)
  return max < 6
}

class BudgetSignal extends Error {}
class AbortedSignal extends Error {}

const isStop = (error: unknown) => error instanceof BudgetSignal || error instanceof AbortedSignal

export async function runVisionAgent(options: VisionAgentOptions): Promise<VisionAgentResult> {
  if (options.lease)
    return withLease(options.lease, options.serial, { holder: options.leaseHolder ?? 'vision-agent' }, () => runUnleased(options))
  return runUnleased(options)
}

async function runUnleased(options: VisionAgentOptions): Promise<VisionAgentResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const { serial, device } = options
  const maxSteps = options.maxSteps ?? 30
  const maxModelCalls = options.maxModelCalls ?? maxSteps * 2
  const timeBudgetMs = options.timeBudgetMs ?? 10 * 60_000
  const observe = options.observe ?? 'screenshot+tree'
  const treeTimeoutMs = options.treeTimeoutMs ?? 2000
  const scale = options.coordinateScale ?? 1000
  const settleMs = options.settleMs ?? 1200
  const stuckThreshold = options.stuckThreshold ?? 3
  const changeThreshold = options.changeThreshold ?? 0.6
  const maxRecoveries = options.maxForegroundRecoveries ?? 1
  const allowed = (options.allowedPackages ?? []).filter(Boolean)
  const forbidden = [...(options.replaceDefaultForbiddenTexts ? [] : DEFAULT_FORBIDDEN_TEXTS), ...(options.forbiddenTexts ?? [])]
  const encode = device.encode ?? encodeScreenshot
  const fingerprintOf = device.fingerprint ?? screenFingerprint
  const secret = options.endpoint?.apiKey
  const redact = (text: string) => redactSecret(text, secret)
  const client = options.client ?? (options.endpoint ? createVisionLlmClient(options.endpoint, options.llm) : undefined)
  if (!client)
    throw new HealError('vision agent needs an LLM endpoint or client')
  const jevClient = options.jev === true ? requireJevClient() : options.jev || undefined
  const jevStats = { calls: 0, latencyMs: 0, visualBlocks: 0, doneRejections: 0 }

  const started = now()
  const deadline = started + timeBudgetMs
  const stepLog: VisionStepRecord[] = []
  const clipboardReads: string[] = []
  const tokens = { prompt: 0, completion: 0, total: 0 }
  let modelCalls = 0
  let callsWithoutUsage = 0
  let guardrailBlocks = 0
  let unverifiedTaps = 0
  let recoveries = 0
  let coldRecoveries = 0
  let wakes = 0
  let unchanged = 0
  let notes: string[] = []
  let lastClipboard: string | undefined
  const system = buildVisionSystemPrompt({ allowedPackages: allowed, coordinateScale: scale, instructions: options.instructions })

  const runDir = options.runDir
  const reportPath = runDir ? join(runDir, 'report.json') : undefined
  if (runDir)
    await mkdir(runDir, { recursive: true })
  const report: VisionAgentReport = {
    version: 1,
    serial,
    goal: options.goal,
    ...(options.resultSchema !== undefined ? { resultSchema: options.resultSchema } : {}),
    allowedPackages: allowed,
    forbiddenTexts: forbidden,
    model: client.describe(),
    options: { maxSteps, maxModelCalls, timeBudgetMs, observe, treeTimeoutMs, coordinateScale: scale, settleMs, stuckThreshold, changeThreshold, maxForegroundRecoveries: maxRecoveries, launch: options.launch ?? 'if-needed', imageMaxEdge: options.imageMaxEdge ?? 1280 },
    startedAt: new Date(started).toISOString(),
    status: 'running',
    pid: process.pid,
    success: false,
    reason: 'running',
    steps: 0,
    modelCalls: 0,
    tokens,
    callsWithoutUsage: 0,
    durationMs: 0,
    clipboardReads,
    guardrailBlocks: 0,
    unverifiedTaps: 0,
    stepLog,
    ...(runDir ? { runDir, reportPath } : {}),
  }

  // Internal abort: the caller's signal or the time budget, whichever comes first.
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const budgetTimer = setTimeout(() => controller.abort(new BudgetSignal('time budget exhausted')), Math.max(0, timeBudgetMs))
  const signal = controller.signal

  const emit = (event: VisionAgentEvent) => {
    try {
      options.onEvent?.(event)
    }
    catch {
      // A broken listener must not stop the run.
    }
  }
  const log = (message: string) => emit({ type: 'log', message })

  async function persist(): Promise<void> {
    if (!reportPath)
      return
    const snapshot = { ...report, steps: stepLog.length, modelCalls, tokens, callsWithoutUsage, guardrailBlocks, unverifiedTaps, durationMs: now() - started, updatedAt: new Date(now()).toISOString() }
    const tmp = `${reportPath}.tmp`
    await writeFile(tmp, redact(JSON.stringify(snapshot, null, 2)), 'utf8')
    await rename(tmp, reportPath)
  }

  function checkBudget(): void {
    if (options.signal?.aborted)
      throw new AbortedSignal('aborted by caller')
    if (now() >= deadline || (signal.aborted && signal.reason instanceof BudgetSignal))
      throw new BudgetSignal(`time budget of ${timeBudgetMs} ms exhausted`)
  }

  async function foreground(): Promise<ForegroundApp | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const app = await withTimeout(device.foregroundApp(serial), 5000, 'foreground app lookup')
        if (app)
          return app
      }
      catch (error) {
        log(`foreground lookup failed: ${(error as Error).message}`)
      }
    }
    return undefined
  }

  const isAllowed = (app: ForegroundApp | undefined) => !allowed.length || (!!app && allowed.includes(app.package))

  async function readTree(): Promise<{ tree?: UiTree, info: VisionStepRecord['tree'] }> {
    if (!device.uiTree)
      return { info: { error: 'device has no UI tree capability', ms: 0 } }
    const treeStarted = now()
    try {
      const tree = await withTimeout(device.uiTree(serial), treeTimeoutMs, 'UI tree')
      return { tree, info: { elements: tree.nodes.length, ms: now() - treeStarted } }
    }
    catch (error) {
      return { info: { error: (error as Error).message, ms: now() - treeStarted } }
    }
  }

  function finish(status: VisionRunStatus, reason: string, extra: { success?: boolean, result?: unknown, consent?: VisionAgentResult['consent'] } = {}): VisionAgentResult {
    const result: VisionAgentResult = {
      status,
      success: extra.success ?? false,
      ...(extra.result !== undefined ? { result: extra.result } : {}),
      ...(extra.consent ? { consent: extra.consent } : {}),
      reason: redact(reason),
      steps: stepLog.length,
      modelCalls,
      tokens: { ...tokens },
      callsWithoutUsage,
      durationMs: now() - started,
      clipboardReads: [...clipboardReads],
      guardrailBlocks,
      unverifiedTaps,
      ...(jevClient ? { jev: { ...jevStats } } : {}),
      ...(runDir ? { runDir, reportPath } : {}),
    }
    Object.assign(report, result, { finishedAt: new Date(now()).toISOString() })
    return result
  }

  async function callModel(request: Parameters<VisionLlmClient['complete']>[0]): Promise<VisionLlmResponse> {
    if (modelCalls >= maxModelCalls)
      throw new BudgetSignal(`model call budget of ${maxModelCalls} exhausted`)
    checkBudget()
    modelCalls++
    try {
      const response = await client!.complete(request, signal)
      if (response.usage) {
        tokens.prompt += response.usage.promptTokens
        tokens.completion += response.usage.completionTokens
        tokens.total = tokens.prompt + tokens.completion
      }
      else {
        callsWithoutUsage++
      }
      return response
    }
    catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof BudgetSignal ? signal.reason : new AbortedSignal('aborted by caller')
      throw error
    }
  }

  function toRatio(x: number, y: number): RatioPoint {
    const clamp = (value: number) => Math.min(1, Math.max(0, value / scale))
    return { x: clamp(x), y: clamp(y) }
  }

  async function loop(): Promise<VisionAgentResult> {
    // A dozing screen screencaps black and nothing reacts to taps; wake it first (never turns it off).
    if (device.wake)
      await device.wake(serial).catch(error => log(`wake failed: ${(error as Error).message}`))
    // Start inside an allowed app; this launch is the runner's, not a recovery.
    if (allowed.length && options.launch !== 'never') {
      const app = await foreground()
      if (options.launch === 'restart' || !isAllowed(app)) {
        log(`launching ${allowed[0]}${options.launch === 'restart' ? ' (restart)' : ''}`)
        await device.startApp(serial, allowed[0], { restart: options.launch === 'restart' })
        await sleep(Math.max(settleMs, 2500))
      }
    }
    if (device.readClipboard) {
      lastClipboard = await device.readClipboard(serial).catch(() => undefined)
    }

    let previousFingerprint: ScreenFingerprint | undefined
    let expectChange = false
    for (;;) {
      checkBudget()
      if (stepLog.length >= maxSteps)
        throw new BudgetSignal(`step budget of ${maxSteps} exhausted`)
      const index = stepLog.length + 1
      const step: VisionStepRecord = { index, at: new Date(now()).toISOString() }
      stepLog.push(step)

      // Observe.
      const [png, app, treeResult] = await Promise.all([
        withTimeout(device.screencap(serial), 15_000, 'screencap'),
        foreground(),
        observe === 'screenshot+tree' ? readTree() : Promise.resolve({ tree: undefined, info: undefined }),
      ])
      step.app = app ?? null
      if (treeResult.info)
        step.tree = treeResult.info
      const tree = treeResult.tree
      const image = await encode(png, { maxEdge: options.imageMaxEdge ?? 1280, format: options.imageFormat ?? 'jpeg', quality: 75 })
      step.screen = { width: image.width, height: image.height, sourceWidth: image.sourceWidth, sourceHeight: image.sourceHeight, mimeType: image.mimeType }
      if (runDir) {
        step.screenshot = `step-${String(index).padStart(3, '0')}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`
        await writeFile(join(runDir, step.screenshot), image.data)
      }
      const fingerprint = await fingerprintOf(png).catch(() => undefined)
      if (device.wake && wakes < MAX_WAKES && isBlackScreen(fingerprint)) {
        wakes++
        step.action = { type: 'wake' }
        const wakeStarted = now()
        await device.wake(serial).then(
          () => step.execution = { ok: true, durationMs: now() - wakeStarted, output: 'screen was black (display off); runtime sent WAKEUP' },
          error => step.execution = { ok: false, error: (error as Error).message, durationMs: now() - wakeStarted },
        )
        notes.push('The screen was black (display off); the runtime woke it up.')
        emit({ type: 'step', step })
        await persist()
        await sleep(Math.max(settleMs, 1500))
        previousFingerprint = undefined
        expectChange = false
        continue
      }
      if (expectChange && previousFingerprint && fingerprint) {
        const changed = fingerprintDistance(previousFingerprint, fingerprint) >= changeThreshold
        const last = stepLog[stepLog.length - 2]
        if (last)
          last.screenChanged = changed
        unchanged = changed ? 0 : unchanged + 1
        if (!changed)
          notes.push('Your previous action did not visibly change the screen.')
        if (unchanged >= stuckThreshold) {
          step.error = `screen unchanged after ${unchanged} consecutive actions`
          emit({ type: 'step', step })
          return finish('stuck', `stuck: the screen did not change after ${unchanged} consecutive actions`)
        }
      }
      previousFingerprint = fingerprint
      expectChange = false

      // Foreground guard before asking the model: never spend a call on a foreign app.
      if (!isAllowed(app)) {
        const recovered = await recoverForeground(step, app)
        if (!recovered) {
          return finish('guardrail', `foreground left the allowed apps again (${app?.package ?? 'unknown'}); stopped after ${recoveries - 1} recovery`)
        }
        continue
      }

      // Consent guard, free part: a terms / policy notice named in the UI tree ends the run before
      // the model is even asked (nothing on such a screen may be touched).
      const treeConsent = detectConsentInTree(tree)
      if (treeConsent.present) {
        step.consent = treeConsent
        emit({ type: 'step', step })
        await persist()
        return stopForConsent(treeConsent, step)
      }

      // Decide.
      const elements = tree ? promptElements(tree, scale) : []
      const text = buildStepText({ index, app, image, elements, treeAvailable: !!tree, observe })
      notes = []
      let response: VisionLlmResponse
      try {
        response = await callModel({ system, text, image: { data: image.data.toString('base64'), mimeType: image.mimeType } })
      }
      catch (error) {
        if (isStop(error))
          throw error
        step.error = redact(`model call failed: ${(error as Error).message}`)
        emit({ type: 'step', step })
        await persist()
        return finish('error', step.error)
      }
      step.model = { latencyMs: response.latencyMs, attempts: response.attempts, ...(response.usage ? { usage: response.usage } : {}), raw: redact(response.text) }
      let decision: VisionDecision | undefined
      try {
        decision = parseVisionDecision(response.text)
      }
      catch (error) {
        const parseError = (error as Error).message
        log(`step ${index}: unparseable reply (${parseError}); re-asking once`)
        let reask: VisionLlmResponse
        try {
          reask = await callModel({
            system,
            text,
            image: { data: image.data.toString('base64'), mimeType: image.mimeType },
            followUps: [{ assistant: response.text.slice(0, 2000), user: `Your reply could not be used: ${parseError}. Reply again with exactly one JSON object {"thought":"…","action":{"type":…}} and nothing else.` }],
          })
        }
        catch (reaskError) {
          if (isStop(reaskError))
            throw reaskError
          step.error = redact(`model re-ask failed: ${(reaskError as Error).message}`)
          emit({ type: 'step', step })
          await persist()
          return finish('error', step.error)
        }
        try {
          decision = parseVisionDecision(reask.text)
          step.model.reask = { raw: redact(reask.text), latencyMs: reask.latencyMs, ...(reask.usage ? { usage: reask.usage } : {}), error: parseError }
        }
        catch (secondError) {
          step.model.reask = { raw: redact(reask.text), latencyMs: reask.latencyMs, ...(reask.usage ? { usage: reask.usage } : {}), error: parseError }
          step.error = `unparseable reply twice: ${(secondError as Error).message}`
          notes.push(`Your last two replies were not valid actions (${(secondError as Error).message}).`)
          emit({ type: 'step', step })
          await persist()
          continue
        }
      }
      step.thought = decision.thought
      step.action = decision.action
      const action = decision.action

      // Terminal actions.
      if (action.type === 'done') {
        const success = action.success ?? true
        if (success && jevClient) {
          const verdict = await verifyDone(action.result, image)
          step.doneCheck = verdict
          if (!verdict.ok) {
            jevStats.doneRejections++
            emit({ type: 'step', step })
            await persist()
            if (jevStats.doneRejections > 2)
              return finish('failed', `done rejected ${jevStats.doneRejections} times by verification: ${verdict.reason}`)
            notes.push(`The runtime rejected your done: ${verdict.reason}. Fix this, then report done again.`)
            continue
          }
        }
        emit({ type: 'step', step })
        return finish(success ? 'done' : 'failed', action.reason ?? (success ? 'goal reached' : 'goal not reachable'), { success, result: action.result })
      }
      if (action.type === 'fail') {
        emit({ type: 'step', step })
        return finish('failed', action.reason ?? 'model gave up')
      }

      // Foreground guard right before executing: the screen may have moved on while the model thought.
      if (allowed.length && action.type !== 'wait' && action.type !== 'read_clipboard') {
        const current = await foreground()
        if (!isAllowed(current)) {
          step.guard = { blocked: true, reason: `foreground app ${current?.package ?? 'unknown'} is not allowed; action not executed` }
          guardrailBlocks++
          const recovered = await recoverForeground(step, current)
          if (!recovered) {
            return finish('guardrail', `foreground left the allowed apps again (${current?.package ?? 'unknown'})`)
          }
          continue
        }
      }

      // Consent guard before any touch: the UI tree, then (Jev assist) the screenshot. A notice
      // on screen ends the run; the model gets no second try at it.
      if (action.type === 'tap' || action.type === 'long_press' || action.type === 'swipe' || action.type === 'scroll' || (action.type === 'key' && action.key === 'enter')) {
        const consent = await consentBeforeTouch(tree, image)
        if (consent.present || consent.error || consent.probability !== undefined)
          step.consent = consent
        if (consent.present) {
          guardrailBlocks++
          step.guard = { blocked: true, reason: `terms / policy / consent notice on screen (${describeConsent(consent)}); ${action.type} not executed` }
          emit({ type: 'step', step })
          await persist()
          return stopForConsent(consent, step)
        }
      }

      // Execute.
      const execStarted = now()
      try {
        switch (action.type) {
          case 'tap':
          case 'long_press': {
            let point: RatioPoint
            if (action.element !== undefined) {
              const element = elements[action.element]
              if (!element || !tree)
                throw new HealError(`element ${action.element} is not in the current element list`)
              point = toRatio((element.box[0] + element.box[2]) / 2, (element.box[1] + element.box[3]) / 2)
            }
            else {
              point = toRatio(action.x!, action.y!)
            }
            step.resolved = { ratio: point }
            // Resolve against a fresh-enough tree: the observed one, or a quick dump when observing screenshots only.
            let checkTree = tree
            if (!checkTree && device.uiTree)
              checkTree = (await readTree()).tree
            const size = checkTree?.size
            const check = checkTapTarget(checkTree, size ? { x: point.x * size.width, y: point.y * size.height } : { x: 0, y: 0 }, forbidden)
            if (check.verdict === 'blocked') {
              guardrailBlocks++
              step.guard = { blocked: true, reason: `target "${check.label}" matches forbidden text "${check.term}"`, term: check.term, label: check.label }
              notes.push(`The runtime refused to tap "${check.label}" (forbidden). Choose another control.`)
              break
            }
            if (jevClient && (check.verdict === 'unverified' || check.unlabeled)) {
              try {
                const risk = await visualRiskCheck({ png, ratio: point, jev: jevClient, signal })
                jevStats.calls++
                jevStats.latencyMs += risk.jev.latencyMs
                step.visualCheck = { probability: Math.round(risk.probability * 1000) / 1000, latencyMs: risk.jev.latencyMs }
                if (risk.risky) {
                  guardrailBlocks++
                  jevStats.visualBlocks++
                  step.guard = { blocked: true, reason: `visual check: the control at the tap point looks like a social / purchase action (p=${risk.probability.toFixed(2)})` }
                  notes.push('The runtime refused that tap: the control looks like a like / follow / comment / message / cart / buy / claim button. Choose another control.')
                  break
                }
              }
              catch (error) {
                if (signal.aborted)
                  throw signal.reason instanceof BudgetSignal ? signal.reason : new AbortedSignal('aborted by caller')
                step.visualCheck = { error: redact((error as Error).message) }
              }
            }
            if (check.verdict === 'unverified') {
              unverifiedTaps++
              step.guard = { unverifiedTap: true }
            }
            else if (check.unlabeled) {
              step.guard = { unlabeled: true }
            }
            if (check.labels.length)
              step.resolved.labels = check.labels.slice(0, 6)
            if (action.type === 'tap')
              await device.tap(serial, point)
            else
              await device.longPress(serial, point, action.duration_ms ?? 800)
            expectChange = true
            break
          }
          case 'swipe': {
            const from = toRatio(action.from[0], action.from[1])
            const to = toRatio(action.to[0], action.to[1])
            step.resolved = { from, to }
            await device.swipe(serial, from, to, action.duration_ms ?? 300)
            expectChange = true
            break
          }
          case 'scroll': {
            const amount = action.amount ?? 0.5
            const half = amount / 2
            const vector: Record<typeof action.direction, [RatioPoint, RatioPoint]> = {
              down: [{ x: 0.5, y: 0.55 + half }, { x: 0.5, y: 0.55 - half }],
              up: [{ x: 0.5, y: 0.45 - half }, { x: 0.5, y: 0.45 + half }],
              right: [{ x: 0.5 + half, y: 0.5 }, { x: 0.5 - half, y: 0.5 }],
              left: [{ x: 0.5 - half, y: 0.5 }, { x: 0.5 + half, y: 0.5 }],
            }
            const [from, to] = vector[action.direction]
            step.resolved = { from, to }
            await device.swipe(serial, from, to, 400)
            expectChange = true
            break
          }
          case 'input_text':
            await device.inputText(serial, action.text)
            expectChange = true
            break
          case 'key':
            await device.key(serial, action.key === 'back' ? 'BACK' : action.key === 'home' ? 'HOME' : 'ENTER')
            expectChange = true
            break
          case 'wait':
            await sleep(Math.min(action.ms ?? 1500, Math.max(0, deadline - now())))
            break
          case 'read_clipboard': {
            if (!device.readClipboard)
              throw new HealError('clipboard is unavailable on this device (needs yadb)')
            const value = (await device.readClipboard(serial)).trim()
            const unchangedClip = value === lastClipboard
            lastClipboard = value
            clipboardReads.push(value)
            step.execution = { ok: true, durationMs: now() - execStarted, output: `clipboard=${JSON.stringify(value.slice(0, 500))}${unchangedClip ? ' (unchanged since the previous read — the copy may not have happened)' : ''}` }
            break
          }
        }
        if (!step.execution && !(step.guard && 'blocked' in step.guard))
          step.execution = { ok: true, durationMs: now() - execStarted }
      }
      catch (error) {
        step.execution = { ok: false, error: redact((error as Error).message), durationMs: now() - execStarted }
        expectChange = false
      }
      emit({ type: 'step', step })
      await persist()
      if (expectChange)
        await sleep(settleMs)
    }
  }

  let result: VisionAgentResult
  try {
    result = await loop()
  }
  catch (error) {
    if (error instanceof BudgetSignal)
      result = finish('budget_exhausted', error.message)
    else if (error instanceof AbortedSignal || options.signal?.aborted)
      result = finish('aborted', 'aborted by caller')
    else
      result = finish('error', (error as Error).message)
  }
  finally {
    clearTimeout(budgetTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
  await persist().catch(() => {})
  emit({ type: 'finish', result })
  return result

  /**
   * Jev assist for a successful done: every link in the result must appear in a clipboard
   * read (code), and the final screen must not contradict the claim (Jev Nouls). A Jev
   * failure does not block the done; it is recorded.
   */
  async function verifyDone(result: unknown, image: EncodedImage): Promise<NonNullable<VisionStepRecord['doneCheck']>> {
    const urls = [...new Set([...JSON.stringify(result ?? null).matchAll(/https?:\/\/[^\s"'\\]+/g)].map(match => match[0]))]
    const missing = urls.filter(url => !clipboardReads.some(read => read.includes(url)))
    const links = { count: urls.length, missing }
    if (missing.length)
      return { ok: false, reason: `these links were not read from the clipboard (copy each with Copy link, then read_clipboard): ${missing.join(', ')}`, links }
    const claimsNoResults = !!result && typeof result === 'object' && (result as Record<string, unknown>).noResults === true
    const questions: JevQuestions = {
      error_screen: { type: 'noul', instructions: 'Does `screen` show an error message, a login or sign-up prompt, or a page that failed to load?' },
      ...(claimsNoResults ? { no_results: { type: 'noul', instructions: 'Does `screen` show a message saying that no results were found for the search?' } } : {}),
      ...options.jevDoneQuestions,
    }
    try {
      const screen = new JevImage(image.data, image.mimeType === 'image/png' ? 'png' : 'jpg', image.width, image.height)
      const response = await jevClient!.ask({ state: { goal: options.goal, screen }, questions }, { signal })
      jevStats.calls++
      jevStats.latencyMs += response.latencyMs
      const answers = Object.fromEntries(Object.entries(response.answers).map(([name, answer]) => [name, summarizeJevAnswer(answer as never)]))
      const noul = (name: string) => (response.answers as Record<string, { noul: number }>)[name].noul
      const base = { links, answers, latencyMs: response.latencyMs }
      if (noul('error_screen') >= 0.85)
        return { ok: false, reason: 'the screen shows an error, a login prompt or a failed page', ...base }
      if (claimsNoResults && noul('no_results') < 0.5)
        return { ok: false, reason: 'result says noResults but the screen does not show a no-results message', ...base }
      for (const name of Object.keys(options.jevDoneQuestions ?? {})) {
        if (noul(name) < 0.5)
          return { ok: false, reason: `final-screen check "${name}" failed`, ...base }
      }
      return { ok: true, ...base }
    }
    catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof BudgetSignal ? signal.reason : new AbortedSignal('aborted by caller')
      return { ok: true, links, error: redact((error as Error).message) }
    }
  }

  /** Consent notice on the screen about to be touched: UI tree first, then one Jev question (when the assist is on). */
  async function consentBeforeTouch(observedTree: UiTree | undefined, image: EncodedImage): Promise<NonNullable<VisionStepRecord['consent']>> {
    let checkTree = observedTree
    if (!checkTree && device.uiTree)
      checkTree = (await readTree()).tree
    const fromTree = detectConsentInTree(checkTree)
    if (fromTree.present || !jevClient)
      return fromTree
    try {
      const screen = new JevImage(image.data, image.mimeType === 'image/png' ? 'png' : 'jpg', image.width, image.height)
      const response = await jevClient.ask({ state: { screen }, questions: { consent_dialog: CONSENT_QUESTION } }, { signal })
      jevStats.calls++
      jevStats.latencyMs += response.latencyMs
      const probability = response.answers.consent_dialog.noul
      return { present: probability > CONSENT_THRESHOLD, ...(probability > CONSENT_THRESHOLD ? { source: 'jev' as const } : {}), probability: Math.round(probability * 1000) / 1000, latencyMs: response.latencyMs }
    }
    catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof BudgetSignal ? signal.reason : new AbortedSignal('aborted by caller')
      return { present: false, error: redact((error as Error).message) }
    }
  }

  function stopForConsent(consent: ConsentDetection, step: VisionStepRecord): VisionAgentResult {
    const { present, source, term, text, probability } = consent
    return finish('failed', `${CONSENT_NEEDS_HUMAN}: a terms / policy / consent notice is on screen (${describeConsent(consent)}); automation must not confirm it`, {
      consent: { present, ...(source ? { source } : {}), ...(term ? { term } : {}), ...(text ? { text } : {}), ...(probability !== undefined ? { probability } : {}), ...(step.screenshot ? { screenshot: step.screenshot } : {}) },
    })
  }

  /** Relaunches the first allowed app once; false when the recovery budget is spent. */
  async function recoverForeground(step: VisionStepRecord, app: ForegroundApp | undefined): Promise<boolean> {
    // Before the first model call the app is still cold-starting (TikTok sometimes drops back to the
    // launcher on its own): those relaunches do not count against the recovery budget.
    const cold = modelCalls === 0 && coldRecoveries < MAX_COLD_RECOVERIES
    if (cold)
      coldRecoveries++
    else
      recoveries++
    const pkg = allowed[0]
    if (!cold && recoveries > maxRecoveries) {
      step.error = `foreground ${app?.package ?? 'unknown'} is outside ${allowed.join(', ')} and the recovery budget (${maxRecoveries}) is spent`
      emit({ type: 'step', step })
      return false
    }
    if (!step.action)
      step.action = { type: 'recover', package: pkg }
    const started = now()
    try {
      await device.startApp(serial, pkg)
      step.execution = { ok: true, durationMs: now() - started, output: `foreground was ${app?.package ?? 'unknown'}; runtime relaunched ${pkg}` }
    }
    catch (error) {
      step.execution = { ok: false, error: (error as Error).message, durationMs: now() - started }
    }
    notes.push(`The foreground app was ${app?.package ?? 'unknown'} (not allowed); the runtime brought ${pkg} back. Do not leave ${pkg} again.`)
    emit({ type: 'step', step })
    await persist()
    await sleep(Math.max(settleMs, 2000))
    return true
  }

  function buildStepText(ctx: { index: number, app: ForegroundApp | undefined, image: EncodedImage, elements: PromptElement[], treeAvailable: boolean, observe: VisionObserveMode }): string {
    const lines: string[] = []
    lines.push('## Goal', options.goal, '')
    lines.push('## Result shape for done.result', describeSchema(options.resultSchema), '')
    const remainingMs = Math.max(0, deadline - now())
    lines.push(`## Budget\nstep ${ctx.index}/${maxSteps}, model calls left ${maxModelCalls - modelCalls}, time left ${Math.round(remainingMs / 1000)} s`, '')
    lines.push(`## Foreground app\n${ctx.app ? `${ctx.app.package} / ${ctx.app.activity}` : 'unknown'}`, '')
    lines.push(`## Screen\nscreenshot ${ctx.image.width}x${ctx.image.height} (device ${ctx.image.sourceWidth}x${ctx.image.sourceHeight}); coordinates 0..${scale}`, '')
    if (ctx.observe === 'screenshot+tree') {
      if (!ctx.treeAvailable) {
        lines.push('## Elements', '(UI tree unavailable this turn; use screenshot coordinates)', '')
      }
      else if (!ctx.elements.length) {
        lines.push('## Elements', '(UI tree has no labelled elements here; use screenshot coordinates)', '')
      }
      else {
        lines.push('## Elements (index: label box=[left,top,right,bottom])')
        for (const element of ctx.elements)
          lines.push(`[${element.index}] ${element.label} box=[${element.box.join(',')}]${element.clickable ? ' clickable' : ''}`)
        lines.push('')
      }
    }
    const history = stepLog.slice(0, -1)
    lines.push('## Previous actions')
    if (!history.length) {
      lines.push('(none yet)')
    }
    else {
      const skipped = Math.max(0, history.length - MAX_HISTORY)
      if (skipped)
        lines.push(`(${skipped} earlier steps omitted)`)
      for (const step of history.slice(skipped))
        lines.push(`${step.index}. ${describeStep(step)}${step.thought ? `  // ${step.thought.slice(0, 120)}` : ''}`)
    }
    if (clipboardReads.length)
      lines.push('', '## Clipboard reads so far', ...clipboardReads.map((value, i) => `${i + 1}. ${JSON.stringify(value.slice(0, 300))}`))
    if (notes.length)
      lines.push('', '## Runtime notes', ...notes.map(note => `- ${note}`))
    lines.push('', 'Reply with one JSON object: {"thought":"…","action":{…}}')
    return lines.join('\n')
  }
}
