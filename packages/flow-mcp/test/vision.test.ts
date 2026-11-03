import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DeviceLease, FlowDevice, LeaseInfo } from '@escrcpy/flow-device'
import { encodePng, LeaseBusyError, parseUiTree } from '@escrcpy/flow-device'
import { connectInProcess, createFlowMcpServer, isEntryModule } from '../src/index.js'
import type { FlowMcpServer } from '../src/index.js'
import { fixture } from '../../flow-device/test/helpers.js'

vi.mock('@devicefarmer/adbkit', () => ({ default: { Adb: { createClient: () => ({}) } } }))

const SERIAL = 'fake-1'
const LAUNCHER = 'com.example.launcher'
const XML = fixture('launcher-uiautomator.xml')

function png(shade: number) {
  return encodePng({ width: 54, height: 120, data: new Uint8Array(54 * 120 * 3).fill(shade) })
}

function fakeDevice() {
  const tree = parseUiTree(XML)
  const calls: string[] = []
  let shade = 10
  const device = {
    snapshot: async () => ({ id: 'snap_1', serial: SERIAL, createdAt: Date.now(), xml: XML, tree, app: { package: LAUNCHER, activity: '.Main' } }),
    foregroundApp: async () => ({ package: LAUNCHER, activity: `${LAUNCHER}.Main` }),
    screenSize: async () => tree.size,
    waitFor: async () => ({ found: true, snapshot: { id: 'snap_1', tree }, match: { node: tree.nodes[0], matchCount: 1 }, attempts: 1, elapsedMs: 1 }),
    tap: async () => {
      calls.push('tap')
      shade += 40
      return { point: { x: 1, y: 1 }, ratio: { x: 0.1, y: 0.1 }, size: tree.size }
    },
    longPress: async () => undefined,
    swipe: async () => undefined,
    inputText: async () => undefined,
    key: async () => 4,
    screenshot: async () => ({ data: png(10), mimeType: 'image/png', width: 54, height: 120, sourceWidth: 54, sourceHeight: 120 }),
    screencap: async () => png(shade),
    elements: () => [],
  } as unknown as FlowDevice
  return { device, calls }
}

function fakeAdbx() {
  return {
    shell: vi.fn(async () => ''),
    ui: { dumpLayout: async () => XML },
    clipboard: { read: vi.fn(async () => 'https://www.tiktok.com/view/product/1') },
    yadb: { isAvailable: () => true },
    getDevices: async () => [{ id: SERIAL, type: 'device' }],
    deviceInfo: {},
  }
}

function fakeLease(): DeviceLease & { held: Map<string, LeaseInfo> } {
  const held = new Map<string, LeaseInfo>()
  return {
    held,
    async acquire(serial, options) {
      const current = held.get(serial)
      if (current)
        throw new LeaseBusyError(`Device ${serial} is leased by ${current.holder} (pid ${current.pid})`, current)
      const lease: LeaseInfo = { serial, holder: options?.holder ?? 'x', pid: process.pid, acquiredAt: Date.now() }
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

async function connect(flow: FlowMcpServer): Promise<Client> {
  const client = new Client({ name: 'vision-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([flow.server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): any {
  return JSON.parse(String((result.content as Array<{ text?: string }>)[0].text))
}

/** A chat_completions gateway that replays scripted actions. */
function stubGateway(actions: Array<Record<string, unknown>>) {
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const action = actions.shift() ?? { type: 'fail', reason: 'script ended' }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ thought: 't', action }) } }], usage: { prompt_tokens: 50, completion_tokens: 5 } })
  }))
  return bodies
}

let dir: string
const savedEnv = { ...process.env }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flow-mcp-vision-'))
  process.env.FLOW_LLM_CONFIG = join(dir, 'missing-llm.json')
  process.env.FLOW_LLM_BASE_URL = 'http://gateway.test'
  process.env.FLOW_LLM_API_KEY = 'sk-mcp-test-key'
  process.env.FLOW_LLM_MODEL = 'vision-model'
  process.env.FLOW_LLM_API_TYPE = 'chat_completions'
})
afterEach(async () => {
  vi.unstubAllGlobals()
  process.env = { ...savedEnv }
  await rm(dir, { recursive: true, force: true })
})

