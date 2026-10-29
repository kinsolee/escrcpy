import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HealAttempt, HealDecision, HealLlmClient } from '../src/heal.js'
import { applyPatch, buildHealPrompt, buildPatch, createEnvLlmClient, healHints, mergePatch, readFlow, runHealAgent, writeFlow, writePatch } from '../src/index.js'
import type { FlowScript, FlowStep } from '../src/schema.js'
import type { ReplayDevice } from '../src/replayer.js'

const targetNode = {
  id: 1,
  parent: -1,
  children: [],
  path: '0',
  depth: 0,
  className: 'android.widget.Button',
  text: '',
  contentDesc: 'Settings',
  resourceId: 'com.example:id/settings',
  packageName: 'com.example',
  bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  checkable: false,
  checked: false,
  clickable: true,
  enabled: true,
  focusable: true,
  focused: false,
  scrollable: false,
  longClickable: false,
  password: false,
  selected: false,
}
const snapshot = {
  id: 'snap-1',
  serial: 'test',
  createdAt: 1,
  xml: '<hierarchy />',
  tree: { rotation: 0, size: { width: 1000, height: 2000 }, nodes: [targetNode] },
  app: { package: 'com.example.launcher', activity: '.MainActivity' },
  dumpMs: 1,
}

const baseFlow: FlowScript = {
  version: 1,
  name: 'open-settings',
  description: '打开系统设置并进入 WLAN',
  vars: {},
  defaults: { timeout: 10, settle: 0, pollInterval: 0 },
  interrupts: [],
  steps: [
    { id: 'open-settings', intent: '打开设置', do: 'tap', target: [{ resource_id: 'id/settings' }], expect: { visible: { content_desc: 'Settings', exact: true } } },
    { id: 'input', do: 'input_text', with: { text: 'wifi' } },
  ],
}

function fakeHealDevice(overrides: Partial<ReplayDevice> = {}): ReplayDevice & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    waitFor: async (_serial, selector) => {
      calls.push(`wait:${JSON.stringify(selector)}`)
      return { found: true, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, match: { node: targetNode as never, matchCount: 1 } }
    },
    tap: async (_serial, target) => {
      calls.push(`tap:${JSON.stringify(target)}`)
      return {} as never
    },
    inputText: async (_serial, text) => {
      calls.push(`input:${text}`)
    },
    key: async (_serial, key) => {
      calls.push(`key:${key}`)
      return 4
    },
    swipe: async (_serial, from, to, durationMs) => {
      calls.push(`swipe:${from.x},${from.y}-${to.x},${to.y}@${durationMs}`)
    },
    snapshot: async () => {
      calls.push('snapshot')
      return snapshot as never
    },
    foregroundApp: async () => {
      calls.push('foreground')
      return { package: 'com.example', activity: '.MainActivity' }
    },
    shell: async (_serial, command) => {
      calls.push(`shell:${command}`)
      return ''
    },
    ...overrides,
  }
}

function fakeClient(script: Array<HealDecision | Error>): HealLlmClient & { prompts: string[] } {
  const prompts: string[] = []
  let index = 0
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt)
      const next = script[Math.min(index++, script.length - 1)]
      if (next instanceof Error)
        throw next
      return next
    },
  }
}

describe('heal prompt', () => {
  it('includes flow, step, failure, screen and rule context', () => {
    const prompt = buildHealPrompt({
      flow: baseFlow,
      step: baseFlow.steps[0],
      error: 'Target 1 did not match within 8000ms',
      visible: [{ text: '设置', contentDesc: 'Settings', resourceId: 'settings', bounds: [0, 0, 100, 100] }],
      attempted: [{ action: { tool: 'key', with: { key: 'BACK' } }, reason: '关闭弹窗', error: 'key failed' }],
    })
    expect(prompt).toContain('open-settings')
    expect(prompt).toContain('打开系统设置并进入 WLAN')
    expect(prompt).toContain('打开设置')
    expect(prompt).toContain('id/settings')
    expect(prompt).toContain('Target 1 did not match within 8000ms')
    expect(prompt).toContain('text="设置"')
    expect(prompt).toContain('id="settings"')
    expect(prompt).toContain('[0, 0, 100, 100]')
    expect(prompt).toContain('BACK')
    expect(prompt).toContain('每次只返回一个动作')
    expect(prompt).toContain('tap、wait_for、input_text、key、swipe、app_start')
    expect(prompt).toContain('禁止 shell')
  })

  it('caps the screen summary at 40 hints and keeps only resource id tails', () => {
    const nodes = Array.from({ length: 45 }, (_, i) => ({ ...targetNode, id: i, clickable: true, text: `条目 ${i}` }))
    const crowded = { ...snapshot, tree: { ...snapshot.tree, nodes } }
    const hints = healHints(crowded as never)
    expect(hints).toHaveLength(40)
    expect(hints[0]).toEqual({ text: '条目 0', contentDesc: 'Settings', resourceId: 'settings', bounds: [0, 0, 100, 100] })
  })
})

