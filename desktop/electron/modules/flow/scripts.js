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
    .filter(file => /\.ya?ml$/.test(file))
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
 * Healing pulls the active model from the shared LLM config when enabled.
 */
export async function runFlowOnDevice({ path: flowPath, serial, vars = {}, heal = false }) {
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
    const resolved = heal ? resolveLlm(loadLlmConfig()) : undefined
    const report = await replayFlow(flow, {
      serial,
      device,
      vars,
      flowPath,
      reportDir,
      outputDir: reportDir,
      ...(resolved ? { heal: { client: resolved.client, writePatch: true } } : {}),
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
