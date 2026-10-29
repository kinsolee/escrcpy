import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ReplayDevice, RunReport } from '@escrcpy/flow-core'
import { replayFlow } from '@escrcpy/flow-core'
import type { DeviceLease, LeaseInfo } from '@escrcpy/flow-device'
import { LeaseBusyError } from '@escrcpy/flow-device'
import {
  assignDevices,
  expandFleetManifest,
  FLEET_HOLDER,
  formatRunStamp,
  loadFleetTasks,
  parseFleetManifest,
  runFleet,
} from '../src/fleet.js'
import { HELP, parseCliArgs, runCli } from '../src/index.js'

function flowYaml(name: string, recordedSize?: [number, number]): string {
  return [
    'version: 1',
    `name: ${name}`,
    'vars: {}',
    'defaults: {}',
    'interrupts: []',
    ...(recordedSize ? ['recordedOn:', `  size: [${recordedSize[0]}, ${recordedSize[1]}]`] : []),
    'steps:',
    '  - id: sleep-1',
    '    do: sleep',
    '    with: { duration_ms: 0 }',
    '',
  ].join('\n')
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'flow-fleet-'))
}

async function writeManifest(dir: string, source: string): Promise<string> {
  const manifestPath = join(dir, 'fleet.yaml')
  await writeFile(manifestPath, `${source}\n`, 'utf8')
  return manifestPath
}

function fakeLease(behavior: {
  info?: (serial: string, call: number) => LeaseInfo | undefined
  acquire?: (serial: string, attempt: number) => LeaseBusyError | undefined
} = {}) {
  const state = { infoCalls: [] as string[], acquireCalls: [] as Array<{ serial: string, holder?: string }>, releases: [] as string[] }
  const lease: DeviceLease = {
    async info(serial) {
      state.infoCalls.push(serial)
      return behavior.info?.(serial, state.infoCalls.length)
    },
    async acquire(serial, options) {
      state.acquireCalls.push({ serial, holder: options?.holder })
      const busy = behavior.acquire?.(serial, state.acquireCalls.length)
      if (busy)
        throw busy
      return { serial, holder: options?.holder ?? FLEET_HOLDER, pid: 4242, acquiredAt: 1 }
    },
    async release(serial) {
      state.releases.push(serial)
      return true
    },
    async refresh() {},
    async list() {
      return []
    },
  }
  return { lease, state }
}

function fakeReport(flow: string, serial: string, status: 'completed' | 'failed' = 'completed'): RunReport {
  return { version: 1, flow, serial, status, startedAt: 1, endedAt: 11, durationMs: 10, steps: [], ...(status === 'failed' ? { error: 'boom' } : {}) }
}

function captureConsole() {
  const lines: string[] = []
  const warnings: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(' '))
  })
  return {
    lines,
    warnings,
    restore: () => {
      log.mockRestore()
      error.mockRestore()
    },
  }
}

