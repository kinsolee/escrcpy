import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import adbkit from '@devicefarmer/adbkit'
import { createAdbx } from '@escrcpy/adbx'
import { createDeviceLease, createFlowDevice, LeaseBusyError } from '@escrcpy/flow-device'
import { loadLlmConfig, parseFlow, readFlow, replayFlow, resolveLlm, toAutomationScript } from '@escrcpy/flow-core'

export function flowScriptsDir() {
  return process.env.FLOW_SCRIPTS_DIR ?? join(homedir(), '.escrcpy', 'flow', 'scripts')
}

export function flowReportsDir() {
  return process.env.FLOW_REPORTS_DIR ?? join(homedir(), '.escrcpy', 'flow', 'reports')
}

/** Flow YAMLs in the scripts dir; unreadable files come back with an error instead of breaking the list. */
export function listFlows() {
  const dir = flowScriptsDir()
  if (!existsSync(dir))
    return []
  return readdirSync(dir)
    // Only flow scripts (*.flow.yaml); patch files (<flow>.flow.yaml.patch-N.yaml) are not flows.
    .filter(file => /\.flow\.ya?ml$/.test(file))
    .map((file) => {
      const path = join(dir, file)
      try {
        const flow = parseFlow(readFileSync(path, 'utf8'))
        return { file, path, name: flow.name, description: flow.description ?? '', vars: Object.keys(flow.vars ?? {}), stepCount: flow.steps.length }
      }
      catch (error) {
        return { file, path, error: error.message }
      }
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** Recent runs across all flows and devices, newest first. */
export function listReports(limit = 20) {
  const root = flowReportsDir()
  if (!existsSync(root))
    return []
  const runs = []
  for (const flowName of readdirSync(root)) {
    const flowDir = join(root, flowName)
    if (!existsSync(flowDir))
      continue
    for (const serial of readdirSync(flowDir)) {
      const serialDir = join(flowDir, serial)
      if (!existsSync(serialDir))
        continue
      for (const ts of readdirSync(serialDir)) {
        const reportPath = join(serialDir, ts, 'report.json')
        if (!existsSync(reportPath))
          continue
        try {
          const report = JSON.parse(readFileSync(reportPath, 'utf8'))
          runs.push({ flow: flowName, serial, ts, status: report.status ?? 'unknown', durationMs: report.durationMs ?? 0, reportPath })
        }
        catch {
          // Unreadable reports are skipped, not fatal.
        }
      }
    }
  }
  return runs.sort((a, b) => b.reportPath.localeCompare(a.reportPath)).slice(0, limit)
}

/**
 * Replay one flow on one device behind the shared cross-process lease.
 * Healing pulls the active model from the shared LLM config when enabled;
 * `healGoal` (boolean, or a number capping exploration actions) additionally
 * runs goal-driven recovery when the run still fails.
 */
export async function runFlowOnDevice({ path: flowPath, serial, vars = {}, heal = false, healGoal = false }) {
  const flow = await readFlow(flowPath)
  const adb = adbkit.Adb.createClient()
  const adbx = createAdbx({ adb, yadbPath: process.env.YADB_PATH ?? '' })
  // app_start/app_stop/shell steps go through adbx.shell; createFlowDevice does not wire it.
  const device = { ...createFlowDevice({ adbx }), shell: (serial_, command) => adbx.shell(serial_, command) }
  const lease = createDeviceLease()
  try {
    await lease.acquire(serial, { holder: 'escrcpy-desktop' })
  }
  catch (error) {
    if (error instanceof LeaseBusyError)
      throw new Error(`device busy: ${serial} is leased by ${error.lease.holder} (pid ${error.lease.pid})`)
    throw error
  }
  const reportDir = join(flowReportsDir(), flow.name, serial, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(reportDir, { recursive: true })
  try {
    const resolved = (heal || healGoal) ? resolveLlm(loadLlmConfig()) : undefined
    const goal = typeof healGoal === 'number' ? { maxActions: healGoal } : true
    const report = await replayFlow(flow, {
      serial,
      device,
      vars,
      flowPath,
      reportDir,
      outputDir: reportDir,
      ...(resolved ? { heal: { client: resolved.client, writePatch: true, ...(healGoal ? { goal } : {}) } } : {}),
    })
    return { report, reportDir }
  }
  finally {
    await lease.release(serial)
  }
}

/** Official Escrcpy Automation JSON for a flow file; selector-only steps are reported as skipped. */
export async function exportOfficialAutomation(flowPath) {
  const flow = await readFlow(flowPath)
  const { script, skipped } = toAutomationScript(flow)
  return { script, skipped }
}

/**
 * One flow across several devices and variable rows: devices run in parallel,
 * rows run sequentially per device, all behind the shared lease. Mirrors the
 * original app's batch dialog (variable table) but multi-device.
 */
export async function runFlowBatch({ path: flowPath, serials, rows, heal = false, healGoal = false, onProgress }) {
  const flow = await readFlow(flowPath)
  const adb = adbkit.Adb.createClient()
  const adbx = createAdbx({ adb, yadbPath: process.env.YADB_PATH ?? '' })
  const device = { ...createFlowDevice({ adbx }), shell: (serial_, command) => adbx.shell(serial_, command) }
  const lease = createDeviceLease()
  const resolved = (heal || healGoal) ? resolveLlm(loadLlmConfig()) : undefined
  const goal = typeof healGoal === 'number' ? { maxActions: healGoal } : true
  const results = []
  const total = serials.length * rows.length
  let done = 0
  const report = (extra) => {
    done++
    onProgress?.({ done, total, ...extra })
  }
  await Promise.all(serials.map(async (serial) => {
    try {
      await lease.acquire(serial, { holder: 'escrcpy-desktop' })
    }
    catch (error) {
      const busy = error instanceof LeaseBusyError
        ? `leased by ${error.lease.holder} (pid ${error.lease.pid})`
        : error.message
      for (const row of rows) {
        results.push({ serial, row, status: 'skipped', error: `device busy: ${busy}` })
        report({ serial, status: 'skipped' })
      }
      return
    }
    try {
      for (const row of rows) {
        const reportDir = join(flowReportsDir(), flow.name, serial, new Date().toISOString().replace(/[:.]/g, '-'))
        mkdirSync(reportDir, { recursive: true })
        try {
          const result = await replayFlow(flow, {
            serial,
            device,
            vars: row,
            flowPath,
            reportDir,
            outputDir: reportDir,
            ...(resolved ? { heal: { client: resolved.client, writePatch: true, ...(healGoal ? { goal } : {}) } } : {}),
          })
          results.push({ serial, row, status: result.status, durationMs: result.durationMs, reportDir })
          report({ serial, status: result.status })
        }
        catch (error) {
          results.push({ serial, row, status: 'failed', error: error.message, reportDir })
          report({ serial, status: 'failed' })
        }
      }
    }
    finally {
      await lease.release(serial)
    }
  }))
  return { results, total }
}
