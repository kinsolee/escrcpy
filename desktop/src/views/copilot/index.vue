<template>
  <div class="h-full mr-3 flex flex-col gap-3 overflow-hidden">
    <div class="flex-none flex flex-wrap items-center gap-2 border rounded p-3">
      <el-select
        v-model="serial"
        :placeholder="$t('flow.run.device')"
        size="small"
        class="w-56"
        :disabled="busy"
        @change="startSession"
      >
        <el-option
          v-for="device in devices"
          :key="device.id"
          :label="`${device.name || device.id} (${device.id})`"
          :value="device.id"
        />
      </el-select>
      <template v-if="sessionId">
        <el-tag size="small" type="success">
          {{ $t('copilot.tools', { count: toolCount }) }}
        </el-tag>
        <el-button v-if="busy" size="small" type="warning" plain @click="stopChat">
          {{ $t('copilot.stop') }}
        </el-button>
        <el-button size="small" text @click="clearChat">
          {{ $t('copilot.clear') }}
        </el-button>
        <div class="flex-1" />
        <el-button size="small" plain @click="openAgentDialog">
          {{ $t('copilot.agent.name') }}
        </el-button>
        <el-button size="small" type="primary" plain :disabled="busy" @click="saveAsFlow">
          {{ $t('copilot.saveFlow') }}
        </el-button>
      </template>
      <div v-else class="text-xs opacity-60">
        {{ $t('copilot.empty') }}
      </div>
    </div>

    <div ref="listEl" class="flex-1 min-h-0 overflow-auto flex flex-col gap-2 pr-1">
      <template v-for="(item, index) in chat" :key="index">
        <div
          v-if="item.kind === 'user'"
          class="self-end max-w-[75%] bg-primary-100 dark:bg-primary-900 rounded px-3 py-2 text-sm whitespace-pre-wrap break-words"
        >
          {{ item.text }}
        </div>
        <div v-else class="self-start max-w-[85%] flex flex-col gap-1">
          <div
            v-if="item.text"
            class="border rounded px-3 py-2 text-sm whitespace-pre-wrap break-words"
          >
            {{ item.text }}
          </div>
          <div
            v-for="(tool, toolIndex) in item.tools"
            :key="toolIndex"
            class="border rounded px-2 py-1 text-xs flex gap-2 items-center"
          >
            <el-tag size="small" :type="tool.ok == null ? 'info' : (tool.ok ? 'success' : 'danger')">
              {{ tool.name }}
            </el-tag>
            <span v-if="tool.durationMs != null" class="opacity-50 flex-none">{{ tool.durationMs }}ms</span>
            <span class="truncate flex-1 opacity-60" :title="tool.content">{{ tool.content }}</span>
          </div>
        </div>
      </template>
    </div>

    <div class="flex-none flex gap-2 items-end">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        :placeholder="$t('copilot.placeholder')"
        :disabled="!sessionId || busy"
        @keydown.enter.exact.prevent="send"
      />
      <el-button
        type="primary"
        class="h-[54px]"
        :loading="busy"
        :disabled="!sessionId || !draft.trim()"
        @click="send"
      >
        {{ busy ? $t('copilot.working') : $t('copilot.send') }}
      </el-button>
    </div>

    <el-dialog v-model="agentDialog" :title="$t('copilot.agent.name')" width="680">
      <div class="flex flex-col gap-3 text-sm">
        <div class="opacity-70">
          {{ $t('copilot.agent.desc') }}
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="opacity-60 flex-none">{{ $t('copilot.agent.serverPath') }}</span>
          <el-tag size="small" :type="mcpInfo.exists ? 'success' : 'danger'">
            {{ mcpInfo.exists ? $t('copilot.agent.ready') : $t('copilot.agent.missing') }}
          </el-tag>
          <span class="truncate opacity-60" :title="mcpInfo.serverPath">{{ mcpInfo.serverPath }}</span>
        </div>
        <div v-for="block in agentBlocks" :key="block.label" class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium">{{ block.label }}</span>
            <div class="flex-1" />
            <el-button size="small" text @click="copyText(block.text)">
              {{ $t('copilot.agent.copy') }}
            </el-button>
          </div>
          <pre class="m-0 p-2 border rounded text-xs leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap break-all bg-primary-50 dark:bg-primary-900">{{ block.text }}</pre>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ElMessage, ElMessageBox } from 'element-plus'

const deviceStore = useDeviceStore()

const serial = ref('')
const sessionId = ref('')
const toolCount = ref(0)
const chat = ref([])
const draft = ref('')
const busy = ref(false)
const listEl = ref(null)

