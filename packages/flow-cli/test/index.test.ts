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
