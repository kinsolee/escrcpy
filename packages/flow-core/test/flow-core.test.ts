import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatch, compileTrace, parseFlow, readFlow, replayFlow, stringifyFlow, toAutomationScript, writeFlow } from '../src/index.js'
import type { HealLlmClient } from '../src/heal.js'
import { createLlmClient, normalizeLlmApiType, parseHealDecision } from '../src/heal.js'
import { llmConfigSchema, loadLlmConfig, resolveLlm, saveLlmConfig } from '../src/llm-config.js'
import type { ReplayDevice } from '../src/replayer.js'
import type { FlowScript } from '../src/schema.js'

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

describe('flow YAML', () => {
  it('validates and round-trips a flow script', async () => {
    const flow = await readFlow(new URL('./fixtures/settings.flow.yaml', import.meta.url).pathname)
    expect(flow.version).toBe(1)
    expect(flow.steps[0].target?.[0]).toEqual({ resource_id: 'id/settings', exact: true })
    const parsed = parseFlow(stringifyFlow(flow))
    expect(parsed).toEqual(flow)
    const dir = await mkdtemp(join(tmpdir(), 'flow-core-'))
    const path = join(dir, 'out.flow.yaml')
    await writeFlow(path, flow)
    expect((await readFile(path, 'utf8')).startsWith('version: 1')).toBe(true)
    expect(() => parseFlow('version: 1\nname: invalid\nvars: {}\ndefaults: {}\ninterrupts: []\nsteps:\n  - id: tap\n    do: tap\n    target:\n      - text: ""\n')).toThrow()
  })
})

describe('trace compiler', () => {
  it('filters, segments, merges input and parameterizes unique locators', () => {
    const trace = [
      { type: 'session', id: 'tr-1', name: 'message', task: 'Send {{user}}', vars: { user: 'Ada', message: 'Hi' }, device: { serial: 'test', width: 1000, height: 2000 }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'flow_step', args: { intent: 'Open settings' }, ok: true, kind: 'meta' },
      { type: 'call', seq: 2, ts: 3, tool: 'tap', args: { x: 0.05, y: 0.05 }, ok: true, kind: 'action', target: { text: 'Settings', contentDesc: 'Settings', resourceId: 'com.example:id/settings', className: targetNode.className, bounds: [0, 0, 100, 100], ratio: { x: 0.05, y: 0.05 } }, before: { snapshotId: 'snap-1' } },
      { type: 'call', seq: 3, ts: 4, tool: 'input_text', args: { text: 'A' }, ok: true, kind: 'action' },
      { type: 'call', seq: 4, ts: 5, tool: 'input_text', args: { text: 'da' }, ok: true, kind: 'action' },
      { type: 'call', seq: 5, ts: 6, tool: 'ui_tap', args: { text: 'ignored' }, ok: false, kind: 'action' },
      { type: 'call', seq: 6, ts: 7, tool: 'get_screen_state', args: {}, ok: true, kind: 'observe' },
      { type: 'end', outcome: 'completed', endedAt: 8 },
    ] as const
    const result = compileTrace(trace as never, { snapshots: { 'snap-1': snapshot as never } })
    expect(result.flow.steps).toHaveLength(2)
    expect(result.flow.steps[0].intent).toBe('Open settings')
    expect(result.flow.steps[0].target?.[0]).toEqual({ resource_id: 'com.example:id/settings' })
    expect(result.flow.steps[1].with?.text).toBe('{{user}}')
    expect(result.warnings).toEqual([])
  })
})

