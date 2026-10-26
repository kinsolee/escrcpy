import { boundsArea, boundsCenter, boundsHeight, boundsWidth } from './geometry.js'
import type { UiNode, UiTree } from './ui-tree.js'

/**
 * Compact element shape shown to an agent (and stored in trace snapshots).
 * Field names follow madb's `get_screen_state` output so the reverse-engineered
 * prompts keep working. Boolean states are present only when they carry information.
 */
export interface UiElement {
  /** Node id inside the snapshot's tree. */
  id: number
  type: string
  text: string
  contentDesc: string
  resourceId: string
  className: string
  bounds: { x: number, y: number, width: number, height: number }
  centerX: number
  centerY: number
  clickable?: true
  scrollable?: true
  focused?: true
  checked?: true
  selected?: true
  enabled?: false
}

/** Class name suffixes that are worth showing even when the node is not clickable. */
const INTERACTIVE_SUFFIXES = [
  'Button',
  'ImageButton',
  'RadioButton',
  'ToggleButton',
  'CompoundButton',
  'FloatingActionButton',
  'Chip',
  'CheckBox',
  'CheckedTextView',
  'Switch',
  'SwitchCompat',
  'EditText',
  'AutoCompleteTextView',
  'TextView',
  'ImageView',
  'Spinner',
  'SeekBar',
  'RatingBar',
  'ProgressBar',
  'RecyclerView',
  'ListView',
  'GridView',
  'ScrollView',
  'HorizontalScrollView',
  'ViewPager',
  'WebView',
]

/** Rows closer than this many pixels are treated as the same line when sorting. */
export const ROW_TOLERANCE = 10

export const PASSWORD_PLACEHOLDER = '[password field]'

export function shortClassName(className: string): string {
  const dot = className.lastIndexOf('.')
  return dot === -1 ? className : className.slice(dot + 1)
}

function isInteractiveClass(className: string): boolean {
  const short = shortClassName(className)
  return INTERACTIVE_SUFFIXES.some(suffix => short.endsWith(suffix))
}

export function isVisible(node: UiNode): boolean {
  return boundsArea(node.bounds) > 0
}

/** Rule for which nodes appear in the agent-facing list. */
export function isListedNode(node: UiNode): boolean {
  if (!isVisible(node))
    return false
  if (!node.clickable && !isInteractiveClass(node.className))
    return false
  return Boolean(node.text || node.contentDesc || node.resourceId)
}

/**
 * Sort nodes in reading order: top to bottom, then left to right.
 * Nodes whose top edges are within ROW_TOLERANCE of a row's first node share that row.
 */
export function sortReadingOrder<T extends Pick<UiNode, 'bounds' | 'id'>>(nodes: T[]): T[] {
  const byTop = [...nodes].sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left || a.id - b.id)
  const rows = new Map<T, number>()
  let row = -1
  let rowTop = Number.NEGATIVE_INFINITY
  for (const node of byTop) {
    if (node.bounds.top - rowTop > ROW_TOLERANCE) {
      row++
      rowTop = node.bounds.top
    }
    rows.set(node, row)
  }
  return byTop.sort((a, b) => rows.get(a)! - rows.get(b)! || a.bounds.left - b.bounds.left || a.id - b.id)
}

export function toElement(node: UiNode): UiElement {
  const center = boundsCenter(node.bounds)
  const element: UiElement = {
    id: node.id,
    type: shortClassName(node.className),
    text: node.password && node.text ? PASSWORD_PLACEHOLDER : node.text,
    contentDesc: node.contentDesc,
    resourceId: node.resourceId,
    className: node.className,
    bounds: {
      x: node.bounds.left,
      y: node.bounds.top,
      width: boundsWidth(node.bounds),
      height: boundsHeight(node.bounds),
    },
    centerX: center.x,
    centerY: center.y,
  }
  if (node.clickable)
    element.clickable = true
  if (node.scrollable)
    element.scrollable = true
  if (node.focused)
    element.focused = true
  if (node.checked)
    element.checked = true
  if (node.selected)
    element.selected = true
  if (!node.enabled)
    element.enabled = false
  return element
}

/** The agent-facing element list for a tree, in reading order. */
export function extractElements(tree: UiTree): UiElement[] {
  return sortReadingOrder(tree.nodes.filter(isListedNode)).map(toElement)
}
