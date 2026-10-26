import { describe, expect, it } from 'vitest'
import { extractElements, isListedNode, PASSWORD_PLACEHOLDER, shortClassName, sortReadingOrder } from '../src/elements.js'
import { fixtureTree } from './helpers.js'

describe('extractElements', () => {
  it('lists the labelled launcher icons in reading order', () => {
    const elements = extractElements(fixtureTree('launcher-uiautomator.xml'))
    const icons = elements.filter(e => e.clickable && e.type === 'TextView').map(e => e.text)
    expect(icons.slice(0, 8)).toEqual(['天气', '音乐', '音乐', '下载', '指南针', '录音机', '地图', '应用商店'])
    expect(icons.slice(-4)).toEqual(['电话', '短信', '浏览器', '相机'])
  })

  it('keeps labelled non-clickable widgets and drops unlabelled layout containers', () => {
    const tree = fixtureTree('launcher-uiautomator.xml')
    const elements = extractElements(tree)
    expect(elements.find(e => e.text === '搜索')).toMatchObject({ type: 'TextView' })
    expect(elements.find(e => e.contentDesc === '第 3 页共 3 页')).toMatchObject({ type: 'SeekBar', scrollable: true })
    // The clickable FrameLayout around "搜索" has no label of its own.
    const container = tree.nodes[tree.nodes.find(n => n.text === '搜索')!.parent]
    expect(isListedNode(container)).toBe(false)
  })

  it('masks password text and reports only informative states', () => {
    const elements = extractElements(fixtureTree('settings-dialog.xml'))
    const password = elements.find(e => e.resourceId.endsWith(':id/password'))!
    expect(password.text).toBe(PASSWORD_PLACEHOLDER)
    expect(password).toMatchObject({ type: 'EditText', clickable: true, focused: true })
    expect(password).not.toHaveProperty('checked')
    expect(password).not.toHaveProperty('enabled')

    expect(elements.find(e => e.text === '数据节省程序')).toMatchObject({ enabled: false })
    expect(elements.find(e => e.text === 'hidden')).toBeUndefined()
  })

  it('reports bounds as x/y/width/height with a pixel centre', () => {
    const cancel = extractElements(fixtureTree('settings-dialog.xml')).find(e => e.text === '取消')!
    expect(cancel.bounds).toEqual({ x: 450, y: 1380, width: 230, height: 100 })
    expect([cancel.centerX, cancel.centerY]).toEqual([565, 1430])
  })
})

describe('sortReadingOrder', () => {
  const box = (id: number, left: number, top: number) => ({ id, bounds: { left, top, right: left + 10, bottom: top + 10 } })

  it('groups nodes within 10px of a row\'s first node into that row, ordered by x', () => {
    const sorted = sortReadingOrder([box(1, 500, 103), box(2, 100, 100), box(3, 300, 95), box(4, 0, 200)])
    expect(sorted.map(n => n.id)).toEqual([2, 3, 1, 4])
  })

  it('starts a new row when a node is more than 10px below the row start', () => {
    const sorted = sortReadingOrder([box(1, 500, 106), box(2, 100, 95)])
    expect(sorted.map(n => n.id)).toEqual([2, 1])
    const sameRow = sortReadingOrder([box(1, 0, 106), box(2, 100, 96)])
    expect(sameRow.map(n => n.id)).toEqual([1, 2])
  })
})

describe('shortClassName', () => {
  it('drops the package', () => {
    expect(shortClassName('android.widget.Button')).toBe('Button')
    expect(shortClassName('Button')).toBe('Button')
  })
})
