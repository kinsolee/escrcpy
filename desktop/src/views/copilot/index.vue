<template>
  <div class="h-full mr-3 flex flex-col gap-3 overflow-hidden">
    <div class="flex-none flex flex-wrap items-center gap-2 border rounded p-3">
      <el-select
        v-model="serial"
        :placeholder="$t('flow.run.device')"
        size="small"
        class="w-56"
        :disabled="Boolean(sessionId)"
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

async function startSession() {
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

onMounted(() => {
  deviceStore.getList()
})
</script>

<style lang="postcss" scoped>
</style>