describe('flow replayer', () => {
  function fakeDevice(waitResults: boolean[]): ReplayDevice & { calls: string[] } {
    const calls: string[] = []
    let i = 0
    return {
      calls,
      waitFor: async (_serial, selector) => {
        calls.push(`wait:${JSON.stringify(selector)}`)
        const found = waitResults[i++] ?? true
        return { found, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, ...(found ? { match: { node: targetNode as never, matchCount: 1 } } : {}) }
      },
      tap: async (_serial, target) => {
        calls.push(`tap:${JSON.stringify(target)}`)
        return {} as never
      },
      inputText: async (_serial, text) => { calls.push(`input:${text}`) },
      key: async (_serial, key) => {
        calls.push(`key:${key}`)
        return 4
      },
      swipe: async () => { calls.push('swipe') },
      screenshot: async () => ({ data: Buffer.from('jpg'), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1 }),
      snapshot: async () => snapshot as never,
    }
  }

  const baseFlow: FlowScript = {
    version: 1,
    name: 'replay',
    vars: { user: { required: true } },
    defaults: { timeout: 10, settle: 0, pollInterval: 0 },
    interrupts: [],
    steps: [
      { id: 'tap', do: 'tap', target: [{ resource_id: 'id/settings' }, { content_desc: 'Settings', exact: true }], expect: { visible: { content_desc: 'Settings', exact: true } } },
      { id: 'input', do: 'input_text', with: { text: '{{user}}' } },
    ],
  }

  it('replays with a backup locator, marks drift, and renders vars', async () => {
    const device = fakeDevice([false, true, true])
    const report = await replayFlow(baseFlow, { serial: 'test', vars: { user: 'Ada' }, device, settleMs: 0 })
    expect(report.status).toBe('completed')
    expect(report.steps[0].locatorIndex).toBe(2)
    expect(report.steps[0].drift).toBe(true)
    expect(device.calls).toContain('input:Ada')
  })

  it('keeps backup locators in the race when a dump fails mid-wait', async () => {
    // First target: dump throws (animated screen); second target matches.
    const base = fakeDevice([])
    const flaky = {
      ...base,
      waitFor: async (_serial: string, selector: unknown) => {
        if ((selector as { content_desc?: string }).content_desc === 'broken')
          throw new Error('waitFor snapshot timed out after 8 ms')
        return { found: true, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, match: { node: targetNode as never, matchCount: 1 } }
      },
    }
    const flow: FlowScript = {
      ...baseFlow,
      steps: [{ id: 'tap', do: 'tap', target: [{ content_desc: 'broken' }, { resource_id: 'id/settings' }] }],
    }
    const report = await replayFlow(flow, { serial: 'test', vars: { user: 'Ada' }, device: flaky, settleMs: 0 })
    expect(report.status).toBe('completed')
    expect(report.steps[0].locatorIndex).toBe(2)
  })

  it('reports expect timeout and saves failure context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-run-'))
    const device = fakeDevice([true, false, false])
    const flow: FlowScript = { ...baseFlow, steps: [baseFlow.steps[0]] }
    const report = await replayFlow(flow, { serial: 'test', vars: { user: 'Ada' }, device, timeoutMs: 0, settleMs: 0, reportDir: dir })
    expect(report.status).toBe('failed')
    expect(report.steps[0].status).toBe('failed')
    expect(report.steps[0].context?.screenshot).toBeDefined()
    expect(report.steps[0].context?.xml).toBeDefined()
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).status).toBe('failed')
  })

  it('blocks dangerous shell actions and times out a stuck shell', async () => {
    const shell = async (_serial: string, command: string): Promise<string> => {
      if (command === 'reboot')
        return ''
      return new Promise(() => {})
    }
    const device = { ...fakeDevice([]), shell }
    const dangerousFlow: FlowScript = { ...baseFlow, vars: {}, steps: [{ id: 'shell', do: 'shell', with: { command: 'reboot' } }] }
    const dangerous = await replayFlow(dangerousFlow, { serial: 'test', device, settleMs: 0 })
    expect(dangerous.status).toBe('failed')
    expect(dangerous.error).toContain('Device reboot')

    const stuckFlow: FlowScript = { ...dangerousFlow, steps: [{ id: 'shell', do: 'shell', with: { command: 'echo ok' } }] }
    const stuck = await replayFlow(stuckFlow, { serial: 'test', device, shellTimeoutMs: 5, settleMs: 0 })
    expect(stuck.status).toBe('failed')
    expect(stuck.error).toContain('shell command timed out')
  })

  it('reports missing variables and expect capability failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-missing-var-'))
    const missing = await replayFlow({ ...baseFlow, steps: [{ id: 'input', do: 'input_text', with: { text: '{{user}}' } }] }, { serial: 'test', device: fakeDevice([]), reportDir: dir, settleMs: 0 })
    expect(missing.status).toBe('failed')
    expect(missing.error).toContain('Missing required flow variable: user')
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).status).toBe('failed')

    const appFlow: FlowScript = { ...baseFlow, vars: {}, steps: [{ id: 'assert-app', do: 'assert', expect: { app: { package: 'com.example' } } }] }
    const appReport = await replayFlow(appFlow, { serial: 'test', device: fakeDevice([]), settleMs: 0 })
    expect(appReport.status).toBe('failed')
    expect(appReport.error).toContain('foregroundApp capability')
  })

  it('rejects traces without successful supported actions', () => {
    const trace = [
      { type: 'session', id: 'observe-only', name: 'observe', task: 'Inspect', device: { serial: 'test' }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'get_screen_state', args: {}, ok: true, kind: 'observe' },
      { type: 'end', outcome: 'completed', endedAt: 3 },
    ]
    expect(() => compileTrace(trace as never)).toThrow('Trace has no successful action calls to compile')
  })

  it('compiles a coordinate action when no target metadata was recorded', () => {
    const trace = [
      { type: 'session', id: 'tr-point', name: 'point', task: 'Tap', device: { serial: 'test' }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'tap', args: { x: 0.25, y: 0.75 }, ok: true, kind: 'action' },
      { type: 'end', outcome: 'completed', endedAt: 3 },
    ]
    const result = compileTrace(trace as never)
    expect(result.flow.steps[0].target).toEqual([{ point: [0.25, 0.75] }])
  })

  it('keeps a recorded settle as a step override and honors it on replay', async () => {
    const trace = [
      { type: 'session', id: 'tr-settle', name: 'settle', task: 'Tap', device: { serial: 'test' }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'tap', args: { x: 0.5, y: 0.5, settle: 1500 }, ok: true, kind: 'action' },
      { type: 'call', seq: 2, ts: 3, tool: 'input_text', args: { text: 'a' }, ok: true, kind: 'action' },
      { type: 'call', seq: 3, ts: 4, tool: 'input_text', args: { text: 'b', settle: 40 }, ok: true, kind: 'action' },
      { type: 'end', outcome: 'completed', endedAt: 5 },
    ]
    const { flow } = compileTrace(trace as never)
    expect(flow.steps.map(step => step.settle)).toEqual([1500, 40])
    expect(flow.steps[1].with?.text).toBe('ab')

    let clock = 0
    const sleeps: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0)
      return realSetTimeout(fn, 0)
    }) as typeof setTimeout
    try {
      await replayFlow({ ...flow, defaults: { settle: 300 } }, { serial: 'test', device: fakeDevice([]), now: () => clock++ })
    }
    finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(sleeps).toEqual([1500, 40])
  })

  it('keeps short resource ids that contain no obfuscation-looking digits', () => {
    const target = { ...targetNode, resourceId: 'id/title' }
    const recorded = { ...snapshot, tree: { ...snapshot.tree, nodes: [target] } }
    const trace = [
      { type: 'session', id: 'tr-short-id', name: 'short id', task: 'Tap', device: { serial: 'test' }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'ui_tap', args: {}, ok: true, kind: 'action', target: { resourceId: 'id/title', bounds: [0, 0, 100, 100] }, before: { snapshotId: 'snap-1' } },
      { type: 'end', outcome: 'completed', endedAt: 3 },
    ]
    const result = compileTrace(trace as never, { snapshots: { 'snap-1': recorded as never } })
    expect(result.flow.steps[0].target?.[0]).toEqual({ resource_id: 'id/title' })
  })

  it('retains framework resource ids and parameterizes numeric variables', () => {
    const trace = [
      { type: 'session', id: 'tr-framework', name: 'framework', task: 'Tap {{count}}', vars: { count: 42, empty: '' }, device: { serial: 'test' }, startedAt: 1 },
      { type: 'call', seq: 1, ts: 2, tool: 'ui_tap', args: {}, ok: true, kind: 'action', target: { resourceId: 'android:id/button1', bounds: [0, 0, 100, 100] }, before: { snapshotId: 'snap-1' } },
      { type: 'call', seq: 2, ts: 3, tool: 'input_text', args: { text: '42' }, ok: true, kind: 'action' },
      { type: 'end', outcome: 'completed', endedAt: 4 },
    ]
    const frameworkSnapshot = { ...snapshot, tree: { ...snapshot.tree, nodes: [{ ...targetNode, resourceId: 'android:id/button1' }] } }
    const result = compileTrace(trace as never, { snapshots: { 'snap-1': frameworkSnapshot as never } })
    expect(result.flow.steps[0].target?.[0]).toEqual({ resource_id: 'android:id/button1' })
    expect(result.flow.steps[1].with?.text).toBe('{{count}}')
    expect(result.flow.vars).toEqual({ count: { required: true }, empty: { required: true } })
  })

  it('does not silently skip wait_for or empty assert steps', async () => {
    const device = fakeDevice([true])
    const waitFlow: FlowScript = {
      version: 1,
      name: 'wait',
      vars: {},
      defaults: { timeout: 1, settle: 0, pollInterval: 0 },
      interrupts: [],
      steps: [{ id: 'wait', do: 'wait_for' }],
    }
    const waitReport = await replayFlow(waitFlow, { serial: 'test', device, timeoutMs: 1, settleMs: 0, pollIntervalMs: 0 })
    expect(waitReport.status).toBe('failed')
    expect(waitReport.error).toContain('wait_for requires a target')

    const assertFlow: FlowScript = { ...waitFlow, name: 'assert', steps: [{ id: 'assert', do: 'assert' }] }
    const assertReport = await replayFlow(assertFlow, { serial: 'test', device, settleMs: 0 })
    expect(assertReport.status).toBe('failed')
    expect(assertReport.error).toContain('assert requires a target or expect')

    const scrollFlow: FlowScript = { ...waitFlow, name: 'scroll', steps: [{ id: 'scroll', do: 'scroll', target: [{ content_desc: 'Settings', exact: true }] }] }
    const scrollReport = await replayFlow(scrollFlow, { serial: 'test', device, settleMs: 0 })
    expect(scrollReport.status).toBe('failed')
    expect(scrollReport.error).toContain('scroll is not implemented in M2')
  })
})

