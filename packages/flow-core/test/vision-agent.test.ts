import type { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { encodePng, parseUiTree } from '@escrcpy/flow-device'
import type { ForegroundApp, RatioPoint, UiTree } from '@escrcpy/flow-device'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildVisionRequestBody,
  checkTapTarget,
  CONSENT_NEEDS_HUMAN,
  createVisionLlmClient,
  DEFAULT_FORBIDDEN_TEXTS,
  detectConsentInTree,
  isMeaningfulLabel,
  loadLlmConfig,
  matchForbiddenText,
  parseUsage,
  parseVisionDecision,
  resolveLlmEndpoint,
  runVisionAgent,
  saveLlmConfig,
  vendorApiKey,
} from '../src/index.js'
import type { JevClient, VisionAgentDevice, VisionLlmClient, VisionLlmRequest } from '../src/index.js'

const TIKTOK = 'com.zhiliaoapp.musically'
const SERIAL = 'FAKE01'
const W = 1080
const H = 2400

interface FakeNode { text?: string, desc?: string, bounds: [number, number, number, number], clickable?: boolean, children?: FakeNode[] }

function xmlOf(nodes: FakeNode[]): string {
  const render = (node: FakeNode): string => `<node class="android.widget.${node.text ? 'TextView' : 'FrameLayout'}" package="${TIKTOK}" text="${node.text ?? ''}" content-desc="${node.desc ?? ''}" resource-id="" clickable="${node.clickable ? 'true' : 'false'}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]">${(node.children ?? []).map(render).join('')}</node>`
  return `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="${TIKTOK}" text="" content-desc="" resource-id="" clickable="false" bounds="[0,0][${W},${H}]">${nodes.map(render).join('')}</node></hierarchy>`
}

/** Solid-colour 108x240 PNG; distinct colours give clearly different fingerprints. */
function solid(shade: number): Buffer {
  const width = 108
  const height = 240
  const data = new Uint8Array(width * height * 3).fill(shade)
  return encodePng({ width, height, data })
}

const SCREENS = {
  search: { png: solid(30), tree: parseUiTree(xmlOf([
    { text: 'Search', bounds: [100, 100, 900, 200], clickable: true },
    { text: 'Follow', bounds: [800, 400, 1000, 480], clickable: true },
    // A button-sized clickable frame whose child TextView names it; taps on its padding must be checked too.
    { bounds: [100, 600, 400, 700], clickable: true, children: [{ text: 'Add to cart', bounds: [150, 620, 350, 680] }] },
    { bounds: [0, 1200, 540, 2000], clickable: true, children: [{ text: 'Lint remover', bounds: [20, 1800, 500, 1900] }] },
  ])) },
  product: { png: solid(120), tree: parseUiTree(xmlOf([{ text: 'Share', bounds: [900, 100, 1050, 200], clickable: true }])) },
  shopee: { png: solid(200), tree: parseUiTree(xmlOf([])) },
  off: { png: solid(0), tree: parseUiTree(xmlOf([])) },
  consent: { png: solid(70), tree: parseUiTree(xmlOf([
    { text: 'Virtual Items and Rewards Policies update', bounds: [80, 700, 1000, 800] },
    { text: 'By continuing to use TikTok after that date, you agree to these policies.', bounds: [80, 820, 1000, 1200] },
    { text: 'Got it', bounds: [80, 1250, 1000, 1350], clickable: true },
  ])) },
}

type ScreenName = keyof typeof SCREENS

interface FakeDeviceOptions {
  /** Applied after each tap: returns the next screen (or the same one for "no change"). */
  onTap?: (point: RatioPoint, state: { screen: ScreenName, app: string }) => void
  tree?: 'ok' | 'fail' | 'slow'
  clipboard?: string[]
}

function fakeDevice(options: FakeDeviceOptions = {}) {
  const state = { screen: 'search' as ScreenName, app: TIKTOK }
  const calls: Array<{ op: string, args: unknown[] }> = []
  const clipboard = [...(options.clipboard ?? [])]
  const device: VisionAgentDevice = {
    screencap: async () => SCREENS[state.screen].png,
    foregroundApp: async (): Promise<ForegroundApp> => ({ package: state.app, activity: `${state.app}.Main` }),
    uiTree: async (): Promise<UiTree> => {
      if (options.tree === 'fail')
        throw new Error('dump failed')
      if (options.tree === 'slow')
        await new Promise(resolve => setTimeout(resolve, 200))
      return SCREENS[state.screen].tree
    },
    tap: async (_serial, point) => {
      calls.push({ op: 'tap', args: [point] })
      options.onTap?.(point, state)
    },
    longPress: async (_serial, point) => {
      calls.push({ op: 'longPress', args: [point] })
    },
    swipe: async (_serial, from, to) => {
      calls.push({ op: 'swipe', args: [from, to] })
    },
    inputText: async (_serial, text) => {
      calls.push({ op: 'inputText', args: [text] })
    },
    key: async (_serial, key) => {
      calls.push({ op: 'key', args: [key] })
    },
    startApp: async (_serial, pkg) => {
      calls.push({ op: 'startApp', args: [pkg] })
      state.app = pkg
      state.screen = 'search'
    },
    readClipboard: async () => clipboard.shift() ?? '',
    wake: async () => {
      calls.push({ op: 'wake', args: [] })
    },
  }
  return { device, state, calls }
}

