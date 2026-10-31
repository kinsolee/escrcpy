import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createFlowMcpServer } from '../src/index.js'
import { FlowTraceRecorder } from '../src/recorder.js'
import { compileTrace } from '../../flow-core/src/compiler.js'
import type { DeviceLease, FlowDevice, LeaseInfo, Snapshot } from '@escrcpy/flow-device'
import { LeaseBusyError, parseUiTree } from '@escrcpy/flow-device'
import { fixture } from '../../flow-device/test/helpers.js'

// The real factory builds an adb client; vitest's CJS interop hides adbkit's
// namespace, so stub it — nothing in these tests should reach a device anyway.
vi.mock('@devicefarmer/adbkit', () => ({ default: { Adb: { createClient: () => ({}) } } }))

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

function fakeLease(): DeviceLease & { held: Map<string, LeaseInfo> } {
  const held = new Map<string, LeaseInfo>()
  return {
    held,
    async acquire(serial, options) {
      const current = held.get(serial)
      if (current)
        throw new LeaseBusyError(`Device ${serial} is leased by ${current.holder} (pid ${current.pid})`, current)
      const lease: LeaseInfo = { serial, holder: options?.holder ?? `pid:${process.pid}`, pid: process.pid, acquiredAt: Date.now() }
      held.set(serial, lease)
      return lease
    },
    async release(serial) {
      return held.delete(serial)
    },
    async refresh() {},
    async info(serial) {
      return held.get(serial)
    },
    async list() {
      return [...held.values()]
    },
  }
}

