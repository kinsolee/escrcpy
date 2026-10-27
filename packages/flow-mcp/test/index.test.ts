import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createFlowMcpServer } from '../src/index.js'
import { FlowTraceRecorder } from '../src/recorder.js'
import type { FlowDevice, Snapshot } from '@escrcpy/flow-device'
import { parseUiTree } from '@escrcpy/flow-device'
import { fixture } from '../../flow-device/test/helpers.js'

function snapshot(serial: string): Snapshot {
  return {
    id: 'snap_fixture',
    serial,
    createdAt: Date.now(),
    xml: fixture('launcher-uiautomator.xml'),
    tree: parseUiTree(fixture('launcher-uiautomator.xml')),
    app: { package: 'com.example.launcher', activity: '.MainActivity' },
    dumpMs: 1,
  }
}

function fakeDevice(): FlowDevice {
  const current = snapshot('fake-1')
  const device = {
    snapshots: { latest: () => current },
    snapshot: async () => current,
    getSnapshot: async () => current,
    elements: (value: Snapshot) => value.tree.nodes.map(node => ({
      id: node.id,
      type: node.className.split('.').at(-1) ?? node.className,
      text: node.text,
      contentDesc: node.contentDesc,
      resourceId: node.resourceId,
      className: node.className,
      bounds: { x: node.bounds.left, y: node.bounds.top, width: node.bounds.right - node.bounds.left, height: node.bounds.bottom - node.bounds.top },
      centerX: (node.bounds.left + node.bounds.right) / 2,
      centerY: (node.bounds.top + node.bounds.bottom) / 2,
    })),
    foregroundApp: async () => current.app,
    screenSize: async () => current.tree.size,
    find: async () => ({ snapshot: current, matches: [current.tree.nodes.find(node => node.contentDesc === 'Settings')!] }),
    waitFor: async () => ({ found: true, snapshot: current, match: { node: current.tree.nodes[0], matchCount: 1 }, attempts: 1, elapsedMs: 1 }),
    resolveTarget: async () => ({ point: { x: 100, y: 100 }, ratio: { x: 0.1, y: 0.1 }, size: current.tree.size, node: current.tree.nodes[0], matchCount: 1, snapshotId: current.id }),
    tap: async () => ({ point: { x: 100, y: 100 }, ratio: { x: 0.1, y: 0.1 }, size: current.tree.size, node: current.tree.nodes[0], matchCount: 1, snapshotId: current.id }),
    longPress: async () => ({ point: { x: 100, y: 100 }, ratio: { x: 0.1, y: 0.1 }, size: current.tree.size, node: current.tree.nodes[0], matchCount: 1, snapshotId: current.id }),
    swipe: async () => undefined,
    inputText: async () => undefined,
    key: async () => 4,
    screenshot: async () => ({ data: Buffer.from('jpeg'), width: 100, height: 100, sourceWidth: 100, sourceHeight: 100 }),
    screencap: async () => Buffer.from('png'),
  } as unknown as FlowDevice
  return device
}

describe('flowTraceRecorder', () => {
  it('writes parseable JSONL with session, call, end and snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-'))
    const recorder = new FlowTraceRecorder({ dir, id: 'tr_test', now: () => 1000 })
    const before = snapshot('fake-1')
    await recorder.start({ name: 'test', task: 'tap settings', vars: { user: 'Ada' }, device: { serial: 'fake-1', width: 1000, height: 2000 } })
    await recorder.setIntent('open settings')
    await recorder.recordCall({ tool: 'ui_tap', args: { content_desc: 'Settings' }, ok: true, kind: 'action', before, target: { text: '', contentDesc: 'Settings', resourceId: 'id/settings', className: 'android.widget.Button', bounds: [0, 0, 100, 100] }, durationMs: 4 })
    await recorder.recordCall({ tool: 'get_screen_state', args: {}, ok: true, kind: 'observe', snapshotRef: before.id, durationMs: 2 })
    const result = await recorder.stop('completed')
    const lines = (await readFile(result!.tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.type)).toEqual(['session', 'call', 'call', 'end'])
    expect(lines[1].before.snapshotId).toBe('snap_fixture')
    expect(lines[1].target.contentDesc).toBe('Settings')
    expect(lines[1].intent).toBe('open settings')
    expect(lines[2].snapshotRef).toBe('snap_fixture')
    expect((await readdir(join(dir, 'snapshots')))).toContain('snap_fixture.json')
  })
})

describe('flow MCP server', () => {
  it('registers tools and prompt with an injectable fake device', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-server-'))
    const recorder = new FlowTraceRecorder({ dir, id: 'tr_server' })
    const flow = createFlowMcpServer({ device: fakeDevice(), recorder, defaultSerial: 'fake-1' })
    const client = new Client({ name: 'flow-mcp-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)
    expect(names).toContain('flow_record_start')
    expect(names).toContain('ui_tap')
    expect(names).toContain('tap')
    const prompts = await client.listPrompts()
    expect(prompts.prompts.map(prompt => prompt.name)).toContain('flow/explore')
    const start = await client.callTool({ name: 'flow_record_start', arguments: { name: 'server-test', task: 'tap a point', serial: 'fake-1' } })
    expect(start.isError).not.toBe(true)
    const observed = await client.callTool({ name: 'get_screen_state', arguments: { serial: 'fake-1' } })
    expect(observed.isError).not.toBe(true)
    const tapped = await client.callTool({ name: 'tap', arguments: { serial: 'fake-1', x: 0.1, y: 0.1 } })
    expect(tapped.isError).not.toBe(true)
    const stopped = await client.callTool({ name: 'flow_record_stop', arguments: { outcome: 'completed' } })
    expect(stopped.isError).not.toBe(true)
    const lines = (await readFile(join(dir, 'tr_server.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.type)).toEqual(['session', 'call', 'call', 'end'])
    expect(lines[1].snapshotRef).toBe('snap_fixture')
    expect(lines[2].target.ratio).toEqual({ x: 0.1, y: 0.1 })
    await client.close()
    await flow.server.close()
  })
})