describe('fleet manifest', () => {
  it('expands the flows × vars matrix in declaration order', () => {
    const manifest = parseFleetManifest([
      'version: 1',
      'flows:',
      '  - flow: a.flow.yaml',
      '    vars:',
      '      - {user: 张三}',
      '      - {user: 李四}',
      '  - flow: b.flow.yaml',
      '  - flow: c.flow.yaml',
      '    vars: []',
      'devices: [serial-a, serial-b]',
    ].join('\n'))
    expect(expandFleetManifest(manifest)).toEqual([
      { flowPath: 'a.flow.yaml', vars: { user: '张三' }, varsIndex: 1 },
      { flowPath: 'a.flow.yaml', vars: { user: '李四' }, varsIndex: 2 },
      { flowPath: 'b.flow.yaml', vars: {}, varsIndex: 1 },
      { flowPath: 'c.flow.yaml', vars: {}, varsIndex: 1 },
    ])
  })

  it('dedupes repeated serials and rejects invalid manifests', () => {
    expect(parseFleetManifest('version: 1\nflows: [{flow: a.yaml}]\ndevices: [s1, s1, s2]').devices).toEqual(['s1', 's2'])
    expect(() => parseFleetManifest('version: 2\nflows: [{flow: a.yaml}]\ndevices: auto')).toThrow('Unsupported fleet manifest version')
    expect(() => parseFleetManifest('version: 1\nflows: []\ndevices: auto')).toThrow('non-empty flows list')
    expect(() => parseFleetManifest('version: 1\nflows: [{flow: a.yaml}]\ndevices: []')).toThrow('devices')
    expect(() => parseFleetManifest('version: 1\nflows: [{flow: a.yaml}]\n')).toThrow('devices')
    expect(() => parseFleetManifest('version: 1\nflows: [{flow: a.yaml, vars: 3}]\ndevices: auto')).toThrow('vars must be a list')
  })

  it('deals tasks round-robin so each device gets an ordered queue', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, [
      'version: 1',
      'flows:',
      '  - flow: a.flow.yaml',
      '    vars:',
      '      - {n: 1}',
      '      - {n: 2}',
      '      - {n: 3}',
      'devices: [serial-a, serial-b]',
    ].join('\n'))
    const manifest = parseFleetManifest(await readFile(manifestPath, 'utf8'))
    const tasks = await loadFleetTasks(manifest, manifestPath)
    const plans = assignDevices(tasks, ['serial-a', 'serial-b'])
    expect(plans.map(plan => plan.serial)).toEqual(['serial-a', 'serial-b'])
    expect(plans[0]!.tasks.map(task => task.varsIndex)).toEqual([1, 3])
    expect(plans[1]!.tasks.map(task => task.varsIndex)).toEqual([2])
  })
})

describe('fleet scheduling', () => {
  it('runs one task at a time per device while devices work in parallel', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, [
      'version: 1',
      'flows:',
      '  - flow: a.flow.yaml',
      '    vars:',
      '      - {n: 1}',
      '      - {n: 2}',
      '      - {n: 3}',
      'devices: [serial-a, serial-b]',
    ].join('\n'))
    const { lease, state } = fakeLease()
    const events: string[] = []
    const inFlight = new Set<string>()
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports'), busyPollMs: 1 }, {
        createLease: () => lease,
        replay: async (flow, options) => {
          if (inFlight.has(options.serial))
            throw new Error(`two tasks ran concurrently on ${options.serial}`)
          inFlight.add(options.serial)
          if (inFlight.size >= 2)
            releaseBarrier()
          // A device's first task may only finish once both devices are mid-task: impossible without cross-device parallelism.
          const won = await Promise.race([barrier.then(() => 'ok' as const), new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 3_000))])
          events.push(`${won}:${options.serial}:${flow.name}:${String(options.vars?.n)}`)
          inFlight.delete(options.serial)
          return fakeReport(flow.name, options.serial)
        },
      })
      expect(events.filter(event => event.startsWith('timeout'))).toEqual([])
      expect(events.filter(event => event.includes(':serial-a:')).map(event => event.slice(-1))).toEqual(['1', '3'])
      expect(events.filter(event => event.includes(':serial-b:')).map(event => event.slice(-1))).toEqual(['2'])
      expect(summary.completed).toBe(3)
      expect(summary.results.map(result => result.status)).toEqual(['completed', 'completed', 'completed'])
      expect(state.acquireCalls).toHaveLength(3)
      expect(state.acquireCalls.every(call => call.holder === FLEET_HOLDER)).toBe(true)
      expect([...state.releases].sort()).toEqual(['serial-a', 'serial-a', 'serial-b'])
      // Same flow + serial in one run must not share a report directory even within the same millisecond.
      const serialAPaths = summary.results.filter(result => result.serial === 'serial-a').map(result => result.reportPath)
      expect(new Set(serialAPaths).size).toBe(2)
    }
    finally {
      captured.restore()
    }
  })

  it('resolves devices: auto from the online device list', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, [
      'version: 1',
      'flows:',
      '  - flow: a.flow.yaml',
      '    vars:',
      '      - {n: 1}',
      '      - {n: 2}',
      '      - {n: 3}',
      'devices: auto',
    ].join('\n'))
    const { lease } = fakeLease()
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        listOnlineSerials: async () => ['emu-1', 'emu-2'],
        replay: async (flow, options) => fakeReport(flow.name, options.serial),
      })
      expect(summary.completed).toBe(3)
      expect(summary.results.map(result => result.serial)).toEqual(['emu-1', 'emu-1', 'emu-2'])
    }
    finally {
      captured.restore()
    }
  })

  it('skips tasks on busy devices, records the holder, and never touches the device', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    const { lease, state } = fakeLease({ info: serial => ({ serial, holder: 'agent-x', pid: 111, acquiredAt: 1 }) })
    let replays = 0
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        replay: async (flow, options) => {
          replays++
          return fakeReport(flow.name, options.serial)
        },
      })
      expect(replays).toBe(0)
      expect(state.acquireCalls).toEqual([])
      expect(state.releases).toEqual([])
      expect(summary.skipped).toBe(1)
      expect(summary.results[0]!.reason).toContain('agent-x')
      expect(summary.results[0]!.reason).toContain('111')
      expect(captured.lines.join('\n')).toContain('skipped')
    }
    finally {
      captured.restore()
    }
  })

  it('waits for a busy device, retrying both the info check and a lost acquire race', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    const { lease, state } = fakeLease({
      info: (serial, call) => (call <= 2 ? { serial, holder: 'agent-x', pid: 111, acquiredAt: 1 } : undefined),
      acquire: (serial, attempt) => (attempt === 1 ? new LeaseBusyError('busy', { serial, holder: 'agent-y', pid: 222, acquiredAt: 1 }) : undefined),
    })
    let sleeps = 0
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports'), onBusy: 'wait', busyPollMs: 1 }, {
        createLease: () => lease,
        sleep: async () => {
          sleeps++
        },
        replay: async (flow, options) => fakeReport(flow.name, options.serial),
      })
      expect(summary.completed).toBe(1)
      expect(summary.results[0]!.status).toBe('completed')
      expect(sleeps).toBeGreaterThanOrEqual(3)
      expect(state.infoCalls).toHaveLength(3)
      expect(state.acquireCalls).toHaveLength(2)
      expect(state.releases).toEqual(['serial-a'])
    }
    finally {
      captured.restore()
    }
  })

  it('isolates task failures and reports them in the summary', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'ok.flow.yaml'), flowYaml('checkout'), 'utf8')
    await writeFile(join(dir, 'bad.flow.yaml'), flowYaml('login'), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: ok.flow.yaml}, {flow: bad.flow.yaml}]\ndevices: [serial-a]')
    const { lease } = fakeLease()
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        replay: async (flow, options) => fakeReport(flow.name, options.serial, flow.name === 'login' ? 'failed' : 'completed'),
      })
      expect(summary.completed).toBe(1)
      expect(summary.failed).toBe(1)
      expect(summary.results[1]!.error).toBe('boom')
      expect(captured.lines.join('\n')).toContain('fleet summary: 2 task(s) — 1 completed, 1 failed, 0 skipped')
    }
    finally {
      captured.restore()
    }
  })
})