function textOf(result: { content: Array<{ text?: unknown }> }): any {
  return JSON.parse(String(result.content[0].text))
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
    await recorder.setIntent('retry settings')
    await recorder.recordCall({ tool: 'ui_tap', args: { content_desc: 'Missing' }, ok: false, kind: 'action', error: 'not found', durationMs: 1 })
    await recorder.recordCall({ tool: 'get_screen_state', args: {}, ok: true, kind: 'observe', durationMs: 1 })
    await recorder.recordCall({ tool: 'ui_tap', args: { content_desc: 'Settings' }, ok: true, kind: 'action', durationMs: 1 })
    const result = await recorder.stop('completed')
    const lines = (await readFile(result!.tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.type)).toEqual(['session', 'call', 'call', 'call', 'call', 'call', 'end'])
    expect(lines[1].before.snapshotId).toBe('snap_fixture')
    expect(lines[1].target.contentDesc).toBe('Settings')
    expect(lines[1].intent).toBe('open settings')
    expect(lines[2].snapshotRef).toBe('snap_fixture')
    expect(lines[2].intent).toBeUndefined()
    expect(lines[3].intent).toBe('retry settings')
    expect(lines[4].intent).toBeUndefined()
    expect(lines[5].intent).toBe('retry settings')
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

  it('blocks dangerous shell input and quotes app arguments', async () => {
    const shell = vi.fn(async () => '')
    const adbx = { shell, deviceInfo: { getScreenSize: async () => ({ width: 100, height: 100 }), getOrientation: async () => 0 } } as never
    const flow = createFlowMcpServer({ device: fakeDevice(), adbx, defaultSerial: 'fake-1' })
    const client = new Client({ name: 'flow-mcp-security-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    const app = await client.callTool({ name: 'app_start', arguments: { package: 'com.example; reboot', restart: true } })
    expect(app.isError).toBe(true)
    expect(shell).not.toHaveBeenCalled()
    const command = await client.callTool({ name: 'app_start', arguments: { package: 'com.example/app\'one', restart: true } })
    expect(command.isError).not.toBe(true)
    expect(shell.mock.calls[0]?.[1]).toContain('\'\\\'\'')
    const dangerous = await client.callTool({ name: 'shell_exec', arguments: { command: 'reboot' } })
    expect(dangerous.isError).toBe(true)
    await client.close()
    await flow.server.close()
  })
})

describe('flow MCP lease tools', () => {
  async function connect(flow: ReturnType<typeof createFlowMcpServer>) {
    const client = new Client({ name: 'flow-mcp-lease-test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    return client
  }

  it('claims a device and returns the lease', async () => {
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device: fakeDevice(), lease, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    const claimed = await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-a' } })
    expect(claimed.isError).not.toBe(true)
    expect(textOf(claimed)).toMatchObject({ serial: 'fake-1', holder: 'worker-a', pid: process.pid })
    expect(await lease.info('fake-1')).toMatchObject({ holder: 'worker-a' })
    await client.close()
    await flow.server.close()
  })

  it('rejects a second claim with the current holder in the message', async () => {
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device: fakeDevice(), lease, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-a' } })
    const busy = await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-b' } })
    expect(busy.isError).toBe(true)
    expect(String((busy.content as [{ text?: unknown }])[0].text)).toContain('worker-a')
    await client.close()
    await flow.server.close()
  })

  it('shows the lease in device_list and frees the device after release', async () => {
    const lease = fakeLease()
    const adbx = { getDevices: async () => [{ id: 'fake-1', type: 'device' }] } as never
    const flow = createFlowMcpServer({ device: fakeDevice(), adbx, lease, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-a' } })
    const leased = textOf(await client.callTool({ name: 'device_list', arguments: {} }))
    expect(leased).toEqual([{ id: 'fake-1', type: 'device', lease: { holder: 'worker-a', pid: process.pid, acquiredAt: expect.any(Number) } }])
    expect(textOf(await client.callTool({ name: 'device_release', arguments: { serial: 'fake-1' } }))).toBe(true)
    const idle = textOf(await client.callTool({ name: 'device_list', arguments: {} }))
    expect(idle[0].lease).toBeNull()
    expect(textOf(await client.callTool({ name: 'device_release', arguments: { serial: 'fake-1' } }))).toBe(false)
    await client.close()
    await flow.server.close()
  })

  it('refuses actions on a device leased by another process, observations still work', async () => {
    const lease = fakeLease()
    lease.held.set('fake-1', { serial: 'fake-1', holder: 'someone-else', pid: 999_999_999, acquiredAt: Date.now() })
    const flow = createFlowMcpServer({ device: fakeDevice(), lease, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    const blocked = await client.callTool({ name: 'ui_tap', arguments: { serial: 'fake-1', content_desc: 'Settings' } })
    expect(blocked.isError).toBe(true)
    const message = JSON.stringify(blocked.content)
    expect(message).toContain('DEVICE_BUSY')
    expect(message).toContain('someone-else')
    const observed = await client.callTool({ name: 'get_screen_state', arguments: { serial: 'fake-1' } })
    expect(observed.isError).not.toBe(true)
    await client.close()
    await flow.server.close()
  })

  it('lets actions through and refreshes a lease held by this server process', async () => {
    const lease = fakeLease()
    const refreshed: string[] = []
    const trackingLease: DeviceLease = {
      ...lease,
      refresh: async (serial: string) => {
        refreshed.push(serial)
      },
    }
    const flow = createFlowMcpServer({ device: fakeDevice(), lease: trackingLease, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-a' } })
    const tapped = await client.callTool({ name: 'tap', arguments: { serial: 'fake-1', x: 0.1, y: 0.1 } })
    expect(tapped.isError).not.toBe(true)
    expect(refreshed).toEqual(['fake-1'])
    await client.close()
    await flow.server.close()
  })

  it('does not restart FLOW_TRACE_DIR auto-recording after an explicit stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-autotrace-'))
    const flow = createFlowMcpServer({ device: fakeDevice(), traceDir: dir, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    await client.callTool({ name: 'tap', arguments: { serial: 'fake-1', x: 0.1, y: 0.1 } })
    await client.callTool({ name: 'flow_record_stop', arguments: { outcome: 'completed' } })
    const before = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
    await client.callTool({ name: 'tap', arguments: { serial: 'fake-1', x: 0.2, y: 0.2 } })
    const after = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
    expect(after).toEqual(before)
    await client.close()
    await flow.server.close()
  })

  it('records claim/release as meta so compileTrace emits no steps for them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-lease-trace-'))
    const recorder = new FlowTraceRecorder({ dir, id: 'tr_lease' })
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device: fakeDevice(), lease, recorder, defaultSerial: 'fake-1' })
    const client = await connect(flow)
    await client.callTool({ name: 'flow_record_start', arguments: { name: 'lease-trace', task: 'claim, tap, release', serial: 'fake-1' } })
    await client.callTool({ name: 'device_claim', arguments: { serial: 'fake-1', holder: 'worker-a' } })
    const tapped = await client.callTool({ name: 'tap', arguments: { serial: 'fake-1', x: 0.1, y: 0.1 } })
    expect(tapped.isError).not.toBe(true)
    await client.callTool({ name: 'device_release', arguments: { serial: 'fake-1' } })
    await client.callTool({ name: 'flow_record_stop', arguments: { outcome: 'completed' } })
    const trace = await readFile(join(dir, 'tr_lease.jsonl'), 'utf8')
    const calls = trace.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.type === 'call')
    expect(Object.fromEntries(calls.filter(call => call.tool === 'device_claim' || call.tool === 'device_release').map(call => [call.tool, call.kind]))).toEqual({ device_claim: 'meta', device_release: 'meta' })
    const { flow: compiled, warnings } = compileTrace(trace)
    expect(compiled.steps.map(step => step.do)).toEqual(['tap'])
    expect(warnings.join('\n')).not.toContain('device_claim')
    expect(warnings.join('\n')).not.toContain('device_release')
    await client.close()
    await flow.server.close()
  })
})

describe('createInProcessFlowMcp', () => {
  it('lists the full tool surface and rejects unknown tools without touching a device', async () => {
    const { createInProcessFlowMcp } = await import('../src/index.js')
    const mcp = await createInProcessFlowMcp({})
    try {
      const names = mcp.tools.map(tool => tool.name)
      expect(names.length).toBeGreaterThan(30)
      expect(names).toContain('device_select')
      expect(names).toContain('flow_record_start')
      for (const agentTool of ['app_install', 'app_uninstall', 'flow_list', 'flow_run', 'flow_compile'])
        expect(names).toContain(agentTool)
      await expect(mcp.callTool('definitely_not_a_tool', {})).rejects.toThrow()
    }
    finally {
      await mcp.close()
    }
  })

  it('installs a local apk via push + pm install and uninstalls via pm', async () => {
    const { createFlowMcpServer } = await import('../src/index.js')
    const apk = join(await mkdtemp(join(tmpdir(), 'apk-')), 'demo.apk')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(apk, 'PK\x03\x04fake')
    const shell = vi.fn(async (_serial: string, command: string) => (command.includes('pm install') || command.includes('pm uninstall') ? 'Success' : ''))
    const push = vi.fn(async () => {})
    const adbx = { shell, push, deviceInfo: { getScreenSize: async () => ({ width: 100, height: 100 }), getOrientation: async () => 0 } } as never
    const flow = createFlowMcpServer({ device: fakeDevice(), adbx, defaultSerial: 'fake-1' })
    const client = new Client({ name: 'flow-mcp-install-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    const installed = await client.callTool({ name: 'app_install', arguments: { serial: 'fake-1', path: apk, reinstall: true } })
    expect(installed.isError).not.toBe(true)
    expect(push).toHaveBeenCalledTimes(1)
    const pushArgs = push.mock.calls[0] as unknown[]
    expect(String(pushArgs[2])).toContain('/data/local/tmp/escrcpy-install-')
    const installCommand = shell.mock.calls.find(call => String(call[1]).includes('pm install'))?.[1] as string
    expect(installCommand).toContain('pm install -r')
    const cleanup = shell.mock.calls.filter(call => String(call[1]).includes('rm -f'))
    expect(cleanup.length).toBe(1)
    const uninstalled = await client.callTool({ name: 'app_uninstall', arguments: { serial: 'fake-1', package: 'com.example.app' } })
    expect(uninstalled.isError).not.toBe(true)
    expect(shell.mock.calls.at(-1)?.[1]).toBe('pm uninstall \'com.example.app\'')
    const missing = await client.callTool({ name: 'app_install', arguments: { serial: 'fake-1', path: '/definitely/missing.apk' } })
    expect(missing.isError).toBe(true)
    await client.close()
    await flow.server.close()
  })

  it('compiles a trace into the scripts dir via flow_compile and lists it via flow_list', async () => {
    const { createFlowMcpServer } = await import('../src/index.js')
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-compile-'))
    const recorder = new FlowTraceRecorder({ dir, id: 'tr_compile' })
    const before = snapshot('fake-1')
    await recorder.start({ name: 'agent-flow', task: 'tap settings', vars: {}, device: { serial: 'fake-1', width: 1000, height: 2000 } })
    await recorder.recordCall({ tool: 'ui_tap', args: { content_desc: '图库：1条消息未读' }, ok: true, kind: 'action', before, target: { text: '', contentDesc: '图库：1条消息未读', resourceId: '', className: 'android.widget.TextView', bounds: [0, 0, 100, 100] }, durationMs: 2 })
    const { tracePath } = (await recorder.stop('completed'))!
    process.env.FLOW_SCRIPTS_DIR = join(dir, 'scripts')
    const flow = createFlowMcpServer({ device: fakeDevice(), defaultSerial: 'fake-1' })
    const client = new Client({ name: 'flow-mcp-compile-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    const compileRaw = String((await client.callTool({ name: 'flow_compile', arguments: { trace_path: tracePath } })).content![0].text)
    console.error('COMPILE_RAW:', compileRaw.slice(0, 300))
    const compiled = JSON.parse(compileRaw)
    expect(compiled.name).toBe('agent-flow')
    expect(compiled.steps).toBe(1)
    expect(compiled.path).toMatch(/\.flow\.yaml$/)
    const listed = JSON.parse(String((await client.callTool({ name: 'flow_list', arguments: {} })).content![0].text))
    expect(listed.flows.map((item: { file: string }) => item.file)).toContain(`${compiled.name}.flow.yaml`)
    delete process.env.FLOW_SCRIPTS_DIR
    await client.close()
    await flow.server.close()
  })

  it('runs a saved flow end-to-end against the fake device via flow_run', async () => {
    const { createFlowMcpServer } = await import('../src/index.js')
    const dir = await mkdtemp(join(tmpdir(), 'flow-mcp-run-'))
    process.env.FLOW_SCRIPTS_DIR = dir
    process.env.FLOW_REPORTS_DIR = join(dir, 'reports')
    await writeFile(join(dir, 'tap-settings.flow.yaml'), [
      'version: 1',
      'name: tap-settings',
      'description: tap settings',
      'vars: {}',
      'steps:',
      '  - id: step-1',
      '    do: tap',
      '    target:',
      '      - content_desc: 图库：1条消息未读',
    ].join('\n'), 'utf8')
    const flow = createFlowMcpServer({ device: fakeDevice(), defaultSerial: 'fake-1' })
    const client = new Client({ name: 'flow-mcp-run-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
    const ran = JSON.parse(String((await client.callTool({ name: 'flow_run', arguments: { serial: 'fake-1', path: 'tap-settings' } })).content![0].text))
    expect(ran.report.status).toBe('completed')
    expect(ran.report.steps[0].status).toBe('passed')
    delete process.env.FLOW_SCRIPTS_DIR
    delete process.env.FLOW_REPORTS_DIR
    await client.close()
    await flow.server.close()
  })
})
