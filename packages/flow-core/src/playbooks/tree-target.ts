import { boundsArea, closestClickable } from '@escrcpy/flow-device'
import type { RatioPoint, UiNode, UiTree } from '@escrcpy/flow-device'
import { isMeaningfulLabel, matchForbiddenText } from '../vision-agent.js'

/**
 * Coordinate rule (tk-shop-erp "点击坐标的来源"): a tap point comes from this
 * observation and is used once. When the UI tree has an element for the
 * target, the element wins; a Jev Box is the fallback, and a Box point whose
 * UI-tree labels contradict the target is not tapped.
 */

/** Where a tap point came from: a UI-tree element, a Jev Box (or a box mirrored from the other column), or computed from another control. */
export type CoordSource = 'tree' | 'jev_box' | 'jev_box_mirrored' | 'derived'

export const COORD_SOURCES: readonly CoordSource[] = ['tree', 'jev_box', 'jev_box_mirrored', 'derived']

/** Centre range (0..1 of the screen) a target's element must fall in. */
export interface CenterRegion {
  x?: [number, number]
  y?: [number, number]
}

/** Clickable containers up to this share of the screen count as one button (same as the forbidden-label check). */
const BUTTON_AREA_SHARE = 0.03
/** A clickable node smaller than this share of the screen is too small to aim at: its button-sized clickable ancestor is used. */
const TINY_AREA_SHARE = 0.0004

/** Case-insensitive whole-word match of a label against the expected labels (CJK as substrings). */
export function labelMatches(label: string, expected: readonly string[]): boolean {
  return !!matchForbiddenText(label, expected)
}

/** Labels found at a tap point that do not name the target, or undefined when one of them does (or there are none). */
export function labelMismatch(labels: readonly string[], expected: readonly string[] | undefined): string[] | undefined {
  if (!expected?.length || !labels.length)
    return undefined
  return labels.some(label => labelMatches(label, expected)) ? undefined : [...labels]
}

export interface TreeTarget {
  point: RatioPoint
  /** The labelled node, and the node whose centre is tapped (itself or its button-sized clickable ancestor). */
  label: string
  bounds: { left: number, top: number, right: number, bottom: number }
}

export type TreeTargetResult
  = | { found: TreeTarget }
    | { found?: undefined, candidates: number, reason: string }

/**
 * Looks the target up in the UI tree: nodes whose own text / content-desc
 * matches an expected label, with non-zero bounds and a centre inside
 * `region`. Each is resolved to the node to tap (itself when clickable and not
 * tiny, else its closest clickable ancestor when that is button-sized); nodes
 * resolving to the same control count once. Exactly one control → its centre.
 */
export function findTreeTarget(tree: UiTree | undefined, expected: readonly string[], region: CenterRegion): TreeTargetResult {
  if (!tree || !tree.nodes.length)
    return { candidates: 0, reason: 'no UI tree' }
  const { width, height } = tree.size
  if (!width || !height)
    return { candidates: 0, reason: 'UI tree has no size' }
  const screenArea = width * height
  const inside = (value: number, range?: [number, number]) => !range || (value >= range[0] && value <= range[1])
  const centerOf = (node: UiNode) => ({ x: (node.bounds.left + node.bounds.right) / 2 / width, y: (node.bounds.top + node.bounds.bottom) / 2 / height })
  const resolve = (node: UiNode): UiNode => {
    const area = boundsArea(node.bounds) / screenArea
    if ((node.clickable || node.longClickable) && area >= TINY_AREA_SHARE)
      return node
    const clickable = closestClickable(tree, node)
    if (clickable && clickable !== node && boundsArea(clickable.bounds) / screenArea <= BUTTON_AREA_SHARE)
      return clickable
    return node
  }
  const targets = new Map<string, { node: UiNode, label: string }>()
  for (const node of tree.nodes) {
    if (boundsArea(node.bounds) <= 0)
      continue
    const label = [node.text, node.contentDesc].find(value => isMeaningfulLabel(value) && labelMatches(value, expected))
    if (!label)
      continue
    const center = centerOf(node)
    if (!inside(center.x, region.x) || !inside(center.y, region.y))
      continue
    const tapNode = resolve(node)
    const key = `${tapNode.bounds.left},${tapNode.bounds.top},${tapNode.bounds.right},${tapNode.bounds.bottom}`
    if (!targets.has(key))
      targets.set(key, { node: tapNode, label })
  }
  if (targets.size !== 1)
    return { candidates: targets.size, reason: targets.size ? `${targets.size} matching elements` : 'no matching element' }
  const [{ node, label }] = targets.values()
  const point = centerOf(node)
  return { found: { point: { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) }, label, bounds: { ...node.bounds } } }
}