describe('vision_agent_run', () => {
  it('runs the vision agent with the screenshot, holds the lease and writes a key-free report', async () => {
    const bodies = stubGateway([
      { type: 'tap', x: 500, y: 500 },
      { type: 'read_clipboard' },
      { type: 'done', success: true, result: { links: ['https://www.tiktok.com/view/product/1'] } },
    ])
    const { device, calls } = fakeDevice()
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device, adbx: fakeAdbx() as never, lease })
    const client = await connect(flow)
    const runDir = join(dir, 'run')
    const result = textOf(await client.callTool({ name: 'vision_agent_run', arguments: { serial: SERIAL, goal: 'copy a link', allowed_packages: [LAUNCHER], run_dir: runDir, result_schema: { links: 'string[]' } } }))
    expect(result).toMatchObject({ status: 'done', success: true, steps: 3, modelCalls: 3, tokens: { total: 165 }, clipboardReads: ['https://www.tiktok.com/view/product/1'] })
    expect(calls).toEqual(['tap'])
    expect(bodies[0].messages[1].content.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/'))).toBe(true)
    const report = await readFile(join(runDir, 'report.json'), 'utf8')
    expect(report).not.toContain('sk-mcp-test-key')
    expect(lease.held.size).toBe(0)
    await client.close()
    await flow.server.close()
  })

  it('keeps a lease this process claimed before the run', async () => {
    stubGateway([{ type: 'done', success: true, result: {} }])
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device: fakeDevice().device, adbx: fakeAdbx() as never, lease })
    const client = await connect(flow)
    await client.callTool({ name: 'device_claim', arguments: { serial: SERIAL, holder: 'tk-shop-erp' } })
    const result = textOf(await client.callTool({ name: 'vision_agent_run', arguments: { serial: SERIAL, goal: 'g', run_dir: join(dir, 'r2') } }))
    expect(result.status).toBe('done')
    expect(lease.held.get(SERIAL)).toMatchObject({ holder: 'tk-shop-erp' })
    await client.close()
    await flow.server.close()
  })

  it('refuses a device leased by another process and a serial outside the lock', async () => {
    stubGateway([])
    const lease = fakeLease()
    lease.held.set(SERIAL, { serial: SERIAL, holder: 'other', pid: process.pid + 1, acquiredAt: Date.now() })
    const flow = createFlowMcpServer({ device: fakeDevice().device, adbx: fakeAdbx() as never, lease })
    const client = await connect(flow)
    const busy = await client.callTool({ name: 'vision_agent_run', arguments: { serial: SERIAL, goal: 'g', run_dir: join(dir, 'r3') } })
    expect(busy.isError).toBe(true)
    expect(String((busy.content as any)[0].text)).toMatch(/leased by other/)
    await client.close()
    await flow.server.close()

    const locked = createFlowMcpServer({ device: fakeDevice().device, adbx: fakeAdbx() as never, lease: fakeLease(), lockedSerial: SERIAL })
    const lockedClient = await connect(locked)
    const refused = await lockedClient.callTool({ name: 'vision_agent_run', arguments: { serial: 'other-serial', goal: 'g' } })
    expect(String((refused.content as any)[0].text)).toMatch(/SERIAL_LOCKED/)
    await lockedClient.close()
    await locked.server.close()
  })
})

describe('flow_run lease reuse', () => {
  it('is not blocked by this process\'s own device_claim and keeps the claim afterwards', async () => {
    process.env.FLOW_SCRIPTS_DIR = dir
    process.env.FLOW_REPORTS_DIR = join(dir, 'reports')
    await writeFile(join(dir, 'tap.flow.yaml'), ['version: 1', 'name: tap', 'vars: {}', 'steps:', '  - id: s1', '    do: tap', '    target:', '      - point: [0.5, 0.5]'].join('\n'), 'utf8')
    const lease = fakeLease()
    const flow = createFlowMcpServer({ device: fakeDevice().device, lease, defaultSerial: SERIAL })
    const client = await connect(flow)
    await client.callTool({ name: 'device_claim', arguments: { serial: SERIAL, holder: 'agent' } })
    const ran = textOf(await client.callTool({ name: 'flow_run', arguments: { serial: SERIAL, path: 'tap' } }))
    expect(ran.report.status).toBe('completed')
    expect(lease.held.get(SERIAL)).toMatchObject({ holder: 'agent' })
    const again = textOf(await client.callTool({ name: 'flow_run', arguments: { serial: SERIAL, path: 'tap' } }))
    expect(again.report.status).toBe('completed')
    await client.callTool({ name: 'device_release', arguments: { serial: SERIAL } })
    const unclaimed = textOf(await client.callTool({ name: 'flow_run', arguments: { serial: SERIAL, path: 'tap' } }))
    expect(unclaimed.report.status).toBe('completed')
    expect(lease.held.size).toBe(0)
    await client.close()
    await flow.server.close()
  })
})

