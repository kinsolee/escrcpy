import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcxMain } from '@escrcpy/electron-ipcx/main'
import { compileTraceFile, loadLlmConfig, resolveLlm, runAgentLoop, writeFlow } from '@escrcpy/flow-core'
import { createInProcessFlowMcp } from '@escrcpy/flow-mcp'
import { yadbPath } from '$electron/configs/extra/index.js'
import { flowScriptsDir } from '../flow/scripts.js'

const COPILOT_SYSTEM = [
  '你是 Escrcpy 的 Android 设备助手(Copilot),通过工具直接控制一台已连接的 Android 设备。',
  '规则:',
  '- 动手前先用 get_screen_state 或 ui_elements 观察屏幕,根据 resource_id / text / content_desc 定位控件。',
  '- 关键操作后按需再观察一次确认结果。',
  '- 用户用中文提问就用中文回答,简明扼要;只报告做了什么和结果,不要罗列原始 JSON。',
  '- 当用户要求"录制 / 做成流程 / 记下来"时:先 flow_record_start(name=简短英文slug, task=用户目标),执行操作,最后 flow_record_stop(outcome=completed)。',
  '- 每个任务用最少的步骤完成,不要做多余的操作。',
].join('\n')

const COPILOT_TRACES_DIR = () => process.env.FLOW_TRACES_DIR ?? join(homedir(), '.escrcpy', 'flow', 'traces')

/** sessionId → { mcp, messages, controller, createdAt, serial } */
const sessions = new Map()

function sessionOrError(sessionId) {
  const session = sessions.get(sessionId)
  if (!session)
    throw new Error('copilot session not found; start a new one')
  return session
}

/** Newest .jsonl trace under the session's trace dir, for save-as-flow. */
function latestTrace(session) {
  const dir = session.traceDir
  if (!existsSync(dir))
    throw new Error('no trace recorded in this session')
  const files = readdirSync(dir).filter(file => file.endsWith('.jsonl')).sort()
  if (!files.length)
    throw new Error('no trace recorded in this session')
  return join(dir, files.at(-1))
}

const handlers = {
  'copilot:start': async (_event, payload) => {
    if (!payload?.serial)
      return { success: false, error: 'serial is required' }
    const sessionId = `copilot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const traceDir = join(COPILOT_TRACES_DIR(), sessionId)
    const mcp = await createInProcessFlowMcp({ defaultSerial: payload.serial, traceDir, yadbPath })
    sessions.set(sessionId, { mcp, traceDir, serial: payload.serial, messages: [], controller: null, createdAt: Date.now() })
    return { success: true, sessionId, toolCount: mcp.tools.length }
  },

  'copilot:chat': async (_event, payload) => {
    if (!payload?.sessionId || !payload?.message)
      return { success: false, error: 'sessionId and message are required' }
    const session = sessionOrError(payload.sessionId)
    if (session.controller)
      return { success: false, error: 'copilot is still working; stop it first' }
    const resolved = resolveLlm(loadLlmConfig())
    if (!resolved)
      return { success: false, error: 'no AI model configured; set one up in Preferences' }
    session.messages.push({ role: 'user', content: payload.message })
    session.controller = new AbortController()
    try {
      const result = await runAgentLoop({
        endpoint: { ...resolved.vendor, model: resolved.model },
        system: COPILOT_SYSTEM,
        messages: session.messages,
        tools: session.mcp.tools,
        callTool: call => session.mcp.callTool(call.name, call.args),
        onEvent: (event) => {
          try {
            payload.onEvent?.(event)
          }
          catch {
            // Renderer went away mid-run; the loop itself should keep going.
          }
        },
        signal: session.controller.signal,
      })
      session.messages = result.messages
      if (result.aborted)
        session.messages.push({ role: 'assistant', content: '⏹ 已停止。' })
      return { success: true, text: result.text, aborted: Boolean(result.aborted), turns: result.turns }
    }
    finally {
      session.controller = null
    }
  },

  'copilot:stop': async (_event, payload) => {
    const session = sessionOrError(payload?.sessionId)
    session.controller?.abort()
    return { success: true }
  },

  'copilot:clear': async (_event, payload) => {
    const session = sessionOrError(payload?.sessionId)
    session.messages = []
    return { success: true }
  },

  'copilot:save-flow': async (_event, payload) => {
    if (!payload?.sessionId)
      return { success: false, error: 'sessionId is required' }
    const session = sessionOrError(payload.sessionId)
    const tracePath = latestTrace(session)
    const { flow, warnings } = await compileTraceFile(tracePath, {
      name: payload.name || undefined,
      description: payload.description || undefined,
    })
    const path = join(flowScriptsDir(), `${flow.name}.flow.yaml`)
    await writeFlow(path, flow)
    return { success: true, path, name: flow.name, steps: flow.steps.length, warnings }
  },
}

export default {
  name: 'module:copilot:service',
  apply() {
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcxMain.handle(channel, async (event, payload) => {
        try {
          return await handler(event, payload)
        }
        catch (error) {
          console.error(`[Copilot Service] ${channel} failed:`, error)
          return { success: false, error: error.message }
        }
      })
    }

    return () => {
      for (const channel of Object.keys(handlers))
        ipcxMain.removeHandler(channel)
      for (const session of sessions.values())
        session.mcp.close().catch(() => {})
      sessions.clear()
    }
  },
}