describe('flow interrupts', () => {
  /** A fake screen: `waitFor` matches by resource_id against the visible set, taps mutate it via the script. */
  function screenDevice(script: { visible: string[], onTap?: (id: string, screen: Set<string>) => void }): ReplayDevice & { calls: string[], screen: Set<string> } {
    const calls: string[] = []
    const screen = new Set(script.visible)
    const resourceIdOf = (target: unknown) => typeof target === 'object' && target !== null && 'resource_id' in target ? String((target as { resource_id: string }).resource_id) : ''
    return {
      calls,
      screen,
      waitFor: async (_serial, selector, opts) => {
        const id = resourceIdOf(selector)
        calls.push(`wait:${id}@${opts?.timeoutMs ?? -1}`)
        const found = screen.has(id)
        return { found, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, ...(found ? { match: { node: targetNode as never, matchCount: 1 } } : {}) }
      },
      tap: async (_serial, target) => {
        const id = resourceIdOf(target)
        calls.push(`tap:${id}`)
        script.onTap?.(id, screen)
      },
      inputText: async () => { calls.push('input') },
      key: async () => 4,
      swipe: async () => { calls.push('swipe') },
    }
  }

  function interruptFlow(interrupts: FlowScript['interrupts'], steps: FlowScript['steps']): FlowScript {
    return { version: 1, name: 'interrupts', vars: {}, defaults: { timeout: 20, settle: 0, pollInterval: 5 }, interrupts, steps }
  }

  function replay(flow: FlowScript, device: ReplayDevice) {
    return replayFlow(flow, { serial: 'test', device, timeoutMs: 20, pollIntervalMs: 5, settleMs: 0 })
  }

  const probeTimeoutOf = (device: { calls: string[] }, id: string) => {
    const probe = device.calls.find(call => call.startsWith(`wait:${id}@`))
    expect(probe).toBeDefined()
    return Number(probe!.split('@')[1])
  }

  it('handles an interrupt popup when target resolution fails, then retries the target once', async () => {
    const device = screenDevice({
      visible: ['id/popup-ok'],
      onTap: (id, screen) => {
        if (id === 'id/popup-ok') {
          screen.delete('id/popup-ok')
          screen.add('id/main')
        }
      },
    })
    const flow = interruptFlow(
      [{ when: { resource_id: 'id/popup-ok' }, do: 'tap' }],
      [{ id: 'tap-main', do: 'tap', target: [{ resource_id: 'id/main' }] }],
    )
    const report = await replay(flow, device)
    expect(report.status).toBe('completed')
    expect(report.steps[0].status).toBe('passed')
    expect(report.steps[0].interrupts).toBe(1)
    expect(probeTimeoutOf(device, 'id/popup-ok')).toBeGreaterThan(0)
    expect(device.calls.filter(call => call.startsWith('tap:'))).toEqual(['tap:id/popup-ok', 'tap:id/main'])
  })

  it('handles an interrupt popup when the expect assertion fails, then retries the assertion once', async () => {
    const device = screenDevice({
      visible: ['id/main', 'id/popup-ok'],
      onTap: (id, screen) => {
        if (id === 'id/popup-ok') {
          screen.delete('id/popup-ok')
          screen.add('id/done')
        }
      },
    })
    const flow = interruptFlow(
      [{ when: { resource_id: 'id/popup-ok' }, do: 'tap' }],
      [{ id: 'tap-main', do: 'tap', target: [{ resource_id: 'id/main' }], expect: { visible: { resource_id: 'id/done' } } }],
    )
    const report = await replay(flow, device)
    expect(report.status).toBe('completed')
    expect(report.steps[0].status).toBe('passed')
    expect(report.steps[0].interrupts).toBe(1)
    expect(probeTimeoutOf(device, 'id/popup-ok')).toBeGreaterThan(0)
    expect(device.calls.filter(call => call.startsWith('tap:'))).toEqual(['tap:id/main', 'tap:id/popup-ok'])
  })

  it('keeps normal failure behavior when no interrupt matches', async () => {
    const interrupts: FlowScript['interrupts'] = [{ when: { resource_id: 'id/popup-ok' }, do: 'tap' }]

    const targetDevice = screenDevice({ visible: [] })
    const targetReport = await replay(
      interruptFlow(interrupts, [{ id: 'tap-main', do: 'tap', target: [{ resource_id: 'id/main' }] }]),
      targetDevice,
    )
    expect(targetReport.status).toBe('failed')
    expect(targetReport.steps[0].status).toBe('failed')
    expect(targetReport.steps[0].interrupts).toBe(0)
    expect(targetReport.error).toContain('did not match within 20ms')
    expect(targetDevice.calls.filter(call => call.startsWith('tap:'))).toEqual([])

    const expectDevice = screenDevice({ visible: ['id/main'] })
    const expectReport = await replay(
      interruptFlow(interrupts, [{ id: 'tap-main', do: 'tap', target: [{ resource_id: 'id/main' }], expect: { visible: { resource_id: 'id/done' } } }]),
      expectDevice,
    )
    expect(expectReport.status).toBe('failed')
    expect(expectReport.steps[0].status).toBe('failed')
    expect(expectReport.steps[0].interrupts).toBe(0)
    expect(expectReport.error).toContain('did not match within 20ms')
    expect(expectDevice.calls.filter(call => call.startsWith('tap:'))).toEqual(['tap:id/main'])
  })

  it('handles every matching interrupt in definition order and counts each one', async () => {
    const device = screenDevice({
      visible: ['id/popup-one', 'id/popup-two'],
      onTap: (id, screen) => {
        screen.delete(id)
        if (id === 'id/popup-two')
          screen.add('id/main')
      },
    })
    const flow = interruptFlow(
      [
        { when: { resource_id: 'id/popup-one' }, do: 'tap' },
        { when: { resource_id: 'id/popup-two' }, do: 'tap' },
      ],
      [{ id: 'tap-main', do: 'tap', target: [{ resource_id: 'id/main' }] }],
    )
    const report = await replay(flow, device)
    expect(report.status).toBe('completed')
    expect(report.steps[0].interrupts).toBe(2)
    expect(device.calls.indexOf('wait:id/popup-one@300')).toBeLessThan(device.calls.indexOf('wait:id/popup-two@300'))
    expect(device.calls.filter(call => call.startsWith('tap:'))).toEqual(['tap:id/popup-one', 'tap:id/popup-two', 'tap:id/main'])
  })

  it('accepts a point target as an interrupt when condition', () => {
    const source = [
      'version: 1',
      'name: point-when',
      'vars: {}',
      'defaults: {}',
      'interrupts:',
      '  - when:',
      '      point: [0.5, 0.5]',
      '    do: tap',
      'steps:',
      '  - id: tap',
      '    do: tap',
      '    target:',
      '      - resource_id: id/main',
    ].join('\n')
    const flow = parseFlow(source)
    expect(flow.interrupts[0].when).toEqual({ point: [0.5, 0.5] })
    expect(() => parseFlow(source.replace('point: [0.5, 0.5]', 'image: popup.png'))).toThrow()
  })
})