type Reply = string | Error | ((request: VisionLlmRequest) => string)

/** Replays scripted model outputs; every call reports 100/20 tokens. */
function fakeClient(replies: Reply[]) {
  const requests: VisionLlmRequest[] = []
  const client: VisionLlmClient = {
    describe: () => ({ baseUrl: 'http://fake', model: 'fake-vision', apiType: 'chat_completions' }),
    async complete(request) {
      requests.push(request)
      const reply = replies.shift()
      if (reply === undefined)
        throw new Error('no scripted reply left')
      if (reply instanceof Error)
        throw reply
      const text = typeof reply === 'function' ? reply(request) : reply
      return { text, usage: { promptTokens: 100, completionTokens: 20 }, latencyMs: 5, attempts: 1 }
    },
  }
  return { client, requests }
}

const act = (action: Record<string, unknown>, thought = 'ok') => JSON.stringify({ thought, action })
const fast = { sleep: async () => {}, settleMs: 0 }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vision-agent-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('runVisionAgent', () => {
  it('completes a goal, collects clipboard evidence and writes a report', async () => {
    const { device, calls } = fakeDevice({
      clipboard: ['old', 'https://www.tiktok.com/view/product/1729384756'],
      onTap: (_point, state) => {
        state.screen = 'product'
      },
    })
    const { client, requests } = fakeClient([
      act({ type: 'tap', element: 3 }, 'open the product card'),
      act({ type: 'read_clipboard' }),
      act({ type: 'done', success: true, result: { links: ['https://www.tiktok.com/view/product/1729384756'], noResults: false }, reason: 'copied' }),
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'get one link', resultSchema: { links: 'string[]', noResults: 'boolean' }, allowedPackages: [TIKTOK], device, client, runDir: dir, ...fast })
    expect(result).toMatchObject({ status: 'done', success: true, steps: 3, modelCalls: 3, tokens: { prompt: 300, completion: 60, total: 360 }, guardrailBlocks: 0 })
    expect(result.result).toEqual({ links: ['https://www.tiktok.com/view/product/1729384756'], noResults: false })
    expect(result.clipboardReads).toEqual(['https://www.tiktok.com/view/product/1729384756'])
    // Element 3 lies inside the product card [0,1200]-[540,2000]; the tap goes to its center.
    expect(requests[0].text).toMatch(/\[3\] [^\n]*"Lint remover"/)
    const tap = calls.find(call => call.op === 'tap')!.args[0] as RatioPoint
    expect(tap.x).toBeCloseTo(260 / 1080, 2)
    expect(tap.y).toBeCloseTo(1850 / 2400, 2)
    // The prompt carried the screenshot, the element list and the result shape.
    expect(requests[0].image?.mimeType).toMatch(/^image\//)
    expect(requests[0].text).toContain('"Lint remover"')
    expect(requests[0].text).toContain('noResults')
    expect(requests[2].text).toContain('clipboard=')
    const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ status: 'done', steps: 3, modelCalls: 3, serial: SERIAL })
    expect(report.stepLog).toHaveLength(3)
    expect(report.stepLog[0]).toMatchObject({ app: { package: TIKTOK }, model: { latencyMs: 5, usage: { promptTokens: 100 } }, action: { type: 'tap', element: 3 } })
    const files = await readdir(dir)
    expect(files.filter(file => file.startsWith('step-'))).toHaveLength(3)
  })

  it('refuses to act in a foreign app, relaunches the allowed one once, then fails on the second escape', async () => {
    const { device, state, calls } = fakeDevice({
      onTap: (_point, s) => {
        s.app = 'com.shopee.br'
        s.screen = 'shopee'
      },
    })
    const { client, requests } = fakeClient([
      act({ type: 'tap', x: 500, y: 150 }),
      act({ type: 'tap', x: 500, y: 150 }),
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, ...fast })
    expect(result.status).toBe('guardrail')
    expect(calls.filter(call => call.op === 'startApp')).toEqual([{ op: 'startApp', args: [TIKTOK] }])
    // Never asked the model about the Shopee screen.
    expect(requests).toHaveLength(2)
    expect(requests[1].text).toContain('com.shopee.br')
    expect(state.app).toBe('com.shopee.br')
  })

  it('does not count cold-start bounces against the recovery budget, and marks the report running with its pid', async () => {
    const { device, state, calls } = fakeDevice({
      onTap: (_point, st) => {
        st.app = 'com.shopee.br'
      },
    })
    state.app = 'com.google.android.apps.nexuslauncher'
    let starts = 0
    device.startApp = async (_serial, pkg) => {
      calls.push({ op: 'startApp', args: [pkg] })
      // The first two launches drop straight back to the launcher (cold start).
      state.app = ++starts <= 2 ? 'com.google.android.apps.nexuslauncher' : pkg
    }
    let midRun: any
    const { client } = fakeClient([
      act({ type: 'tap', x: 500, y: 500 }),
      () => {
        midRun = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'))
        return act({ type: 'done', success: true, result: {} })
      },
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, runDir: dir, ...fast })
    // launch + 2 cold relaunches, then the tap into Shopee still gets its one recovery.
    expect(result.status).toBe('done')
    expect(calls.filter(call => call.op === 'startApp')).toHaveLength(4)
    expect(midRun).toMatchObject({ status: 'running', pid: process.pid })
    expect(midRun.finishedAt).toBeUndefined()
    expect(midRun.updatedAt).toEqual(expect.any(String))
    const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ status: 'done', pid: process.pid, finishedAt: expect.any(String) })
  })

  it('checks the foreground again right before executing', async () => {
    const { device, state, calls } = fakeDevice()
    const { client } = fakeClient([
      () => {
        state.app = 'com.mercadolibre'
        return act({ type: 'tap', x: 500, y: 150 })
      },
      act({ type: 'done', success: false, reason: 'n/a' }),
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, ...fast })
    expect(calls.filter(call => call.op === 'tap')).toHaveLength(0)
    expect(calls.filter(call => call.op === 'startApp')).toHaveLength(1)
    expect(result).toMatchObject({ status: 'failed', guardrailBlocks: 1 })
  })

  it('wakes a dozing screen instead of showing the model a black screenshot', async () => {
    const { device, state, calls } = fakeDevice()
    state.screen = 'off'
    let wakeCalls = 0
    device.wake = async () => {
      calls.push({ op: 'wake', args: [] })
      // The first (start-of-run) wake does not take effect yet; the black-screen check wakes again.
      if (++wakeCalls >= 2)
        state.screen = 'search'
    }
    const { client, requests } = fakeClient([act({ type: 'done', success: true, result: {} })])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, ...fast })
    expect(result).toMatchObject({ status: 'done', modelCalls: 1, steps: 2 })
    expect(calls.filter(call => call.op === 'wake')).toHaveLength(2)
    expect(requests[0].text).toContain('display off')
  })

  it('launches the allowed app at start when something else is in front', async () => {
    const { device, state, calls } = fakeDevice()
    state.app = 'com.google.android.apps.nexuslauncher'
    const { client } = fakeClient([act({ type: 'done', success: true, result: {} })])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, ...fast })
    expect(result.status).toBe('done')
    expect(calls.find(call => call.op !== 'wake')).toEqual({ op: 'startApp', args: [TIKTOK] })
  })

  it('blocks taps on forbidden labels, including a button frame around a forbidden TextView', async () => {
    const { device, calls } = fakeDevice()
    const { client, requests } = fakeClient([
      act({ type: 'tap', element: 1 }),
      act({ type: 'tap', x: 120, y: 260 }),
      act({ type: 'done', success: false, reason: 'blocked' }),
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, runDir: dir, ...fast })
    expect(calls.filter(call => call.op === 'tap')).toHaveLength(0)
    expect(result.guardrailBlocks).toBe(2)
    expect(requests[1].text).toContain('BLOCKED by runtime')
    expect(requests[2].text).toContain('"Add to cart"')
    const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))
    expect(report.stepLog[0].guard).toMatchObject({ blocked: true, term: 'Follow' })
    expect(report.stepLog[1].guard).toMatchObject({ blocked: true, term: 'Add to cart' })
  })

  it('taps without a UI tree but marks them unverifiedTap; a slow dump never blocks the step', async () => {
    for (const tree of ['fail', 'slow'] as const) {
      const { device, calls } = fakeDevice({ tree, onTap: (_p, s) => {
        s.screen = 'product'
      } })
      const { client, requests } = fakeClient([act({ type: 'tap', x: 500, y: 150 }), act({ type: 'done', success: true, result: {} })])
      const started = Date.now()
      const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, treeTimeoutMs: 50, ...fast })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(result).toMatchObject({ status: 'done', unverifiedTaps: 1 })
      expect(calls.filter(call => call.op === 'tap')).toHaveLength(1)
      expect(requests[0].text).toContain('UI tree unavailable')
    }
  })

  it('jev assist: refuses an unverifiable tap that looks like a social / purchase control', async () => {
    const { device, calls } = fakeDevice({ tree: 'fail' })
    const { client } = fakeClient([
      act({ type: 'tap', x: 500, y: 500 }),
      act({ type: 'done', success: true, result: {} }),
    ])
    const asked: string[][] = []
    const jev: JevClient = {
      describe: () => ({ model: 'fake-jev', imagesViaFallback: false }),
      async ask(request) {
        asked.push(Object.keys(request.questions))
        const answers = Object.fromEntries(Object.keys(request.questions).map(name => [name, { type: 'noul', noul: name === 'risky' ? 0.88 : 0.02 }]))
        return { answers: answers as never, model: 'fake-jev', latencyMs: 700, attempts: 1, endpoint: 'primary', images: 1 }
      },
    }
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, jev, ...fast })
    expect(result.status).toBe('done')
    expect(result.guardrailBlocks).toBe(1)
    expect(result.jev).toMatchObject({ visualBlocks: 1, doneRejections: 0 })
    expect(calls.some(call => call.op === 'tap')).toBe(false)
    // Consent check on the whole screen first, then the crop risk check, then the done check.
    expect(asked[0]).toEqual(['consent_dialog'])
    expect(asked[1]).toEqual(['risky'])
    expect(asked[2]).toContain('error_screen')
  })

  it('jev assist: rejects a done whose links were not read from the clipboard, accepts it after read_clipboard', async () => {
    const link = 'https://vt.tiktok.com/ZSabc123/'
    const { device } = fakeDevice({ clipboard: ['old', link] })
    const { client, requests } = fakeClient([
      act({ type: 'done', success: true, result: { links: [link] } }),
      act({ type: 'read_clipboard' }),
      act({ type: 'done', success: true, result: { links: [link] } }),
    ])
    const jev: JevClient = {
      describe: () => ({ model: 'fake-jev', imagesViaFallback: false }),
      async ask(request) {
        const answers = Object.fromEntries(Object.keys(request.questions).map(name => [name, { type: 'noul', noul: 0.03 }]))
        return { answers: answers as never, model: 'fake-jev', latencyMs: 700, attempts: 1, endpoint: 'primary', images: 1 }
      },
    }
    const result = await runVisionAgent({ serial: SERIAL, goal: 'copy a link', allowedPackages: [TIKTOK], device, client, jev, runDir: dir, ...fast })
    expect(result).toMatchObject({ status: 'done', success: true, steps: 3, clipboardReads: [link] })
    expect(result.jev).toMatchObject({ doneRejections: 1 })
    expect(requests[1].text).toContain('rejected your done')
    const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))
    expect(report.stepLog[0].doneCheck).toMatchObject({ ok: false, links: { count: 1, missing: [link] } })
    expect(report.stepLog[2].doneCheck).toMatchObject({ ok: true, answers: { error_screen: { noul: 0.03 } } })
  })

  it('jev assist: rejects noResults when the final screen shows no such message, and fails after three rejections', async () => {
    const { device } = fakeDevice()
    const { client } = fakeClient(Array.from({ length: 3 }, () => act({ type: 'done', success: true, result: { noResults: true } })))
    const jev: JevClient = {
      describe: () => ({ model: 'fake-jev', imagesViaFallback: false }),
      async ask(request) {
        const answers = Object.fromEntries(Object.keys(request.questions).map(name => [name, { type: 'noul', noul: 0.04 }]))
        return { answers: answers as never, model: 'fake-jev', latencyMs: 700, attempts: 1, endpoint: 'primary', images: 1 }
      },
    }
    const result = await runVisionAgent({ serial: SERIAL, goal: 'search', allowedPackages: [TIKTOK], device, client, jev, ...fast })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/rejected 3 times.*noResults/)
  })

  it('consent guard: a policy notice in the UI tree ends the run before the model is asked; nothing is tapped', async () => {
    const { device, state, calls } = fakeDevice()
    state.screen = 'consent'
    const { client, requests } = fakeClient([act({ type: 'tap', element: 2 }, 'only an acknowledgement, tap Got it')])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'close the popup', allowedPackages: [TIKTOK], device, client, runDir: dir, ...fast })
    expect(result.status).toBe('failed')
    expect(result.reason.startsWith(CONSENT_NEEDS_HUMAN)).toBe(true)
    expect(result.consent).toMatchObject({ present: true, source: 'tree', term: 'agree', screenshot: 'step-001.jpg' })
    expect(requests).toHaveLength(0)
    expect(calls.filter(call => call.op === 'tap' || call.op === 'swipe')).toEqual([])
  })

  it('consent guard: a notice seen only by Jev refuses the touch (here the dimmed area) and ends the run', async () => {
    const { device, calls } = fakeDevice({ tree: 'fail' })
    const { client } = fakeClient([act({ type: 'tap', x: 500, y: 150 }, 'tap outside the dialog to dismiss it'), act({ type: 'key', key: 'back' })])
    const jev: JevClient = {
      describe: () => ({ model: 'fake-jev', imagesViaFallback: false }),
      async ask(request) {
        const answers = Object.fromEntries(Object.keys(request.questions).map(name => [name, { type: 'noul', noul: name === 'consent_dialog' ? 0.97 : 0.02 }]))
        return { answers: answers as never, model: 'fake-jev', latencyMs: 600, attempts: 1, endpoint: 'primary', images: 1 }
      },
    }
    const result = await runVisionAgent({ serial: SERIAL, goal: 'close the popup', allowedPackages: [TIKTOK], device, client, jev, ...fast })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/^consent_dialog_needs_human: .*Jev 0\.97/)
    expect(result.consent).toMatchObject({ source: 'jev', probability: 0.97 })
    expect(result.guardrailBlocks).toBe(1)
    expect(calls.filter(call => call.op === 'tap')).toEqual([])
    // The model gets no second try at the notice.
    expect(result.modelCalls).toBe(1)
  })

  it('consent guard: the system prompt tells the model to fail on terms / policy notices', async () => {
    const { device } = fakeDevice()
    const { client, requests } = fakeClient([act({ type: 'fail', reason: 'x' })])
    await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, ...fast })
    expect(requests[0].system).toMatch(/Never accept, agree to or acknowledge terms, policy, privacy or consent notices/)
  })

  it('re-asks once with the parse error, then continues', async () => {
    const { device } = fakeDevice()
    const { client, requests } = fakeClient([
      'I think we should tap search',
      act({ type: 'wait', ms: 10 }),
      act({ type: 'shell', command: 'rm -rf /' }),
      'still not json',
      act({ type: 'done', success: true, result: { ok: 1 } }),
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, runDir: dir, ...fast })
    expect(result).toMatchObject({ status: 'done', modelCalls: 5, steps: 3 })
    expect(requests[1].followUps?.[0].user).toMatch(/could not be used/)
    expect(requests[3].followUps?.[0].user).toMatch(/"shell" is not allowed/)
    const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'))
    expect(report.stepLog[0].model.reask.error).toMatch(/not a JSON object/)
    expect(report.stepLog[1].error).toMatch(/unparseable reply twice/)
  })

  it('ends as stuck after N actions that do not change the screen', async () => {
    const { device } = fakeDevice()
    const { client } = fakeClient(Array.from({ length: 10 }, () => act({ type: 'tap', x: 500, y: 900 })))
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', allowedPackages: [TIKTOK], device, client, stuckThreshold: 3, ...fast })
    expect(result).toMatchObject({ status: 'stuck', modelCalls: 3 })
  })

  it('enforces step, model-call and time budgets', async () => {
    {
      const { device } = fakeDevice()
      const { client } = fakeClient(Array.from({ length: 10 }, () => act({ type: 'wait', ms: 0 })))
      const result = await runVisionAgent({ serial: SERIAL, goal: 'g', device, client, maxSteps: 2, ...fast })
      expect(result).toMatchObject({ status: 'budget_exhausted', steps: 2, modelCalls: 2 })
      expect(result.reason).toMatch(/step budget/)
    }
    {
      const { device } = fakeDevice()
      const { client } = fakeClient(Array.from<string>({ length: 10 }).fill('garbage'))
      const result = await runVisionAgent({ serial: SERIAL, goal: 'g', device, client, maxModelCalls: 3, ...fast })
      expect(result).toMatchObject({ status: 'budget_exhausted', modelCalls: 3 })
      expect(result.reason).toMatch(/model call budget/)
    }
    {
      let clock = 0
      const { device } = fakeDevice()
      const { client } = fakeClient(Array.from({ length: 10 }, () => () => {
        clock += 40_000
        return act({ type: 'wait', ms: 0 })
      }))
      const result = await runVisionAgent({ serial: SERIAL, goal: 'g', device, client, timeBudgetMs: 100_000, now: () => clock, ...fast })
      expect(result).toMatchObject({ status: 'budget_exhausted', modelCalls: 3 })
      expect(result.reason).toMatch(/time budget/)
    }
  })

  it('stops with aborted when the caller aborts', async () => {
    const { device } = fakeDevice()
    const controller = new AbortController()
    const { client } = fakeClient([
      () => {
        controller.abort()
        return act({ type: 'wait', ms: 0 })
      },
    ])
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', device, client, signal: controller.signal, ...fast })
    expect(result.status).toBe('aborted')
  })

  it('never writes the API key into the report, even when the gateway echoes it', async () => {
    const key = 'sk-test-SECRET-123456'
    const fetchImpl = vi.fn(async () => new Response(`bad key ${key}`, { status: 401 })) as unknown as typeof fetch
    const { device } = fakeDevice()
    const result = await runVisionAgent({ serial: SERIAL, goal: 'g', device, endpoint: { baseUrl: 'http://gw', apiKey: key, model: 'm', apiType: 'chat_completions' }, llm: { fetchImpl }, runDir: dir, ...fast })
    expect(result.status).toBe('error')
    const text = await readFile(path.join(dir, 'report.json'), 'utf8')
    expect(text).not.toContain(key)
    expect(text).toContain('***')
    expect(result.reason).not.toContain(key)
  })
})

