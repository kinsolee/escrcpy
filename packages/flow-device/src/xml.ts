/**
 * Minimal XML reader for Android UI hierarchy dumps.
 *
 * Both `uiautomator dump` (single line, `'` in the declaration) and `yadb -layout`
 * (indented, different attribute order) produce plain element trees with
 * attributes only, so a full XML parser is unnecessary. Text content, comments,
 * processing instructions and doctypes are skipped.
 */

export interface XmlElement {
  tag: string
  attrs: Record<string, string>
  children: XmlElement[]
}

const TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
}

export function decodeEntities(value: string): string {
  if (!value.includes('&'))
    return value
  return value.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!source)
    return attrs
  for (const match of source.matchAll(ATTR_RE))
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '')
  return attrs
}

/**
 * Parse an XML string and return its root element.
 * Throws when there is no root element or the tags are unbalanced.
 */
export function parseXml(xml: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | undefined

  for (const match of xml.matchAll(TOKEN_RE)) {
    const [, closing, tag, attrSource, selfClosing] = match
    if (!tag)
      continue

    if (closing) {
      const open = stack.pop()
      if (!open || open.tag !== tag)
        throw new Error(`Malformed XML: unexpected </${tag}>`)
      continue
    }

    const element: XmlElement = { tag, attrs: parseAttrs(attrSource), children: [] }
    const parent = stack.at(-1)
    if (parent)
      parent.children.push(element)
    else if (!root)
      root = element
    else
      throw new Error('Malformed XML: more than one root element')

    if (!selfClosing)
      stack.push(element)
  }

  if (!root)
    throw new Error('Malformed XML: no root element')
  if (stack.length)
    throw new Error(`Malformed XML: <${stack.at(-1)!.tag}> is not closed`)
  return root
}
