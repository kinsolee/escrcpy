import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileTrace, parseFlow, readFlow, replayFlow, stringifyFlow, writeFlow } from '../src/index.js'
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