const devices = computed(() => deviceStore.list.filter(device => device.status === 'device'))

function invoke(channel, payload) {
  return window.$preload.ipcxRenderer.invoke(channel, payload)
}

watch(chat, () => {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
}, { deep: true })

/** Each session is bound to one device, so switching devices closes the old one first. */
async function closeSession() {
  const id = sessionId.value
  if (!id)
    return
  sessionId.value = ''
  toolCount.value = 0
  chat.value = []
  await invoke('copilot:close', { sessionId: id })
}

async function startSession() {
  await closeSession()
  if (!serial.value)
    return
  const { success, sessionId: id, toolCount: tools, error } = await invoke('copilot:start', { serial: serial.value })
  if (!success) {
    ElMessage.error(error)
    return
  }
  sessionId.value = id
  toolCount.value = tools
  chat.value = []
}

function onAgentEvent(event) {
  if (event.type === 'assistant') {
    chat.value.push({
      kind: 'assistant',
      text: event.text,
      tools: event.toolCalls.map(call => ({ name: call.name, args: call.args, ok: null, content: '', durationMs: null })),
    })
  }
  else if (event.type === 'tool_result') {
    const assistant = [...chat.value].reverse().find(item => item.kind === 'assistant')
    const tool = assistant?.tools.find(entry => entry.ok == null && entry.name === event.call.name)
    if (tool) {
      tool.ok = event.ok
      tool.content = event.content
      tool.durationMs = event.durationMs
    }
  }
}

async function send() {
  const message = draft.value.trim()
  if (!message || !sessionId.value || busy.value)
    return

  chat.value.push({ kind: 'user', text: message })
  draft.value = ''
  busy.value = true
  try {
    const { success, error } = await invoke('copilot:chat', {
      sessionId: sessionId.value,
      message,
      onEvent: onAgentEvent,
    })
    if (!success)
      ElMessage.error(error)
  }
  finally {
    busy.value = false
  }
}

async function stopChat() {
  const { success, error } = await invoke('copilot:stop', { sessionId: sessionId.value })
  if (!success)
    ElMessage.error(error)
}

async function clearChat() {
  chat.value = []
  await invoke('copilot:clear', { sessionId: sessionId.value })
}

/** Hand the bundled flow MCP server to external agents (Claude Code, etc.). */
const agentDialog = ref(false)
const mcpInfo = ref({ serverPath: '', exists: false })

const agentBlocks = computed(() => {
  const path = mcpInfo.value.serverPath
  if (!path)
    return []
  const json = JSON.stringify({ mcpServers: { 'escrcpy-flow': { command: 'node', args: [path] } } }, null, 2)
  return [
    {
      label: window.t('copilot.agent.cli'),
      text: `claude mcp add escrcpy-flow -- node "${path}"`,
    },
    {
      label: window.t('copilot.agent.json'),
      text: json,
    },
    {
      label: window.t('copilot.agent.prompt'),
      text: window.t('copilot.agent.promptText'),
    },
  ]
})

async function openAgentDialog() {
  const { success, serverPath, exists, error } = await invoke('copilot:mcp-info')
  if (!success) {
    ElMessage.error(error)
    return
  }
  mcpInfo.value = { serverPath, exists }
  agentDialog.value = true
}

async function copyText(text) {
  await navigator.clipboard.writeText(text)
  ElMessage.success(window.t('copilot.agent.copied'))
}

/** Compile the session's newest device trace into a reusable flow script. */
async function saveAsFlow() {
  let name = ''
  try {
    const { value } = await ElMessageBox.prompt(window.t('copilot.savePrompt'), window.t('copilot.saveFlow'), {
      inputPattern: /^[\w-]+$/,
      inputErrorMessage: window.t('copilot.namePattern'),
      confirmButtonText: window.t('common.confirm'),
      cancelButtonText: window.t('common.cancel'),
    })
    name = value?.trim()
  }
  catch {
    return
  }
  const { success, path, steps, error } = await invoke('copilot:save-flow', { sessionId: sessionId.value, name })
  if (!success) {
    ElMessage.error(error)
    return
  }
  ElMessage.success(window.t('copilot.saved', { path, steps }))
}

// A renderer reload would otherwise orphan the session's MCP client in the main process.
useEventListener(window, 'beforeunload', closeSession)

onMounted(() => {
  deviceStore.getList()
})

onBeforeUnmount(closeSession)
</script>

<style lang="postcss" scoped>
</style>
