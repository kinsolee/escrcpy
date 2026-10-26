import { describe, expect, it } from 'vitest'
import { ancestorsOf, closestClickable, hitTest, isDescendantOf, parseUiTree } from '../src/ui-tree.js'
import { fixture, fixtureTree } from './helpers.js'

describe('parseUiTree', () => {
  it('parses a real uiautomator dump', () => {
    const tree = fixtureTree('launcher-uiautomator.xml')
    expect(tree.rotation).toBe(0)
    expect(tree.size).toEqual({ width: 1220, height: 2712 })
    expect(tree.nodes).toHaveLength(49)

    const root = tree.nodes[0]
    expect(root).toMatchObject({ id: 0, parent: -1, path: '0', depth: 0, packageName: 'com.miui.home' })
    for (const node of tree.nodes) {
      for (const child of node.children)
        expect(tree.nodes[child].parent).toBe(node.id)
    }
  })

  it('gives the same tree for uiautomator and yadb dumps of one screen', () => {
    const a = fixtureTree('launcher-uiautomator.xml')
    const b = fixtureTree('launcher-yadb.xml')
    expect(b).toEqual(a)
  })

  it('reads attributes, flags and entities', () => {
    const tree = fixtureTree('settings-dialog.xml')
    const byText = (text: string) => tree.nodes.find(n => n.text === text)!

    expect(byText('网络 & 偏好设置')).toBeDefined()
    expect(byText('secret123')).toMatchObject({ password: true, focused: true, clickable: true, resourceId: 'com.android.settings:id/password' })
    expect(byText('数据节省程序').enabled).toBe(false)
    expect(tree.nodes.find(n => n.className === 'android.widget.Switch')).toMatchObject({ checkable: true, checked: false })
    expect(tree.nodes.find(n => n.resourceId.endsWith('recycler_view'))!.scrollable).toBe(true)
  })

  it('takes the screen size from top-level windows and keeps the rotation', () => {
    const tree = parseUiTree('<hierarchy rotation="1"><node bounds="[0,0][2400,1080]"/><node bounds="[100,100][300,300]"/></hierarchy>')
    expect(tree.rotation).toBe(1)
    expect(tree.size).toEqual({ width: 2400, height: 1080 })
  })

  it('treats a missing enabled attribute as enabled', () => {
    const tree = parseUiTree('<hierarchy><node bounds="[0,0][1,1]"/></hierarchy>')
    expect(tree.nodes[0].enabled).toBe(true)
    expect(tree.nodes[0].clickable).toBe(false)
  })

  it('rejects documents that are not hierarchy dumps', () => {
    expect(() => parseUiTree('<html></html>')).toThrow(/root is <html>/)
  })

  it('builds index paths from the root', () => {
    const tree = fixtureTree('settings-dialog.xml')
    const cancel = tree.nodes.find(n => n.text === '取消')!
    expect(cancel.path).toBe('1.3')
    expect(cancel.depth).toBe(1)
    const vpn = tree.nodes.find(n => n.text === 'VPN')!
    expect(vpn.path).toBe('0.1.5.0')
  })
})

describe('hitTest', () => {
  const tree = fixtureTree('settings-dialog.xml')

  it('returns the deepest node under the point', () => {
    expect(hitTest(tree, { x: 300, y: 290 })!.text).toBe('互联网')
  })

  it('prefers a later window drawn on top, such as a dialog', () => {
    // (540, 1000) is inside both the "飞行模式"/"热点" rows and the dialog title.
    expect(hitTest(tree, { x: 540, y: 1000 })!.resourceId).toBe('android:id/alertTitle')
    expect(hitTest(tree, { x: 560, y: 1430 })!.text).toBe('取消')
  })

  it('ignores zero-area nodes and returns undefined off-screen', () => {
    expect(hitTest(tree, { x: 0, y: 0 })!.text).not.toBe('hidden')
    expect(hitTest(tree, { x: 5000, y: 5000 })).toBeUndefined()
  })

  it('treats right and bottom edges as outside', () => {
    expect(hitTest(tree, { x: 147, y: 100 })!.contentDesc).not.toBe('向上导航')
    expect(hitTest(tree, { x: 146, y: 100 })!.contentDesc).toBe('向上导航')
  })
})

describe('tree navigation', () => {
  const tree = fixtureTree('launcher-uiautomator.xml')
  const search = tree.nodes.find(n => n.text === '搜索')!

  it('finds the clickable container of a plain label', () => {
    expect(search.clickable).toBe(false)
    const container = closestClickable(tree, search)!
    expect(container.clickable).toBe(true)
    expect(container.id).toBe(search.parent)
  })

  it('lists ancestors up to the top-level window', () => {
    const chain = ancestorsOf(tree, search)
    expect(chain[0].id).toBe(search.parent)
    expect(chain.at(-1)!.parent).toBe(-1)
    expect(isDescendantOf(tree, search, chain.at(-1)!)).toBe(true)
    expect(isDescendantOf(tree, chain.at(-1)!, search)).toBe(false)
  })

  it('accepts the raw fixture text unchanged', () => {
    expect(() => parseUiTree(fixture('launcher-yadb.xml'))).not.toThrow()
  })
})