describe('flow self-heal', () => {
  /** Screen state keyed by resource_id, or `desc:<content_desc>` for expect probes; `onKey` mutates it from key events. */
  function healableDevice(onKey: (screen: Set<string>) => void): ReplayDevice & { calls: string[] } {
    const calls: string[] = []
    const screen = new Set<string>()
    return {
      calls,
      waitFor: async (_serial, selector) => {
        const key = 'resource_id' in selector ? String(selector.resource_id) : `desc:${selector.content_desc}`
        calls.push(`wait:${key}`)
        const found = screen.has(key)
        return { found, snapshot: snapshot as never, attempts: 1, elapsedMs: 1, ...(found ? { match: { node: targetNode as never, matchCount: 1 } } : {}) }
      },
      tap: async (_serial, target) => { calls.push(`tap:${JSON.stringify(target)}`) },
      inputText: async (_serial, text) => { calls.push(`input:${text}`) },
      key: async (_serial, key) => {
        calls.push(`key:${key}`)
        onKey(screen)
        return 4
      },
      swipe: async () => { calls.push('swipe') },
    }
  }

  const healFlow: FlowScript = {
    version: 1,
    name: 'heal-demo',
    vars: {},
    defaults: { timeout: 10, settle: 0, pollInterval: 0 },
    interrupts: [],
    steps: [
      { id: 'open', do: 'tap', target: [{ resource_id: 'id/missing' }], expect: { visible: { content_desc: 'Settings', exact: true } } },
      { id: 'after', do: 'input_text', with: { text: 'ok' } },
    ],
  }

  const backClient: HealLlmClient = { complete: async () => ({ action: { tool: 'key', with: { key: 'BACK' } }, reason: '关闭弹窗' }) }

  it('wraps a single target object from the model into a list', () => {
    const decision = parseHealDecision('{"action":{"tool":"tap","target":{"resource_id":"search_action_bar"}},"reason":"点搜索栏"}')
    expect(decision.action).toMatchObject({ tool: 'tap', target: [{ resource_id: 'search_action_bar' }] })
    expect(decision.reason).toBe('点搜索栏')
    const flat = parseHealDecision('{"action":"tap","target":{"text":"Search settings"},"reason":"点标题"}')
    expect(flat.action).toMatchObject({ tool: 'tap', target: [{ text: 'Search settings' }] })
  })

  it('heals a failed expect step, marks the report, writes a patch, and continues the flow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-heal-'))
    const flowPath = join(dir, 'demo.flow.yaml')
    await writeFlow(flowPath, healFlow)
    const device = healableDevice((screen) => {
      screen.add('desc:Settings')
    })
    const logs: string[] = []
    const report = await replayFlow(healFlow, {
      serial: 'test',
      device,
      timeoutMs: 10,
      pollIntervalMs: 0,
      settleMs: 0,
      flowPath,
      heal: { client: backClient, writePatch: true, logger: message => logs.push(message) },
    })
    expect(report.status).toBe('completed')
    expect(report.flowPath).toBe(flowPath)
    expect(report.steps[0]).toMatchObject({ id: 'open', status: 'passed', healed: true })
    expect(report.steps[0].error).toBeUndefined()
    expect(report.steps[1]).toMatchObject({ id: 'after', status: 'passed' })
    expect(device.calls).toContain('key:BACK')
    expect(device.calls).toContain('input:ok')
    const patchPath = join(dir, 'demo.flow.yaml.patch-1.yaml')
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('stepId: open')
    expect(patch).toContain('insert-before')
    expect(patch).toContain('key: BACK')
    expect(logs.some(message => message.includes(patchPath))).toBe(true)
  })

  it('keeps the original failure when the heal agent gives up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-heal-'))
    const flowPath = join(dir, 'demo.flow.yaml')
    await writeFlow(flowPath, healFlow)
    const device = healableDevice(() => {})
    const report = await replayFlow(healFlow, {
      serial: 'test',
      device,
      timeoutMs: 10,
      pollIntervalMs: 0,
      settleMs: 0,
      flowPath,
      heal: { client: backClient, maxActions: 2 },
    })
    expect(report.status).toBe('failed')
    expect(report.error).toContain('did not match within 10ms')
    expect(report.steps[0]).toMatchObject({ id: 'open', status: 'failed' })
    expect(report.steps[0].healed).toBeUndefined()
    expect(device.calls).toContain('key:BACK')
    expect(device.calls).not.toContain('input:ok')
    expect(await readdir(dir)).toEqual(['demo.flow.yaml'])
  })

  it('leaves steps without expect on the normal failure path even when heal is configured', async () => {
    const flow: FlowScript = { ...healFlow, steps: [{ id: 'open', do: 'tap', target: [{ resource_id: 'id/missing' }] }] }
    const device = healableDevice(() => {})
    const prompts: string[] = []
    const client: HealLlmClient = {
      complete: async (prompt) => {
        prompts.push(prompt)
        return { action: { tool: 'key', with: { key: 'BACK' } }, reason: '' }
      },
    }
    const report = await replayFlow(flow, {
      serial: 'test',
      device,
      timeoutMs: 10,
      pollIntervalMs: 0,
      settleMs: 0,
      heal: { client },
    })
    expect(report.status).toBe('failed')
    expect(report.steps[0].healed).toBeUndefined()
    expect(prompts).toEqual([])
  })

  it('round-trips a written patch through applyPatch against the flow file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-patch-'))
    const flowPath = join(dir, 'demo.flow.yaml')
    await writeFile(flowPath, stringifyFlow(healFlow))
    const patchPath = join(dir, 'demo.flow.yaml.patch-1.yaml')
    await writeFile(patchPath, `stepId: open\nmode: insert-before\nsteps:\n  - id: heal-1\n    intent: 关闭弹窗\n    do: key\n    with:\n      key: BACK\n`, 'utf8')
    const healed = await applyPatch(flowPath, patchPath)
    expect(healed.steps.map(step => step.id)).toEqual(['heal-1', 'open', 'after'])
    expect(await readFile(flowPath, 'utf8')).toContain('id: open')
  })
})