describe('fleet reports and warnings', () => {
  it('writes reports under <flowName>/<serial>/<ISO stamp>/report.json using the real replay path', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    const { lease } = fakeLease()
    const reportRoot = join(dir, 'reports')
    expect(formatRunStamp(new Date('2026-10-29T08:09:10.123Z'))).toBe('2026-10-29T08-09-10-123Z')
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot }, {
        createLease: () => lease,
        now: () => new Date('2026-10-29T08:09:10.123Z'),
        // A pure sleep flow exercises replayFlow end to end without ever calling the device.
        replay: (flow, options) => replayFlow(flow, { ...options, device: {} as ReplayDevice }),
      })
      expect(summary.results[0]!.reportPath).toBe(join(reportRoot, 'checkout', 'serial-a', '2026-10-29T08-09-10-123Z', 'report.json'))
      const report = JSON.parse(await readFile(summary.results[0]!.reportPath!, 'utf8'))
      expect(report).toMatchObject({ version: 1, flow: 'checkout', serial: 'serial-a', status: 'completed' })
      expect(report.steps).toHaveLength(1)
    }
    finally {
      captured.restore()
    }
  })

  it('warns but does not fail when recordedOn.size mismatches the device screen', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout', [720, 1600]), 'utf8')
    await writeFile(join(dir, 'b.flow.yaml'), flowYaml('login', [1080, 2400]), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}, {flow: b.flow.yaml}]\ndevices: [serial-a]')
    const { lease } = fakeLease()
    let sizeCalls = 0
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        // checkout (720x1600) mismatches the live screen, login (1080x2400) matches it.
        screenSize: async () => {
          sizeCalls++
          return { width: 1080, height: 2400 }
        },
        replay: async (flow, options) => fakeReport(flow.name, options.serial),
      })
      expect(summary.completed).toBe(2)
      expect(summary.results[0]!.warnings.join('\n')).toContain('720x1600')
      expect(summary.results[0]!.warnings.join('\n')).toContain('1080x2400')
      expect(summary.results[1]!.warnings).toEqual([])
      expect(captured.warnings.filter(line => line.includes('warning:'))).toHaveLength(1)
    }
    finally {
      captured.restore()
    }
  })

  it('ignores screen size probe failures', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout', [720, 1600]), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    const { lease } = fakeLease()
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        screenSize: async () => {
          throw new Error('adb down')
        },
        replay: async (flow, options) => fakeReport(flow.name, options.serial),
      })
      expect(summary.completed).toBe(1)
      expect(summary.results[0]!.warnings).toEqual([])
    }
    finally {
      captured.restore()
    }
  })
})

