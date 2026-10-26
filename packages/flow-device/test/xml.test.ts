import { describe, expect, it } from 'vitest'
import { decodeEntities, parseXml } from '../src/xml.js'

describe('parseXml', () => {
  it('reads nested and self-closing elements with both quote styles', () => {
    const root = parseXml(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
      <!-- comment --><hierarchy rotation="1"><node a='1' b="x &gt; y"><node c="2" /></node><node/></hierarchy>`)
    expect(root.tag).toBe('hierarchy')
    expect(root.attrs).toEqual({ rotation: '1' })
    expect(root.children).toHaveLength(2)
    expect(root.children[0].attrs).toEqual({ a: '1', b: 'x > y' })
    expect(root.children[0].children[0].attrs).toEqual({ c: '2' })
    expect(root.children[1].children).toEqual([])
  })

  it('keeps attribute values containing > and quotes of the other kind', () => {
    const root = parseXml(`<a t="1 > 0" u='say "hi"'/>`)
    expect(root.attrs).toEqual({ t: '1 > 0', u: 'say "hi"' })
  })

  it('rejects unbalanced or empty documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/unexpected <\/a>/)
    expect(() => parseXml('<a>')).toThrow(/not closed/)
    expect(() => parseXml('ERROR: could not get idle state.')).toThrow(/no root/)
    expect(() => parseXml('<a/><b/>')).toThrow(/more than one root/)
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe('a & b <c> "d" \'e\'')
    expect(decodeEntities('&#20320;&#x597D; &#x1F600;')).toBe('你好 😀')
    expect(decodeEntities('&unknown; &amp')).toBe('&unknown; &amp')
  })
})