describe('llm client and shared config', () => {
  it('normalizes api type spellings', () => {
    expect(normalizeLlmApiType(undefined)).toBe('messages')
    expect(normalizeLlmApiType('responses')).toBe('responses')
    expect(normalizeLlmApiType('chat_completions')).toBe('chat_completions')
    expect(normalizeLlmApiType('chat-completions')).toBe('chat_completions')
    expect(normalizeLlmApiType('CHAT')).toBe('chat_completions')
  })

  it('createLlmClient posts chat_completions and parses the choice content', async () => {
    const originalFetch = globalThis.fetch
    const seen: Array<{ url: string, body: { model?: string, messages?: Array<{ role?: string }> }, init: RequestInit }> = []
    globalThis.fetch = (async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), init: init! })
      const content = '模型回复 ```json\n{"action":{"tool":"key","with":{"key":"BACK"}},"reason":"关弹窗"}\n```'
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 })
    }) as typeof fetch
    try {
      const client = createLlmClient({ baseUrl: 'http://gateway.test/', apiKey: 'k', model: 'm1', apiType: 'chat' })
      const decision = await client!.complete('prompt')
      expect(decision.action).toMatchObject({ tool: 'key', with: { key: 'BACK' } })
      expect(decision.reason).toBe('关弹窗')
      expect(seen[0].url).toBe('http://gateway.test/v1/chat/completions')
      expect(seen[0].body.model).toBe('m1')
      expect(seen[0].body.messages?.[0]?.role).toBe('user')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to reasoning_content when a reasoning model exhausts content', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, reasoning_content: '{"action":{"tool":"wait_for","target":[{"text":"Settings"}]},"reason":"等一下"}' } }],
    }), { status: 200 })) as typeof fetch
    try {
      const client = createLlmClient({ baseUrl: 'http://gateway.test', apiKey: 'k', model: 'm1', apiType: 'chat_completions' })
      const decision = await client!.complete('prompt')
      expect(decision.action).toMatchObject({ tool: 'wait_for', target: [{ text: 'Settings' }] })
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('saves a config file and resolves the active vendor model from it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-config-'))
    const file = join(dir, 'llm.json')
    saveLlmConfig({
      active: 'magpie::claude/claude-sonnet-5-5',
      vendors: [{ id: 'magpie', name: 'Magpie', baseUrl: 'http://127.0.0.1:3425', apiKey: 'magpie', apiType: 'messages', models: [{ id: 'claude/claude-sonnet-5-5', vision: true }] }],
    }, file)
    const config = loadLlmConfig(file)
    expect(config?.vendors[0]?.models[0]?.vision).toBe(true)
    const resolved = resolveLlm(config)
    expect(resolved?.vendor.id).toBe('magpie')
    expect(resolved?.model).toBe('claude/claude-sonnet-5-5')
    expect(resolved?.client).toBeDefined()
    expect(resolveLlm({ active: 'ghost::m', vendors: [] })).toBeUndefined()
    expect(resolveLlm({ active: undefined, vendors: [] })).toBeUndefined()
  })

  it('tolerates an empty vendor display name but not a missing id', () => {
    const ok = llmConfigSchema.safeParse({
      vendors: [{ id: 'mimo', name: '', baseUrl: 'https://example.com', apiKey: '', models: [] }],
    })
    expect(ok.success).toBe(true)

    const noId = llmConfigSchema.safeParse({
      vendors: [{ id: '', name: 'n', baseUrl: 'https://example.com', apiKey: '', models: [] }],
    })
    expect(noId.success).toBe(false)

    const noBaseUrl = llmConfigSchema.safeParse({
      vendors: [{ id: 'mimo', name: 'n', baseUrl: '', apiKey: '', models: [] }],
    })
    expect(noBaseUrl.success).toBe(false)
  })
})