describe('heal agent', () => {
  it('heals a drifted tap and reports the executed steps', async () => {
    const device = fakeHealDevice()
    const client = fakeClient([{ action: { tool: 'tap', target: [{ text: '设置' }] }, reason: '点新的设置入口' }])
    const result = await runHealAgent({ flow: baseFlow, step: baseFlow.steps[0], serial: 'test', device, client, error: 'Target 1 did not match' })
    expect(result.healed).toBe(true)
    expect(result.actions).toHaveLength(1)
    expect(result.steps).toEqual([{ id: 'heal-1', intent: '点新的设置入口', do: 'tap', target: [{ text: '设置' }] }])
    expect(device.calls).toContain('tap:{"text":"设置"}')
    expect(client.prompts[0]).toContain('Target 1 did not match')
  })

  it('rejects actions outside the whitelist without executing them', async () => {
    const device = fakeHealDevice()
    const shellAction = { tool: 'shell', with: { command: 'reboot' } } as never
    const client = fakeClient([{ action: shellAction, reason: '重启设备' }])
    const result = await runHealAgent({ flow: baseFlow, step: baseFlow.steps[0], serial: 'test', device, client, maxActions: 3 })
    expect(result.healed).toBe(false)
    expect(result.actions).toHaveLength(3)
    expect(result.actions.every(attempt => attempt.action === undefined && attempt.error?.includes('shell'))).toBe(true)
    expect(result.steps).toEqual([])
    expect(device.calls.filter(call => call !== 'snapshot')).toEqual([])
  })

  it('checks expect.app via foregroundApp and treats a missing expect as satisfied', async () => {
    const device = fakeHealDevice()
    const step: FlowStep = { id: 'assert-app', do: 'assert', expect: { app: { package: 'com.example' } } }
    const client = fakeClient([{ action: { tool: 'app_start', with: { package: 'com.example', restart: true } }, reason: '重新打开应用' }])
    const result = await runHealAgent({ flow: baseFlow, step, serial: 'test', device, client })
    expect(result.healed).toBe(true)
    expect(device.calls).toContain('foreground')
    expect(device.calls.some(call => call.startsWith('shell:monkey -p'))).toBe(true)

    const plainDevice = fakeHealDevice()
    const plain = await runHealAgent({
      flow: baseFlow,
      step: baseFlow.steps[1],
      serial: 'test',
      device: plainDevice,
      client: fakeClient([{ action: { tool: 'key', with: { key: 'BACK' } }, reason: '先返回' }]),
    })
    expect(plain.healed).toBe(true)
    expect(plainDevice.calls).toContain('key:BACK')
  })

  it('gives up after maxActions when expect never holds', async () => {
    const device = fakeHealDevice({
      waitFor: async (_serial, selector) => {
        const found = !(selector as { content_desc?: string }).content_desc
        return { found, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, ...(found ? { match: { node: targetNode as never, matchCount: 1 } } : {}) }
      },
    })
    const client = fakeClient([{ action: { tool: 'tap', target: [{ text: '设置' }] }, reason: '再试一次' }])
    const result = await runHealAgent({ flow: baseFlow, step: baseFlow.steps[0], serial: 'test', device, client, maxActions: 2 })
    expect(result.healed).toBe(false)
    expect(result.actions).toHaveLength(2)
    expect(result.reason).toContain('2')
    expect(client.prompts[1]).toContain('已尝试')
    expect(client.prompts[1]).toContain('设置')
  })

  it('logs an execution failure and keeps healing', async () => {
    const logger = vi.fn()
    const device = fakeHealDevice()
    const realTap = device.tap
    let taps = 0
    device.tap = async (serial, target, opts) => {
      taps++
      if (taps === 1)
        throw new Error('inject failed')
      return realTap(serial, target, opts)
    }
    const client = fakeClient([{ action: { tool: 'tap', target: [{ text: '设置' }] }, reason: '重试' }])
    const result = await runHealAgent({ flow: baseFlow, step: baseFlow.steps[0], serial: 'test', device, client, logger })
    expect(result.healed).toBe(true)
    expect(result.actions[0].error).toBe('inject failed')
    expect(result.steps.map(step => step.id)).toEqual(['heal-1'])
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('inject failed'))
  })

  it('records an unusable model response and continues with the next prompt', async () => {
    const device = fakeHealDevice()
    const client = fakeClient([
      new Error('LLM response is not valid JSON: {"action"'),
      { action: { tool: 'wait_for', target: [{ content_desc: 'Settings', exact: true }] }, reason: '等待设置出现' },
    ])
    const result = await runHealAgent({ flow: baseFlow, step: baseFlow.steps[0], serial: 'test', device, client })
    expect(result.healed).toBe(true)
    expect(result.actions[0]).toEqual({ error: expect.stringContaining('not valid JSON') })
    expect(client.prompts[1]).toContain('无效响应')
  })
})

