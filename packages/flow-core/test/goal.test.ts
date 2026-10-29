import { describe, expect, it } from 'vitest'
import { buildGoalPrompt, parseGoalDecision, proposeGoalPatch, runGoalAgent } from '../src/goal.js'
import { HealError } from '../src/heal.js'
import type { HealLlmClient } from '../src/heal.js'
import type { ReplayDevice } from '../src/replayer.js'
import type { FlowScript } from '../src/schema.js'

const flow: FlowScript = {
  version: 1,
  name: 'demo',
  description: '打开设置并搜索蓝牙',
  vars: {},
  defaults: {},
  interrupts: [],
  steps: [
    { id: 's1', do: 'tap', target: [{ resource_id: 'id/search' }] },
    { id: 's2', do: 'input_text', with: { text: '蓝牙' } },
  ],
}

function scriptedClient(texts: string[]): HealLlmClient & { prompts: string[] } {
  const prompts: string[] = []
  let index = 0
  return {
    prompts,
    complete: async () => {
      throw new HealError('not used')
    },
    completeText: async (prompt: string) => {
      prompts.push(prompt)
      return texts[Math.min(index++, texts.length - 1)]
    },
  }
}

function mockDevice(): ReplayDevice {
  return {
    waitFor: async () => ({ snapshot: { id: 'snap' } }),
    tap: async () => {},
    inputText: async () => {},
    key: async () => {},
    swipe: async () => {},
    snapshot: async () => ({ id: 'snap', tree: {} }),
  } as unknown as ReplayDevice
}

describe('goal decisions', () => {
  it('parses done decisions', () => {
    const decision = parseGoalDecision('{"thought":"已到目标页","done":true,"reason":"蓝牙设置已打开"}')
    expect(decision.done).toBe(true)
    expect(decision.reason).toBe('蓝牙设置已打开')
    expect(decision.action).toBeUndefined()
  })

  it('wraps a single-object target and keeps going', () => {
    const decision = parseGoalDecision('{"thought":"点搜索","done":false,"action":{"tool":"tap","target":{"text":"搜索"}}}')
    expect(decision.done).toBe(false)
    expect(decision.action).toMatchObject({ tool: 'tap', target: [{ text: '搜索' }] })
  })

  it('rejects tools outside the whitelist', () => {
    expect(() => parseGoalDecision('{"done":false,"action":{"tool":"shell","target":[]}}')).toThrow(HealError)
    expect(() => parseGoalDecision('not json at all')).toThrow(HealError)
  })
})

describe('runGoalAgent', () => {
  it('declares the goal achieved without actions', async () => {
    const client = scriptedClient(['{"thought":"t","done":true,"reason":"目标页已在屏上"}'])
    const result = await runGoalAgent({ goal: flow.description!, flow, serial: 's', device: mockDevice(), client })
    expect(result.achieved).toBe(true)
    expect(result.actions).toEqual([])
    expect(result.steps).toEqual([])
    expect(result.reason).toBe('目标页已在屏上')
  })

  it('executes actions until the model declares done', async () => {
    const client = scriptedClient([
      '{"thought":"按返回","done":false,"action":{"tool":"key","with":{"key":4}}}',
      '{"thought":"已达成","done":true,"reason":"搜索结果可见"}',
    ])
    const result = await runGoalAgent({ goal: '搜索蓝牙', flow, serial: 's', device: mockDevice(), client })
    expect(result.achieved).toBe(true)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({ action: { tool: 'key' } })
    expect(result.steps).toHaveLength(1)
  })

  it('stops at the action budget when the goal is never reached', async () => {
    const client = scriptedClient(['{"done":false,"action":{"tool":"key","with":{"key":4}}}'])
    const result = await runGoalAgent({ goal: '永不达成', flow, serial: 's', device: mockDevice(), client, maxActions: 2 })
    expect(result.achieved).toBe(false)
    expect(result.actions).toHaveLength(2)
    expect(result.reason).toContain('上限')
  })
})

describe('proposeGoalPatch', () => {
  const journal = [
    { action: { tool: 'tap' as const, target: [{ text: '搜索' }] }, reason: '点搜索' },
    { action: { tool: 'input_text' as const, with: { text: '蓝牙' } }, reason: '输入关键词' },
  ]

  it('uses the model patch when it validates', async () => {
    const client = scriptedClient([JSON.stringify({
      stepId: 's1',
      mode: 'replace',
      steps: [{ id: 's1', do: 'tap', target: [{ text: '搜索' }] }],
    })])
    const patch = await proposeGoalPatch({ flow, stepId: 's1', journal, client })
    expect(patch).toMatchObject({ stepId: 's1', mode: 'replace' })
    expect(patch?.steps[0].target).toEqual([{ text: '搜索' }])
  })

  it('falls back to the mechanical patch when the model output is unusable', async () => {
    const client = scriptedClient(['{"stepId":"other","mode":"replace","steps":[]}'])
    const patch = await proposeGoalPatch({ flow, stepId: 's1', journal, client })
    // Last executed action (input_text) differs from the failed step's do (tap) → insert-before.
    expect(patch).toMatchObject({ stepId: 's1', mode: 'insert-before' })
    expect(patch?.steps).toHaveLength(2)
  })

  it('returns undefined when nothing executed', async () => {
    const client = scriptedClient(['{}'])
    const patch = await proposeGoalPatch({ flow, stepId: 's1', journal: [{ error: 'boom' }], client })
    expect(patch).toBeUndefined()
  })
})

describe('buildGoalPrompt', () => {
  it('carries the goal, failure and history', () => {
    const prompt = buildGoalPrompt({
      goal: '打开蓝牙设置',
      flow,
      error: 'step s1 timeout',
      context: '脚本失败步骤 s1 (tap)',
      visible: [{ text: '搜索', resourceId: 'search', bounds: [0, 0, 10, 10] }],
      attempted: [{ action: { tool: 'key', with: { key: 4 } }, reason: '返回' }],
    })
    expect(prompt).toContain('打开蓝牙设置')
    expect(prompt).toContain('step s1 timeout')
    expect(prompt).toContain('id="search"')
    expect(prompt).toContain('tool=key')
  })
})
