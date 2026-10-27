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
})
