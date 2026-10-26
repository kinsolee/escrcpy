import { describe, expect, it } from 'vitest'
import { describeSelector, findAll, findOne, isEmptySelector, matchesSelector } from '../src/selector.js'
import { fixtureTree } from './helpers.js'

const settings = fixtureTree('settings-dialog.xml')
const launcher = fixtureTree('launcher-uiautomator.xml')
const texts = (nodes: { text: string }[]) => nodes.map(n => n.text)

describe('findAll', () => {
  it('matches text as a case-insensitive substring by default', () => {
    expect(texts(findAll(settings, { text: '网络' }))).toEqual(['网络和互联网', '热点和网络共享', '网络 & 偏好设置'])
    expect(texts(findAll(settings, { text: 'vpn' }))).toEqual(['VPN'])
  })

  it('matches text exactly with exact', () => {
    expect(texts(findAll(settings, { text: '互联网' }))).toEqual(['网络和互联网', '互联网'])
    expect(texts(findAll(settings, { text: '互联网', exact: true }))).toEqual(['互联网'])
    expect(findAll(settings, { text: 'vpn', exact: true })).toEqual([])
  })

  it('matches content_desc the same way', () => {
    expect(findAll(launcher, { content_desc: '图库' })[0].contentDesc).toBe('图库：1条消息未读')
    expect(findAll(launcher, { content_desc: '图库', exact: true })).toEqual([])
    expect(findAll(settings, { content_desc: '搜索设置', exact: true })).toHaveLength(1)
  })

  it('matches resource_id exactly, with a package-less short form', () => {
    expect(findAll(settings, { resource_id: 'android:id/title' })).toHaveLength(8)
    expect(findAll(settings, { resource_id: 'id/title' })).toHaveLength(8)
    expect(findAll(settings, { resource_id: 'title' })).toHaveLength(8)
    expect(findAll(settings, { resource_id: 'android:id/titl' })).toHaveLength(0)
    expect(findAll(settings, { resource_id: 'com.android.settings:id/title' })).toHaveLength(0)
    expect(findAll(settings, { resource_id: 'search_action_bar' })[0].contentDesc).toBe('搜索设置')
  })

  it('matches class_name as a substring', () => {
    expect(texts(findAll(settings, { class_name: 'Button' }))).toEqual(['', '', '取消', '连接'])
    expect(findAll(settings, { class_name: 'recyclerview' })).toHaveLength(1)
  })

  it('combines fields with AND', () => {
    expect(texts(findAll(settings, { resource_id: 'title', text: '网络' }))).toEqual(['热点和网络共享', '网络 & 偏好设置'])
    expect(findAll(settings, { class_name: 'Button', text: '连接' })).toHaveLength(1)
  })

  it('skips zero-area nodes', () => {
    expect(findAll(settings, { text: 'hidden' })).toEqual([])
  })

  it('returns matches in reading order', () => {
    expect(texts(findAll(settings, { resource_id: 'title' }))).toEqual([
      '互联网',
      '通话和短信',
      '飞行模式',
      '热点和网络共享',
      '数据节省程序',
      'VPN',
      '私人 DNS',
      '网络 & 偏好设置',
    ])
    expect(texts(findAll(settings, { class_name: 'widget.Button' }))).toEqual(['取消', '连接'])
  })

  it('rejects an empty selector', () => {
    expect(() => findAll(settings, {})).toThrow(/at least one/)
    expect(() => findAll(settings, { exact: true, index: 1 })).toThrow()
    expect(isEmptySelector({ text: '' })).toBe(true)
  })
})

describe('findOne', () => {
  it('reports how many nodes matched', () => {
    expect(findOne(settings, { text: '连接' })).toMatchObject({ matchCount: 1, node: { text: '连接' } })
    expect(findOne(launcher, { text: '音乐', exact: true })!.matchCount).toBe(2)
  })

  it('picks by index in reading order, negative from the end', () => {
    const first = findOne(launcher, { text: '音乐', exact: true, index: 0 })!.node
    const second = findOne(launcher, { text: '音乐', exact: true, index: 1 })!.node
    expect(first.bounds.left).toBeLessThan(second.bounds.left)
    expect(findOne(launcher, { text: '音乐', exact: true, index: -1 })!.node).toBe(second)
    expect(findOne(launcher, { text: '音乐', exact: true, index: 2 })).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(findOne(settings, { text: '不存在' })).toBeUndefined()
  })
})

describe('matchesSelector / describeSelector', () => {
  it('describes a selector for messages', () => {
    expect(describeSelector({ text: '连接', resource_id: 'button1', exact: true, index: 0 }))
      .toBe('resource_id="button1" text="连接" exact index=0')
  })

  it('checks a single node', () => {
    const node = settings.nodes.find(n => n.text === '取消')!
    expect(matchesSelector(node, { text: '取' })).toBe(true)
    expect(matchesSelector(node, { text: '取', exact: true })).toBe(false)
  })
})
