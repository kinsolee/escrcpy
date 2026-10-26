import type { Bounds, Size } from './geometry.js'
import { boundsArea, boundsContain, parseBounds } from './geometry.js'
import type { XmlElement } from './xml.js'
import { parseXml } from './xml.js'

/** One `<node>` of the dump, flattened. Every field is JSON-safe so trees can be saved as snapshots. */
export interface UiNode {
  /** Position in `UiTree.nodes` (document order). Stable within one dump only. */
  id: number
  /** Parent id, or -1 for top-level nodes. */
  parent: number
  children: number[]
  /** Index path from the hierarchy root, e.g. `0.2.1`. */
  path: string
  depth: number
  className: string
  text: string
  contentDesc: string
  resourceId: string
  packageName: string
  bounds: Bounds
  checkable: boolean
  checked: boolean
  clickable: boolean
  enabled: boolean
  focusable: boolean
  focused: boolean
  scrollable: boolean
  longClickable: boolean
  password: boolean
  selected: boolean
}

export interface UiTree {
  /** 0~3, as reported by the dump (0 = natural orientation). */
  rotation: number
  /** Screen size in the current orientation, taken from the widest top-level window. */
  size: Size
  nodes: UiNode[]
}

const bool = (value: string | undefined) => value === 'true'

function toNode(el: XmlElement, id: number, parent: number, path: string, depth: number): UiNode {
  const a = el.attrs
  return {
    id,
    parent,
    children: [],
    path,
    depth,
    className: a.class ?? '',
    text: a.text ?? '',
    contentDesc: a['content-desc'] ?? '',
    resourceId: a['resource-id'] ?? '',
    packageName: a.package ?? '',
    bounds: parseBounds(a.bounds),
    checkable: bool(a.checkable),
    checked: bool(a.checked),
    clickable: bool(a.clickable),
    // A missing attribute means enabled; only an explicit "false" disables.
    enabled: a.enabled !== 'false',
    focusable: bool(a.focusable),
    focused: bool(a.focused),
    scrollable: bool(a.scrollable),
    longClickable: bool(a['long-clickable']),
    password: bool(a.password),
    selected: bool(a.selected),
  }
}

/** Parse a uiautomator / yadb hierarchy dump into a flat node list. */
export function parseUiTree(xml: string): UiTree {
  const root = parseXml(xml)
  if (root.tag !== 'hierarchy')
    throw new Error(`Not a UI hierarchy dump: root is <${root.tag}>`)

  const nodes: UiNode[] = []
  const walk = (el: XmlElement, parent: number, path: string, depth: number) => {
    let childIndex = 0
    for (const child of el.children) {
      if (child.tag !== 'node')
        continue
      const childPath = path ? `${path}.${childIndex}` : String(childIndex)
      childIndex++
      const node = toNode(child, nodes.length, parent, childPath, depth)
      nodes.push(node)
      if (parent >= 0)
        nodes[parent].children.push(node.id)
      walk(child, node.id, childPath, depth + 1)
    }
  }
  walk(root, -1, '', 0)

  let width = 0
  let height = 0
  for (const node of nodes) {
    if (node.parent !== -1)
      continue
    width = Math.max(width, node.bounds.right)
    height = Math.max(height, node.bounds.bottom)
  }

  const rotation = Number.parseInt(root.attrs.rotation ?? '0', 10)
  return { rotation: Number.isFinite(rotation) ? rotation : 0, size: { width, height }, nodes }
}

/** Ancestors from the direct parent up to the top-level window. */
export function ancestorsOf(tree: UiTree, node: UiNode): UiNode[] {
  const result: UiNode[] = []
  for (let id = node.parent; id >= 0; id = tree.nodes[id].parent)
    result.push(tree.nodes[id])
  return result
}

export function isDescendantOf(tree: UiTree, node: UiNode, ancestor: UiNode): boolean {
  for (let id = node.parent; id >= 0; id = tree.nodes[id].parent) {
    if (id === ancestor.id)
      return true
  }
  return false
}

/**
 * The element a touch at `point` (device pixels) lands on.
 *
 * Nodes are in pre-order, so a later node is either a descendant or drawn
 * above (a later sibling or a later window such as a dialog). The last node
 * whose bounds contain the point is therefore the topmost, deepest one.
 */
export function hitTest(tree: UiTree, point: { x: number, y: number }): UiNode | undefined {
  for (let i = tree.nodes.length - 1; i >= 0; i--) {
    const node = tree.nodes[i]
    if (boundsArea(node.bounds) > 0 && boundsContain(node.bounds, point))
      return node
  }
  return undefined
}

/** The node itself or its nearest ancestor that reacts to taps. */
export function closestClickable(tree: UiTree, node: UiNode): UiNode | undefined {
  if (node.clickable || node.longClickable)
    return node
  return ancestorsOf(tree, node).find(n => n.clickable || n.longClickable)
}
