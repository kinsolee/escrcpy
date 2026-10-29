import { findOne, isVisible, matchesSelector } from '@escrcpy/flow-device'
import type { Selector, UiNode, UiTree } from '@escrcpy/flow-device'

export interface ExtractSpec {
  /** Container whose direct children are the rows (e.g. a RecyclerView). Omit to read the whole screen as one row. */
  list?: Selector
  /** Column name → selector matched against each row's descendants; the first match supplies the value. */
  columns: Record<string, Selector>
  /** Keep only rows that are clickable themselves; separates result rows from section headers. */
  row_clickable?: boolean
  /** Columns that must be non-empty for a row to be kept. Defaults to the first column. */
  require?: string[]
}

export type ExtractedRow = Record<string, string>

function cellText(node: UiNode): string {
  return node.text || node.contentDesc
}

function firstMatch(tree: UiTree, start: number[], selector: Selector): UiNode | undefined {
  const stack = [...start].reverse()
  while (stack.length) {
    const node = tree.nodes[stack.pop()!]
    if (isVisible(node) && matchesSelector(node, selector))
      return node
    for (let i = node.children.length - 1; i >= 0; i--)
      stack.push(node.children[i])
  }
  return undefined
}

/**
 * Read a table out of a UI tree: one row per child of `list`, one cell per column selector.
 * Without `list` the whole screen is a single row, for detail pages.
 */
export function extractRows(tree: UiTree, spec: ExtractSpec): ExtractedRow[] {
  const names = Object.keys(spec.columns)
  if (!names.length)
    throw new Error('extract needs at least one column')
  const required = spec.require ?? [names[0]]
  const unknown = required.filter(name => !names.includes(name))
  if (unknown.length)
    throw new Error(`extract require names unknown columns: ${unknown.join(', ')}`)

  const rows: ExtractedRow[] = []
  if (!spec.list) {
    const row: ExtractedRow = {}
    const top = tree.nodes.filter(node => node.parent === -1).map(node => node.id)
    for (const name of names) {
      const cell = firstMatch(tree, top, spec.columns[name])
      row[name] = cell ? cellText(cell) : ''
    }
    return required.every(name => row[name] !== '') ? [row] : []
  }

  const list = findOne(tree, spec.list)
  if (!list)
    throw new Error('extract list container not found on screen')

  for (const id of list.node.children) {
    const rowNode = tree.nodes[id]
    if (!isVisible(rowNode) || (spec.row_clickable && !rowNode.clickable))
      continue
    const row: ExtractedRow = {}
    for (const name of names) {
      const cell = firstMatch(tree, rowNode.children, spec.columns[name])
      row[name] = cell ? cellText(cell) : ''
    }
    if (required.every(name => row[name] !== ''))
      rows.push(row)
  }
  return rows
}