describe('forbidden texts', () => {
  it('matches whole words for latin scripts and substrings for CJK', () => {
    expect(matchForbiddenText('Follow', DEFAULT_FORBIDDEN_TEXTS)).toBe('Follow')
    expect(matchForbiddenText('Following', DEFAULT_FORBIDDEN_TEXTS)).toBeUndefined()
    expect(matchForbiddenText('Like video. 12K likes', DEFAULT_FORBIDDEN_TEXTS)).toBe('Like')
    expect(matchForbiddenText('ADD TO CART', DEFAULT_FORBIDDEN_TEXTS)).toBe('Add to cart')
    expect(matchForbiddenText('Comprar agora', DEFAULT_FORBIDDEN_TEXTS)).toBe('Comprar')
    expect(matchForbiddenText('Adicionar ao carrinho', DEFAULT_FORBIDDEN_TEXTS)).toBe('Adicionar ao carrinho')
    expect(matchForbiddenText('立即购买 ¥9.9', DEFAULT_FORBIDDEN_TEXTS)).toBe('立即购买')
    expect(matchForbiddenText('Share', DEFAULT_FORBIDDEN_TEXTS)).toBeUndefined()
    expect(matchForbiddenText('Copy link', DEFAULT_FORBIDDEN_TEXTS)).toBeUndefined()
    expect(matchForbiddenText('Search', DEFAULT_FORBIDDEN_TEXTS)).toBeUndefined()
  })

  it('blocks an icon-only control inside a purchase bar (TikTok PDP: unlabeled add-to-cart next to "Buy now") and Chat', () => {
    // Shape of the real SeaPdpActivity bottom bar dumped from TikTok 47.5.3.
    const tree = parseUiTree(xmlOf([{
      bounds: [0, 2158, 1080, 2337],
      children: [
        { bounds: [21, 2201, 121, 2293], clickable: true, children: [{ text: 'Shop', bounds: [30, 2260, 110, 2290] }] },
        { bounds: [126, 2201, 226, 2293], clickable: true, children: [{ text: 'Chat', bounds: [140, 2260, 210, 2290] }] },
        { bounds: [258, 2190, 427, 2305], clickable: true },
        { bounds: [448, 2190, 1059, 2305], clickable: true, children: [{ text: 'Buy now', bounds: [600, 2210, 900, 2250] }] },
      ],
    }]))
    expect(checkTapTarget(tree, { x: 340, y: 2250 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Buy now', grouped: true })
    expect(checkTapTarget(tree, { x: 750, y: 2250 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Buy now' })
    expect(checkTapTarget(tree, { x: 170, y: 2240 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Chat' })
    expect(checkTapTarget(tree, { x: 70, y: 2240 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'ok', labels: ['Shop'] })
  })

  it('sees through a transparent full-screen overlay to the button that receives the tap (TikTok video page)', () => {
    const tree = parseUiTree(xmlOf([
      { bounds: [921, 1325, 1080, 1414], clickable: true, desc: 'Follow creator' },
      { bounds: [912, 1414, 1080, 1572], clickable: true, desc: 'Like video. 3 likes', children: [{ desc: 'Like', bounds: [942, 1414, 1060, 1531] }] },
      { bounds: [0, 1600, 1080, 1700], clickable: true, desc: 'Next video' },
      // Drawn last, covers everything, not clickable: the old topmost-node hit test landed here.
      { bounds: [0, 0, 1080, 2337] },
    ]))
    expect(checkTapTarget(tree, { x: 1000, y: 1370 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Follow' })
    expect(checkTapTarget(tree, { x: 1000, y: 1480 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Like' })
    expect(checkTapTarget(tree, { x: 500, y: 1650 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'ok' })
  })

  it('treats raw resource labels like "@2131823611" as unlabeled and blocks cart controls', () => {
    const tree = parseUiTree(xmlOf([
      { desc: '@2131823611', bounds: [900, 100, 1000, 200], clickable: true },
      { desc: 'Shopping cart', bounds: [700, 100, 800, 200], clickable: true },
      { text: 'Carrinho', bounds: [100, 2200, 300, 2300], clickable: true },
    ]))
    const raw = checkTapTarget(tree, { x: 950, y: 150 }, DEFAULT_FORBIDDEN_TEXTS)
    expect(raw).toMatchObject({ verdict: 'ok', unlabeled: true, labels: [] })
    expect(checkTapTarget(tree, { x: 750, y: 150 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Cart' })
    expect(checkTapTarget(tree, { x: 200, y: 2250 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Carrinho' })
    expect(isMeaningfulLabel('@2131823611')).toBe(false)
    expect(isMeaningfulLabel('123')).toBe(false)
    expect(isMeaningfulLabel('Copy link')).toBe(true)
    expect(isMeaningfulLabel('复制链接')).toBe(true)
  })

  it('blocks explicit consent words on any page, and tells consent notices from ordinary pages', () => {
    const tree = parseUiTree(xmlOf([
      { text: 'I agree', bounds: [100, 100, 400, 200], clickable: true },
      { text: 'Aceitar', bounds: [100, 300, 400, 400], clickable: true },
      { text: '同意', bounds: [100, 500, 400, 600], clickable: true },
      { text: 'Accept all', bounds: [100, 700, 400, 800], clickable: true },
    ]))
    for (const [y, term] of [[150, 'Agree'], [350, 'Aceitar'], [550, '同意'], [750, 'Accept']] as const)
      expect(checkTapTarget(tree, { x: 250, y }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term })
    // Ordinary pages: a return policy line on a product page, a coupon offer: no consent notice.
    const pdp = parseUiTree(xmlOf([{ text: 'Return policy: 30 days', bounds: [0, 1500, 1080, 1600] }, { text: 'Buy now', bounds: [600, 2200, 1000, 2300], clickable: true }, { text: 'Política de privacidade', bounds: [0, 1700, 1080, 1800] }]))
    expect(detectConsentInTree(pdp).present).toBe(false)
    const coupon = parseUiTree(xmlOf([{ text: 'You\'ve got 4 new offers!', bounds: [80, 600, 1000, 700] }, { text: 'Claim all', bounds: [200, 1300, 880, 1400], clickable: true }]))
    expect(detectConsentInTree(coupon).present).toBe(false)
    // A weak term counts once an acknowledge button is there too; a strong phrase counts alone.
    const update = parseUiTree(xmlOf([{ text: 'Atualizamos nossos Termos de Serviço', bounds: [80, 600, 1000, 700] }, { text: 'OK', bounds: [200, 1300, 880, 1400], clickable: true }]))
    expect(detectConsentInTree(update)).toMatchObject({ present: true, term: 'termos' })
    expect(detectConsentInTree(SCREENS.consent.tree)).toMatchObject({ present: true, term: 'agree' })
    expect(detectConsentInTree(parseUiTree(xmlOf([{ text: '继续使用即表示您同意', bounds: [0, 0, 500, 100] }]))).present).toBe(true)
  })

  it('does not look inside large clickable containers', () => {
    const tree = SCREENS.search.tree
    expect(checkTapTarget(tree, { x: 50, y: 1300 }, DEFAULT_FORBIDDEN_TEXTS).verdict).toBe('ok')
    expect(checkTapTarget(tree, { x: 120, y: 610 }, DEFAULT_FORBIDDEN_TEXTS)).toMatchObject({ verdict: 'blocked', term: 'Add to cart' })
    expect(checkTapTarget(undefined, { x: 1, y: 1 }, DEFAULT_FORBIDDEN_TEXTS).verdict).toBe('unverified')
  })
})

describe('parseVisionDecision', () => {
  it('accepts nested, flat, fenced and think-wrapped replies', () => {
    expect(parseVisionDecision('{"thought":"t","action":{"type":"tap","x":1,"y":2}}').action).toEqual({ type: 'tap', x: 1, y: 2 })
    expect(parseVisionDecision('```json\n{"action":"key","key":"BACK"}\n```').action).toEqual({ type: 'key', key: 'back' })
    expect(parseVisionDecision('<think>{maybe}</think> Sure: {"type":"scroll","direction":"down"} done').action).toEqual({ type: 'scroll', direction: 'down' })
    expect(parseVisionDecision('{"action":{"type":"tap","point":[3,4]}}').action).toMatchObject({ x: 3, y: 4 })
    // Seen from gpt-6-astra on the real device: the action type written as the key.
    expect(parseVisionDecision('{"thought":"t","action":{"tap":"element=5"}}').action).toEqual({ type: 'tap', element: 5 })
    expect(parseVisionDecision('{"action":{"tap":"element","element":10}}').action).toEqual({ type: 'tap', element: 10 })
    expect(parseVisionDecision('{"action":{"tap":[300,400]}}').action).toEqual({ type: 'tap', x: 300, y: 400 })
    expect(parseVisionDecision('{"action":{"read_clipboard":{}}}').action).toEqual({ type: 'read_clipboard' })
  })

  it('rejects tools outside the action space and incomplete taps', () => {
    expect(() => parseVisionDecision('{"action":{"type":"open_url","url":"x"}}')).toThrow(/not allowed/)
    expect(() => parseVisionDecision('{"action":{"type":"app_uninstall"}}')).toThrow(/not allowed/)
    expect(() => parseVisionDecision('{"action":{"type":"tap"}}')).toThrow(/needs x and y/)
    expect(() => parseVisionDecision('{"action":{"type":"key","key":"power"}}')).toThrow(/invalid action/)
  })
})

describe('vision LLM client', () => {
  const request: VisionLlmRequest = { system: 'sys', text: 'look', image: { data: 'AAAA', mimeType: 'image/jpeg' } }

  it('sends the screenshot in each wire format', () => {
    const messages = buildVisionRequestBody('messages', 'm', request, 100) as any
    expect(messages.system).toBe('sys')
    expect(messages.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } })
    const chat = buildVisionRequestBody('chat_completions', 'm', request, 100) as any
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(chat.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } })
    const responses = buildVisionRequestBody('responses', 'm', request, 100) as any
    expect(responses.instructions).toBe('sys')
    expect(responses.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' })
  })

  it('parses usage from all three response shapes', () => {
    expect(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } })).toEqual({ promptTokens: 10, completionTokens: 2 })
    expect(parseUsage({ usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 } })).toEqual({ promptTokens: 15, completionTokens: 3 })
    expect(parseUsage({})).toBeUndefined()
  })

  it('times out hung requests and retries 429/5xx with backoff, then reports usage', async () => {
    const delays: number[] = []
    let call = 0
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      call++
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (call === 2)
        return new Response('busy', { status: 429 })
      if (call === 3)
        return new Response('oops', { status: 502 })
      return Response.json({ choices: [{ message: { content: '{"action":{"type":"wait"}}' } }], usage: { prompt_tokens: 1200, completion_tokens: 30 } })
    }) as unknown as typeof fetch
    const client = createVisionLlmClient({ baseUrl: 'http://gw/', apiKey: 'k-123456', model: 'm', apiType: 'chat_completions' }, { fetchImpl, timeoutMs: 30, maxRetries: 3, backoffMs: 10, sleep: async (ms) => {
      delays.push(ms)
    } })
    const response = await client.complete(request)
    expect(response).toMatchObject({ attempts: 4, usage: { promptTokens: 1200, completionTokens: 30 } })
    expect(delays).toEqual([10, 20, 40])
  })

  it('does not retry client errors and gives up after maxRetries', async () => {
    let calls = 0
    const bad = (async () => {
      calls++
      return new Response('nope', { status: 400 })
    }) as unknown as typeof fetch
    await expect(createVisionLlmClient({ baseUrl: 'http://gw', apiKey: 'k-123456', model: 'm' }, { fetchImpl: bad, sleep: async () => {} }).complete(request)).rejects.toThrow(/400/)
    expect(calls).toBe(1)
    calls = 0
    const down = (async () => {
      calls++
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(createVisionLlmClient({ baseUrl: 'http://gw', apiKey: 'k-123456', model: 'm' }, { fetchImpl: down, sleep: async () => {} }).complete(request)).rejects.toThrow(/fetch failed/)
    expect(calls).toBe(3)
  })
})

describe('llm config keys', () => {
  it('prefers apiKeyEnv over the inline key and resolves unlisted models', () => {
    const config = { active: 'gw::listed', vendors: [{ id: 'gw', baseUrl: 'http://gw/', apiKey: 'inline', apiKeyEnv: 'GW_KEY', apiType: 'chat', models: [{ id: 'listed', vision: true }] }] }
    expect(vendorApiKey(config.vendors[0], { GW_KEY: 'from-env' })).toBe('from-env')
    expect(vendorApiKey(config.vendors[0], {})).toBe('inline')
    expect(resolveLlmEndpoint(config, undefined, { GW_KEY: 'from-env' })).toMatchObject({ baseUrl: 'http://gw', apiKey: 'from-env', model: 'listed', apiType: 'chat_completions', vision: true })
    expect(resolveLlmEndpoint(config, 'gw::codex/other', {})).toMatchObject({ model: 'codex/other', apiKey: 'inline' })
    expect(resolveLlmEndpoint({ vendors: [{ ...config.vendors[0], apiKey: '' }] }, 'gw::x', {})).toBeUndefined()
  })

  it('writes the config 0600 and warns once (without the key) when it is group/other readable', async () => {
    const file = path.join(dir, 'llm.json')
    saveLlmConfig({ vendors: [{ id: 'gw', baseUrl: 'http://gw', apiKey: 'sk-very-secret', models: [] }] }, file)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, JSON.stringify({ vendors: [{ id: 'gw', baseUrl: 'http://gw', apiKey: 'sk-very-secret', models: [] }] }), { mode: 0o644 })
    const { chmod } = await import('node:fs/promises')
    await chmod(file, 0o644)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadLlmConfig(file)
    loadLlmConfig(file)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('chmod 600')
    expect(String(warn.mock.calls[0][0])).not.toContain('sk-very-secret')
    warn.mockRestore()
    // Saving again tightens an existing file.
    saveLlmConfig(loadLlmConfig(file)!, file)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})