describe('fleet dry-run and CLI', () => {
  it('dry-run prints the device→task plan without touching devices or leases', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, [
      'version: 1',
      'flows:',
      '  - flow: a.flow.yaml',
      '    vars:',
      '      - {user: 张三}',
      '      - {user: 李四}',
      'devices: [serial-a, serial-b]',
    ].join('\n'))
    const { lease, state } = fakeLease()
    let replays = 0
    const captured = captureConsole()
    try {
      const summary = await runFleet(manifestPath, { dryRun: true, reportRoot: join(dir, 'reports') }, {
        createLease: () => lease,
        replay: async (flow, options) => {
          replays++
          return fakeReport(flow.name, options.serial)
        },
      })
      expect(replays).toBe(0)
      expect(state.infoCalls).toEqual([])
      expect(state.acquireCalls).toEqual([])
      expect(summary.dryRun).toBe(true)
      expect(summary.results).toEqual([])
      const plan = captured.lines.join('\n')
      expect(plan).toContain('2 task(s) across 2 device(s)')
      expect(plan).toContain('serial-a:')
      expect(plan).toContain('1. checkout (vars 1/2) {"user":"张三"}')
      expect(plan).toContain('serial-b:')
      expect(plan).toContain('1. checkout (vars 2/2) {"user":"李四"}')
    }
    finally {
      captured.restore()
    }
  })

  it('lists fleet run in help and parses its options', () => {
    expect(HELP).toContain('fleet run <manifest.yaml>')
    expect(parseCliArgs(['fleet', 'run', 'fleet.yaml', '--dry-run', '--report-root', 'r', '--on-busy', 'wait']).values).toMatchObject({ 'dry-run': true, 'report-root': 'r', 'on-busy': 'wait' })
    expect(parseCliArgs(['fleet', 'run', 'fleet.yaml']).positionals).toEqual(['fleet', 'run', 'fleet.yaml'])
  })

  it('runs fleet run --dry-run through the CLI without adb or leases', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.flow.yaml'), flowYaml('checkout'), 'utf8')
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    const captured = captureConsole()
    try {
      await runCli(['fleet', 'run', manifestPath, '--dry-run'])
      const plan = captured.lines.join('\n')
      expect(plan).toContain('fleet dry-run plan')
      expect(plan).toContain('serial-a:')
      expect(plan).toContain('1. checkout (vars 1/1) {}')
    }
    finally {
      captured.restore()
    }
  })

  it('rejects unknown --on-busy values and missing manifests', async () => {
    const dir = await tempDir()
    const manifestPath = await writeManifest(dir, 'version: 1\nflows: [{flow: a.flow.yaml}]\ndevices: [serial-a]')
    await expect(runCli(['fleet', 'run', manifestPath, '--on-busy', 'queue'])).rejects.toThrow('Unsupported --on-busy')
    await expect(runCli(['fleet', 'run'])).rejects.toThrow('requires a manifest YAML path')
    await expect(runCli(['fleet', 'walk', manifestPath])).rejects.toThrow('Unknown fleet command')
  })
})