describe('env LLM client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns undefined when the FLOW_LLM env is not configured', () => {
    expect(createEnvLlmClient({})).toBeUndefined()
    expect(createEnvLlmClient({ FLOW_LLM_BASE_URL: 'https://llm.example', FLOW_LLM_API_KEY: 'secret' })).toBeUndefined()
  })

  it('parses fenced JSON from a messages-style endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '```json\n{"action":{"tool":"tap","target":[{"text":"设置"}]},"reason":"点设置"}\n```' }],
    })))
    vi.stubGlobal('fetch', fetchMock)
    const client = createEnvLlmClient({ FLOW_LLM_BASE_URL: 'https://llm.example/', FLOW_LLM_API_KEY: 'secret', FLOW_LLM_MODEL: 'test-model', FLOW_LLM_API_TYPE: 'messages' })
    expect(client).toBeDefined()
    const decision = await client!.complete('自愈提示词')
    expect(decision).toEqual({ action: { tool: 'tap', target: [{ text: '设置' }] }, reason: '点设置' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://llm.example/v1/messages')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'test-model', max_tokens: 2048 })
    expect(body.messages[0].content).toBe('自愈提示词')
  })

  it('parses a responses-style endpoint and rejects whitelist violations', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '{"action":{"tool":"input_text","with":{"text":"hi"}},"reason":"输入"}' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: [{ content: [{ text: '{"action":{"tool":"open_url"},"reason":"x"}' }] }] })))
    vi.stubGlobal('fetch', fetchMock)
    const client = createEnvLlmClient({ FLOW_LLM_BASE_URL: 'https://llm.example', FLOW_LLM_API_KEY: 'secret', FLOW_LLM_MODEL: 'test-model', FLOW_LLM_API_TYPE: 'responses' })
    const decision = await client!.complete('prompt')
    expect(decision.action).toEqual({ tool: 'input_text', with: { text: 'hi' } })
    expect(decision.reason).toBe('输入')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://llm.example/v1/responses')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'test-model', input: 'prompt' })

    await expect(client!.complete('prompt')).rejects.toThrow('白名单')
  })
})

describe('heal patch', () => {
  const attempts: HealAttempt[] = [
    { action: { tool: 'tap', target: [{ text: '设置' }] }, reason: '点新的设置入口' },
    { action: { tool: 'tap', target: [{ resource_id: 'id/settings-new' }] }, reason: '真正的设置按钮' },
  ]

  it('replaces a step when the last action matches it, inserts before otherwise', () => {
    const patch = buildPatch(baseFlow, 'open-settings', attempts)
    expect(patch.mode).toBe('replace')
    expect(patch.stepId).toBe('open-settings')
    expect(patch.steps.map(step => step.id)).toEqual(['heal-1', 'heal-2'])
    expect(patch.steps[0].intent).toBe('点新的设置入口')

    const prep = buildPatch(baseFlow, 'input', [{ action: { tool: 'key', with: { key: 'BACK' } }, reason: '关闭弹窗' }])
    expect(prep.mode).toBe('insert-before')
    expect(mergePatch(baseFlow, prep).steps.map(step => step.id)).toEqual(['open-settings', 'heal-1', 'input'])
  })

  it('writes numbered patch files and applies a patch without touching the flow file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-heal-'))
    const flowPath = join(dir, 'settings.flow.yaml')
    await writeFlow(flowPath, baseFlow)
    const patch = buildPatch(baseFlow, 'open-settings', attempts)
    const first = await writePatch(flowPath, patch)
    expect(first.endsWith('settings.flow.yaml.patch-1.yaml')).toBe(true)
    expect(await writePatch(flowPath, patch)).not.toBe(first)
    expect((await readFile(first, 'utf8')).startsWith('stepId: open-settings')).toBe(true)

    const merged = await applyPatch(flowPath, first)
    expect(merged.steps.map(step => step.id)).toEqual(['heal-1', 'heal-2', 'input'])
    expect(merged.steps[0].intent).toBe('点新的设置入口')
    expect((await readFlow(flowPath)).steps.map(step => step.id)).toEqual(['open-settings', 'input'])
  })
})
