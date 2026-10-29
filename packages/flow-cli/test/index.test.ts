import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDeviceLease } from '@escrcpy/flow-device'
import { exportFlow, HELP, parseCliArgs, runCli, withDeviceLease } from '../src/index.js'

const trace = [
  {
    type: 'session',
    id: 'tr-cli',
    name: 'settings',
    task: 'Open settings',
    vars: { label: 'Settings' },
    device: { serial: 'fake', width: 1000, height: 2000 },
    startedAt: 1,
  },
  {
    type: 'call',
    seq: 1,
    ts: 2,
    tool: 'ui_tap',
    args: { content_desc: 'Settings' },
    ok: true,
    kind: 'action',
    target: { contentDesc: 'Settings', bounds: [0, 0, 100, 100], ratio: { x: 0.05, y: 0.05 } },
  },
  { type: 'end', outcome: 'completed', endedAt: 3 },
]

async function fakeTraceDir() {
  const dir = await mkdtemp(join(tmpdir(), 'flow-cli-'))
  const tracePath = join(dir, 'trace.jsonl')
  await writeFile(tracePath, `${trace.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  return { dir, tracePath }
}

describe('flow CLI parsing and help', () => {
  it('exposes the M0 and M1/M2 commands in help', () => {
    expect(HELP).toContain('devices')
    expect(HELP).toContain('mcp [--trace-dir <dir>]')
    expect(HELP).toContain('compile <trace.jsonl> -o <flow.yaml>')
    expect(HELP).toContain('run <flow.yaml> -s <serial>')
    expect(HELP).toContain('export <flow.yaml> -o <file>')
  })

  it('parses repeatable vars and subcommand positionals', () => {
    expect(parseCliArgs(['run', 'settings.flow.yaml', '-s', 'emulator', '--var', 'user=Ada', '--var=user=Grace', '--report', 'report.json'])).toEqual({
      values: { serial: 'emulator', var: ['user=Ada', 'user=Grace'], report: 'report.json' },
      positionals: ['run', 'settings.flow.yaml'],
    })
  })
})

describe('flow compile/export commands', () => {
  it('compiles a fake JSONL trace into validated YAML', async () => {
    const { dir, tracePath } = await fakeTraceDir()
    const output = join(dir, 'settings.flow.yaml')
    await runCli(['compile', tracePath, '-o', output, '--annotate'])
    const source = await readFile(output, 'utf8')
    expect(source).toContain('version: 1')
    expect(source).toContain('name: settings')
    expect(source).toContain('do: tap')
  })

  it('exports a fake flow through the CLI command', async () => {
    const { dir } = await fakeTraceDir()
    const flowPath = join(dir, 'settings.flow.yaml')
    const output = join(dir, 'automation.json')
    await writeFile(flowPath, `version: 1\nname: settings\ndescription: Open settings\nvars: {}\ndefaults: {}\ninterrupts: []\nsteps:\n  - id: tap-1\n    do: tap\n    target:\n      - content_desc: Settings\n        exact: true\n`)
    await runCli(['export', flowPath, '-o', output])
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      format: 'escrcpy-automation',
      version: 1,
      name: 'settings',
      description: 'Open settings',
      steps: [{ id: 'tap-1', action: 'tap', target: [{ content_desc: 'Settings', exact: true }] }],
    })
  })

  it('exports the M2 subset as stable automation JSON', () => {
    const exported = exportFlow({
      version: 1,
      name: 'settings',
      description: 'Open settings',
      vars: { user: { required: true } },
      defaults: {},
      interrupts: [],
      steps: [{ id: 'tap-1', do: 'tap', target: [{ content_desc: 'Settings', exact: true }], intent: 'open settings' }],
    })
    expect(exported).toEqual({
      format: 'escrcpy-automation',
      version: 1,
      name: 'settings',
      description: 'Open settings',
      steps: [{ id: 'tap-1', action: 'tap', intent: 'open settings', target: [{ content_desc: 'Settings', exact: true }] }],
    })
  })
})

describe('withDeviceLease', () => {
  it('acquires, releases, and fails fast on a busy device', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-lease-'))
    process.env.FLOW_LEASE_DIR = dir
    process.env.FLOW_AGENT_NAME = 'cli-test'
    try {
      expect(await withDeviceLease('serial-a', {}, async () => 'ran')).toBe('ran')
      expect(await createDeviceLease().info('serial-a')).toBeUndefined()

      const owner = createDeviceLease({ dir })
      await owner.acquire('serial-a', { holder: 'someone-else' })
      await expect(withDeviceLease('serial-a', {}, async () => 'ran')).rejects.toThrow(/device busy.*someone-else/s)
      expect(await withDeviceLease('serial-a', { 'no-lease': true }, async () => 'ran')).toBe('ran')
      await owner.release('serial-a')
    }
    finally {
      delete process.env.FLOW_LEASE_DIR
      delete process.env.FLOW_AGENT_NAME
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('flow heal command', () => {
  const FLOW_LLM_KEYS = ['FLOW_LLM_BASE_URL', 'FLOW_LLM_API_KEY', 'FLOW_LLM_MODEL', 'FLOW_LLM_API_TYPE']
  const healableFlowYaml = `version: 1
name: demo
vars: {}
defaults: {}
interrupts: []
steps:
  - id: open
    do: tap
    target:
      - resource_id: id/missing
    expect:
      visible:
        content_desc: Settings
        exact: true
`

  function withoutLlmEnv(): () => void {
    const saved = Object.fromEntries(FLOW_LLM_KEYS.map(key => [key, process.env[key]]))
    for (const key of FLOW_LLM_KEYS)
      delete process.env[key]
    return () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  }

  async function failedReportDir(): Promise<{ dir: string, flowPath: string, reportPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'flow-cli-heal-'))
    const flowPath = join(dir, 'demo.flow.yaml')
    await writeFile(flowPath, healableFlowYaml, 'utf8')
    const reportPath = join(dir, 'report.json')
    const report = {
      version: 1,
      flow: 'demo',
      serial: 'test',
      status: 'failed',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      flowPath,
      steps: [{ id: 'open', status: 'failed', durationMs: 1, drift: false, interrupts: 0, error: 'Target 1 did not match within 10ms' }],
      error: 'Target 1 did not match within 10ms',
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return { dir, flowPath, reportPath }
  }

  it('exposes the heal command and options in help', () => {
    expect(HELP).toContain('heal <report.json> [--apply]')
    expect(HELP).toContain('--heal')
    expect(HELP).toContain('--apply')
    expect(HELP).toContain('FLOW_LLM_BASE_URL')
  })

  it('fails fast with an env hint when --heal has no FLOW_LLM configuration', async () => {
    const restore = withoutLlmEnv()
    try {
      const { dir, reportPath } = await failedReportDir()
      await expect(runCli(['run', join(dir, 'demo.flow.yaml'), '--heal'])).rejects.toThrow(/FLOW_LLM_BASE_URL, FLOW_LLM_API_KEY and FLOW_LLM_MODEL/)
      await expect(runCli(['heal', reportPath])).rejects.toThrow(/FLOW_LLM_BASE_URL, FLOW_LLM_API_KEY and FLOW_LLM_MODEL/)
    }
    finally {
      restore()
    }
  })

  it('rejects heal requests that have nothing to heal', async () => {
    const restore = withoutLlmEnv()
    try {
      const { dir, reportPath } = await failedReportDir()
      const completed = join(dir, 'completed.json')
      await writeFile(completed, JSON.stringify({ version: 1, flow: 'demo', serial: 'test', status: 'completed', startedAt: 1, endedAt: 2, durationMs: 1, steps: [] }), 'utf8')
      await expect(runCli(['heal', completed])).rejects.toThrow(/nothing to heal: report status is completed/)
      await expect(runCli(['heal', reportPath, '--apply'])).rejects.toThrow(/FLOW_LLM_BASE_URL/)
    }
    finally {
      restore()
    }
  })
})