describe('automation export', () => {
  it('maps point-based steps and skips selector-only ones', () => {
    const flow: FlowScript = {
      version: 1,
      name: 'demo',
      description: 'd',
      vars: { query: { required: true } },
      defaults: {},
      interrupts: [],
      steps: [
        { id: 's1', intent: 'Launch', do: 'app_start', with: { package: 'com.android.settings', restart: true }, settle: 2500 },
        { id: 's2', do: 'tap', target: [{ point: [0.5, 0.28] }] },
        { id: 's3', do: 'tap', target: [{ resource_id: 'id/gone' }] },
        { id: 's4', do: 'input_text', with: { text: '{{query}}' } },
        { id: 's5', do: 'key', with: { key: 4 } },
        { id: 's6', do: 'sleep', with: { duration_ms: 800 } },
        { id: 's7', do: 'swipe', with: { from: { x: 0.5, y: 0.7 }, to: { x: 0.5, y: 0.2 }, duration_ms: 350 } },
        { id: 's8', do: 'extract', with: { list: { resource_id: 'x' }, columns: {} } },
      ],
    }
    const { script, skipped } = toAutomationScript(flow)
    expect(skipped).toEqual(['s3', 's8'])
    expect(script.variables).toEqual([{ name: 'query' }])
    expect(script.steps.map(step => step.type)).toEqual(['launch', 'tap', 'input', 'key', 'wait', 'swipe'])
    expect(script.steps[0]).toMatchObject({ type: 'launch', params: { packageName: 'com.android.settings', forceStop: true }, delayBefore: 2500 })
    expect(script.steps[1].params).toEqual({ x: 0.5, y: 0.28 })
    expect(script.steps[5].params).toEqual({ startX: 0.5, startY: 0.7, endX: 0.5, endY: 0.2, duration: 350 })
  })
})
