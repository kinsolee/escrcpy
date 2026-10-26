import { isVisible, sortReadingOrder } from './elements.js'
import type { UiNode, UiTree } from './ui-tree.js'

/**
 * Element selector. Field names match the MCP tool arguments and the
 * `target` entries of `*.flow.yaml`, so no mapping layer is needed.
 *
 * All given fields must match (AND).
 * - `text` / `content_desc`: case-insensitive substring; equality when `exact`.
 * - `resource_id`: always exact. A value without a package (`id/title` or `title`)
 *   matches any package, which keeps flows working across app flavours.
 * - `class_name`: case-insensitive substring of the full class name.
 * - `index`: pick the n-th match in reading order (default 0).
 */
export interface Selector {
  resource_id?: string
  text?: string
  content_desc?: string
  class_name?: string
  exact?: boolean
  index?: number
}

const FIELDS = ['resource_id', 'text', 'content_desc', 'class_name'] as const

export function isEmptySelector(selector: Selector): boolean {
  return FIELDS.every(field => !selector[field])
}

function matchText(actual: string, expected: string, exact: boolean): boolean {
  if (exact)
    return actual === expected
  return actual.toLowerCase().includes(expected.toLowerCase())
}

function matchResourceId(actual: string, expected: string): boolean {
  if (actual === expected)
    return true
  if (expected.includes(':'))
    return false
  const suffix = expected.startsWith('id/') ? expected : `id/${expected}`
  return actual.endsWith(`:${suffix}`)
}

export function matchesSelector(node: UiNode, selector: Selector): boolean {
  const exact = selector.exact ?? false
  if (selector.resource_id && !matchResourceId(node.resourceId, selector.resource_id))
    return false
  if (selector.text && !matchText(node.text, selector.text, exact))
    return false
  if (selector.content_desc && !matchText(node.contentDesc, selector.content_desc, exact))
    return false
  if (selector.class_name && !node.className.toLowerCase().includes(selector.class_name.toLowerCase()))
    return false
  return true
}

/**
 * All visible nodes matching the selector, in reading order. Unlike the agent-facing
 * element list this searches every node, so unlabeled containers can be targeted by class.
 */
export function findAll(tree: UiTree, selector: Selector): UiNode[] {
  if (isEmptySelector(selector))
    throw new Error('Selector needs at least one of resource_id, text, content_desc, class_name')
  return sortReadingOrder(tree.nodes.filter(node => isVisible(node) && matchesSelector(node, selector)))
}

export interface FindResult {
  node: UiNode
  /** How many nodes matched before `index` was applied. 1 means the selector is unique. */
  matchCount: number
}

/**
 * The node picked by `selector.index` (default 0; negative counts from the end),
 * or undefined when nothing matches.
 */
export function findOne(tree: UiTree, selector: Selector): FindResult | undefined {
  const matches = findAll(tree, selector)
  const node = matches.at(selector.index ?? 0)
  return node ? { node, matchCount: matches.length } : undefined
}

export function describeSelector(selector: Selector): string {
  const parts: string[] = []
  for (const field of FIELDS) {
    if (selector[field])
      parts.push(`${field}=${JSON.stringify(selector[field])}`)
  }
  if (selector.exact)
    parts.push('exact')
  if (selector.index !== undefined)
    parts.push(`index=${selector.index}`)
  return parts.join(' ')
}
