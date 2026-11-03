import { boundsArea } from '@escrcpy/flow-device'
import type { UiTree } from '@escrcpy/flow-device'
import type { JevNoulQuestion } from './jev.js'

/**
 * Consent guard: terms / policy / privacy / agreement notices must never be
 * confirmed by automation. While one is on screen every tap is refused (its
 * button, and the dimmed area around it, which can also count as
 * acknowledging); only code may leave the page (BACK, or force-stop and
 * relaunch), and a notice that survives that ends the run for a human.
 *
 * Detection: literal text in the UI tree, or a Jev Noul on the screenshot.
 */

/**
 * Jev question for a consent notice on the whole screen. Calibrated through
 * magpie on real TikTok frames: the "Virtual Items and Rewards Policies
 * update" dialog 1.0 (7 frames × 3), coupon popups / share panel 0.01,
 * 43 normal pages ≤ 0.07.
 */
export const CONSENT_QUESTION: JevNoulQuestion = {
  type: 'noul',
  instructions: 'Does `screen` show a popup, dialog or banner that asks the user to agree to, accept or acknowledge terms, a policy, a privacy notice or an agreement (for example a policy update notice)?',
  criteria: {
    true: { what: 'A notice about terms, policies, privacy or an agreement that the user is asked to accept, agree to or acknowledge', examples: ['"We updated our Terms of Service" with a Got it button', '"By continuing to use TikTok you agree to these policies"', 'a privacy or cookie consent banner with Accept or Agree'] },
    false: { what: 'No such notice on the screen', examples: ['a coupon or discount offer popup', 'a product page, a product grid or a search page', 'a share panel', 'a video feed'] },
  },
}

/** Above this the Jev answer counts as a consent notice. */
export const CONSENT_THRESHOLD = 0.5

/** On their own, these mark a consent notice. */
export const CONSENT_STRONG_TERMS: readonly string[] = [
  'agree',
  'consent',
  'continuing to use',
  'concordo',
  'aceito',
  'ao continuar',
  'acepto',
  'al continuar',
  '同意',
  '继续使用即',
]

/**
 * These appear in ordinary pages too ("Return policy", "Privacidade"), so they mark a consent
 * notice only together with an acknowledge-style button on the same screen.
 */
export const CONSENT_WEAK_TERMS: readonly string[] = [
  'policy',
  'policies',
  'terms',
  'privacy',
  'política',
  'políticas',
  'termos',
  'privacidade',
  'términos',
  '条款',
  '政策',
  '隐私',
  '协议',
]

/** Whole labels of buttons that acknowledge a notice. */
export const CONSENT_ACK_LABELS: readonly string[] = [
  'got it',
  'ok',
  'okay',
  'continue',
  'agree',
  'i agree',
  'accept',
  'accept all',
  'i understand',
  'understood',
  'entendi',
  'continuar',
  'concordo',
  'aceitar',
  'aceito',
  'aceptar',
  'acepto',
  'entendido',
  '知道了',
  '我知道了',
  '确定',
  '好的',
  '继续',
  '同意',
  '接受',
  '我同意',
]

const CJK_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Latin terms match whole words, CJK terms as substrings. */
function containsTerm(text: string, term: string): boolean {
  const needle = normalize(term)
  if (CJK_RE.test(needle))
    return text.includes(needle)
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, 'u').test(text)
}

export interface ConsentDetection {
  present: boolean
  source?: 'tree' | 'jev'
  /** Matched term and the text it was found in (tree). */
  term?: string
  text?: string
  /** Jev probability, when asked. */
  probability?: number
}

/** A consent notice in the UI tree: a strong term, or a weak term plus an acknowledge-style button. */
export function detectConsentInTree(tree: UiTree | undefined): ConsentDetection {
  if (!tree)
    return { present: false }
  const labels: string[] = []
  for (const node of tree.nodes) {
    if (node.className.endsWith('EditText'))
      continue
    if (boundsArea(node.bounds) <= 0)
      continue
    for (const value of [node.text, node.contentDesc]) {
      if (value && value.trim())
        labels.push(value)
    }
  }
  const normalized = labels.map(label => ({ label, text: normalize(label) }))
  for (const { label, text } of normalized) {
    const term = CONSENT_STRONG_TERMS.find(candidate => containsTerm(text, candidate))
    if (term)
      return { present: true, source: 'tree', term, text: label.slice(0, 160) }
  }
  const ack = normalized.some(({ text }) => CONSENT_ACK_LABELS.includes(text))
  if (!ack)
    return { present: false }
  for (const { label, text } of normalized) {
    const term = CONSENT_WEAK_TERMS.find(candidate => containsTerm(text, candidate))
    if (term)
      return { present: true, source: 'tree', term, text: label.slice(0, 160) }
  }
  return { present: false }
}

/** Combines the tree check with a Jev probability (when one was asked). */
export function detectConsent(tree: UiTree | undefined, probability?: number): ConsentDetection {
  const fromTree = detectConsentInTree(tree)
  if (fromTree.present)
    return { ...fromTree, ...(probability !== undefined ? { probability } : {}) }
  if (probability !== undefined && probability > CONSENT_THRESHOLD)
    return { present: true, source: 'jev', probability }
  return { present: false, ...(probability !== undefined ? { probability } : {}) }
}

export function describeConsent(detection: ConsentDetection): string {
  return detection.source === 'tree'
    ? `text "${detection.text}" (term "${detection.term}")`
    : `Jev ${(detection.probability ?? 0).toFixed(2)}`
}

/** Reason prefix of a run that stopped at a consent notice it must not confirm. */
export const CONSENT_NEEDS_HUMAN = 'consent_dialog_needs_human'