describe('in-process client', () => {
  it('keeps image blocks from the screenshot tool', async () => {
    const flow = createFlowMcpServer({ device: fakeDevice().device, lease: fakeLease(), defaultSerial: SERIAL })
    const mcp = await connectInProcess(flow)
    const shot = await mcp.callTool('screenshot', { serial: SERIAL })
    expect(typeof shot).toBe('object')
    expect(shot).toMatchObject({ images: [{ mimeType: 'image/png' }] })
    expect(typeof await mcp.callTool('get_foreground_app', { serial: SERIAL })).toBe('string')
    expect(mcp.tools.map(tool => tool.name)).toContain('vision_agent_run')
    await mcp.close()
  })
})

describe('visual tools', () => {
  it('visual_locate and visual_check answer about the current screen with one Jev request each', async () => {
    const asked: Array<{ questions: string[], state: string[] }> = []
    const jev = {
      describe: () => ({ model: 'fake-jev', imagesViaFallback: false }),
      async ask(request: { state: Record<string, unknown>, questions: Record<string, { type: string }> }) {
        asked.push({ questions: Object.keys(request.questions), state: Object.keys(request.state) })
        const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, question.type === 'box'
          ? { type: 'box', box: { top: 0.84, bottom: 0.92, left: 0.04, right: 0.18 }, confidence: 0.91 }
          : question.type === 'choice'
            ? { type: 'choice', choice: 'share_sheet', confidence: 0.9, probabilities: { share_sheet: 0.95, other: 0.05 } }
            : { type: 'noul', noul: 0.97 }]))
        return { answers, model: 'fake-jev', usage: { inputTokens: 2300, outputTokens: 30 }, latencyMs: 950, attempts: 1, endpoint: 'primary', images: 1 }
      },
    }
    const flow = createFlowMcpServer({ device: fakeDevice().device, lease: fakeLease(), defaultSerial: SERIAL, jev: jev as never })
    const mcp = await connectInProcess(flow)
    expect(mcp.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['visual_locate', 'visual_check']))
    const located = JSON.parse(await mcp.callTool('visual_locate', { serial: SERIAL, description: 'the Copy link button' }) as string)
    expect(located).toMatchObject({ present: true, confidence: 0.91, ratio: { x: 0.11, y: 0.88 }, jev: { latencyMs: 950 } })
    expect(asked[0]).toEqual({ questions: ['present', 'target'], state: ['screen'] })
    const checked = JSON.parse(await mcp.callTool('visual_check', { serial: SERIAL, questions: { page: { type: 'choice', instructions: 'Which page is `screen`?', criteria: { share_sheet: 'Send to panel', other: 'else' } }, popup: { type: 'noul', instructions: 'Popup?' } }, state: { keyword: 'k' } }) as string)
    expect(checked.answers).toEqual({ page: { choice: 'share_sheet', confidence: 0.9, probabilities: { share_sheet: 0.95, other: 0.05 } }, popup: { noul: 0.97 } })
    expect(asked[1].state).toEqual(['keyword', 'screen'])
    await mcp.close()
  })
})

describe('isEntryModule', () => {
  it('recognises the entry file when launched through a symlink', async () => {
    const real = join(dir, 'agent.mjs')
    await writeFile(real, '')
    const link = join(dir, 'linked.mjs')
    await symlink(real, link)
    expect(isEntryModule(pathToFileURL(real).href, link)).toBe(true)
    expect(isEntryModule(pathToFileURL(real).href, real)).toBe(true)
    expect(isEntryModule(pathToFileURL(real).href, join(dir, 'other.mjs'))).toBe(false)
    expect(isEntryModule(pathToFileURL(real).href, undefined)).toBe(false)
  })
})
