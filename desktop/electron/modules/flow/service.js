import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { ipcxMain } from '@escrcpy/electron-ipcx/main'
import { createLlmClient, listLlmModels, llmConfigSchema, loadLlmConfig, saveLlmConfig } from '@escrcpy/flow-core'
import { exportOfficialAutomation, flowReportsDir, flowScriptsDir, listFlows, listReports, runFlowOnDevice } from './scripts.js'

// Kept tiny on purpose: the round-trip proves auth, wire format and JSON-decision
// parsing together, which is exactly what the heal agent depends on.
const TEST_PROMPT = [
  '你是 Android 自动化脚本的自愈助手,这是一次连通性测试。',
  '请只输出一个 JSON 对象,不要输出任何其他内容。',
  '格式示例:{"action":{"tool":"wait_for","target":[{"text":"测试"}]},"reason":"连通性测试"}',
].join('\n')

const handlers = {
  'flow:llm-config-get': async () => {
    const config = loadLlmConfig()
    return { success: true, config: config ?? { vendors: [] } }
  },
  'flow:llm-config-set': async (_event, payload) => {
    const checked = llmConfigSchema.safeParse(payload)
    if (!checked.success)
      return { success: false, error: checked.error.issues[0]?.message ?? 'invalid config' }
    const path = saveLlmConfig(checked.data)
    return { success: true, path }
  },
  'flow:llm-models': async (_event, payload) => {
    const models = await listLlmModels(payload)
    return { success: true, models }
  },
  'flow:llm-test': async (_event, payload) => {
    const client = createLlmClient(payload)
    if (!client)
      return { success: false, error: 'baseUrl / apiKey / model is incomplete' }
    const started = Date.now()
    try {
      const decision = await client.complete(TEST_PROMPT)
      return { success: true, ms: Date.now() - started, tool: decision.action.tool }
    }
    catch (error) {
      return { success: false, ms: Date.now() - started, error: error.message }
    }
  },
  'flow:list': async () => {
    return { success: true, dir: flowScriptsDir(), flows: listFlows() }
  },
  'flow:run': async (_event, payload) => {
    if (!payload?.path || !payload?.serial)
      return { success: false, error: 'path and serial are required' }
    const { report, reportDir } = await runFlowOnDevice(payload)
    return { success: report.status === 'completed', report, reportDir }
  },
  'flow:reports': async () => {
    return { success: true, dir: flowReportsDir(), reports: listReports() }
  },
  'flow:export': async (event, payload) => {
    if (!payload?.path)
      return { success: false, error: 'path is required' }
    const { script, skipped } = await exportOfficialAutomation(payload.path)
    const { canceled, filePath } = await dialog.showSaveDialog(event.sender, {
      defaultPath: `${script.name}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath)
      return { success: false, canceled: true }
    writeFileSync(filePath, `${JSON.stringify(script, null, 2)}\n`, 'utf8')
    return { success: true, path: filePath, skipped }
  },
}

export default {
  name: 'module:flow:service',
  apply() {
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcxMain.handle(channel, async (event, payload) => {
        try {
          return await handler(event, payload)
        }
        catch (error) {
          console.error(`[Flow Service] ${channel} failed:`, error)
          return { success: false, error: error.message }
        }
      })
    }

    return () => {
      for (const channel of Object.keys(handlers))
        ipcxMain.removeHandler(channel)
    }
  },
}
