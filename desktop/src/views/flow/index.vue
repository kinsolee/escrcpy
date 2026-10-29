<template>
  <div class="h-full mr-3 flex gap-3 overflow-hidden">
    <div class="w-72 flex-none flex flex-col border rounded overflow-hidden">
      <div class="flex items-center gap-1 px-2 py-1.5 border-b">
        <span class="text-sm font-medium flex-1 truncate" :title="scriptsDir">
          {{ $t('flow.page.name') }}
        </span>
        <el-button size="small" text :title="$t('common.refresh')" @click="loadFlows">
          <template #icon>
            <el-icon-refresh />
          </template>
        </el-button>
      </div>
      <div class="flex-1 overflow-auto">
        <div
          v-for="item in flows"
          :key="item.path"
          class="px-2 py-2 cursor-pointer hover:bg-primary-100 dark:hover:bg-primary-900"
          :class="{ 'bg-primary-200 dark:bg-primary-800': item === current }"
          @click="selectFlow(item)"
        >
          <div class="text-sm truncate" :title="item.description || item.name">
            {{ item.name || item.file }}
          </div>
          <div class="text-xs opacity-60 flex gap-2">
            <span>{{ item.stepCount ?? '?' }} {{ $t('flow.page.steps') }}</span>
            <span v-if="item.vars?.length">{{ item.vars.join(', ') }}</span>
          </div>
          <div v-if="item.error" class="text-xs text-danger truncate">
            {{ item.error }}
          </div>
        </div>
        <div v-if="!flows.length" class="p-3 text-sm opacity-60">
          {{ $t('flow.flows.empty') }}
        </div>
      </div>
      <div class="px-2 py-1.5 border-t text-xs opacity-60 truncate" :title="scriptsDir">
        {{ scriptsDir }}
      </div>
    </div>

    <div class="flex-1 min-w-0 flex flex-col gap-3 overflow-auto">
      <template v-if="current">
        <div class="border rounded p-3 flex flex-col gap-2">
          <div class="text-sm opacity-80">
            {{ current.description || current.name }}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <el-select v-model="serial" :placeholder="$t('flow.run.device')" size="small" class="w-56">
              <el-option
                v-for="device in devices"
                :key="device.id"
                :label="`${device.name || device.id} (${device.id})`"
                :value="device.id"
              />
            </el-select>
            <el-switch
              v-model="heal"
              :active-text="$t('flow.run.heal')"
              size="small"
            />
            <div class="flex-1" />
            <el-button size="small" :loading="running" :disabled="!serial" @click="runFlow">
              {{ running ? $t('flow.run.running') : $t('flow.run.name') }}
            </el-button>
            <el-button size="small" plain @click="exportOfficial">
              {{ $t('flow.export.name') }}
            </el-button>
          </div>
          <div v-if="current.vars?.length" class="flex flex-wrap gap-2">
            <el-input
              v-for="name in current.vars"
              :key="name"
              v-model="vars[name]"
              :placeholder="name"
              size="small"
              class="w-44"
            />
          </div>
        </div>

        <div v-if="report" class="border rounded p-3 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-sm">
            <el-tag :type="report.status === 'completed' ? 'success' : 'danger'" size="small">
              {{ report.status }}
            </el-tag>
            <span class="opacity-60">{{ report.durationMs }}ms</span>
            <span class="flex-1 truncate text-xs opacity-60" :title="reportDir">
              {{ reportDir }}
            </span>
          </div>
          <el-table :data="report.steps" size="small" border>
            <el-table-column prop="id" label="ID" min-width="120" />
            <el-table-column prop="status" :label="$t('flow.steps.status')" width="90" />
            <el-table-column :label="$t('flow.steps.healed')" width="70">
              <template #default="{ row }">
                {{ row.healed ? $t('common.yes') : '' }}
              </template>
            </el-table-column>
            <el-table-column prop="durationMs" :label="$t('flow.steps.duration')" width="90" />
            <el-table-column prop="error" :label="$t('flow.steps.error')" min-width="180" show-overflow-tooltip />
          </el-table>
        </div>

        <div class="border rounded p-3 flex flex-col gap-2">
          <div class="text-sm font-medium">
            {{ $t('flow.run.reports') }}
          </div>
          <div
            v-for="item in reports"
            :key="item.reportPath"
            class="text-xs flex gap-2 items-center"
          >
            <el-tag :type="item.status === 'completed' ? 'success' : 'danger'" size="small">
              {{ item.status }}
            </el-tag>
            <span class="opacity-80 truncate">{{ item.flow }} · {{ item.serial }} · {{ item.durationMs }}ms</span>
            <span class="flex-1" />
            <span class="opacity-50 truncate" :title="item.reportPath">
              {{ item.reportPath }}
            </span>
          </div>
          <div v-if="!reports.length" class="text-xs opacity-60">
            {{ $t('flow.reports.empty') }}
          </div>
        </div>
      </template>

      <div v-else class="flex-1 flex items-center justify-center text-sm opacity-60">
        {{ $t('flow.flows.selectHint') }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ElMessage } from 'element-plus'

const deviceStore = useDeviceStore()

const flows = ref([])
const reports = ref([])
const scriptsDir = ref('')
const current = ref(null)
const serial = ref('')
const heal = ref(false)
const vars = ref({})
const running = ref(false)
const report = ref(null)
const reportDir = ref('')

const devices = computed(() => deviceStore.list.filter(device => device.status === 'device'))

function invoke(channel, payload) {
  return window.$preload.ipcxRenderer.invoke(channel, payload)
}

async function loadFlows() {
  const { success, dir, flows: list, error } = await invoke('flow:list')
  if (!success) {
    ElMessage.error(error)
    return
  }
  scriptsDir.value = dir
  flows.value = list
  if (!current.value && list.length)
    selectFlow(list[0])
}

async function loadReports() {
  const { success, reports: list } = await invoke('flow:reports')
  if (success)
    reports.value = list
}

function selectFlow(item) {
  if (item.error)
    return
  current.value = item
  vars.value = Object.fromEntries((item.vars ?? []).map(name => [name, '']))
  report.value = null
}

async function runFlow() {
  if (!current.value || !serial.value)
    return

  running.value = true
  try {
    const { success, report: result, reportDir: dir, error } = await invoke('flow:run', {
      path: current.value.path,
      serial: serial.value,
      vars: Object.fromEntries(Object.entries(vars.value).filter(([, value]) => value !== '')),
      heal: heal.value,
    })
    if (error) {
      ElMessage.error(error)
      return
    }
    report.value = result
    reportDir.value = dir
    if (!success)
      ElMessage.warning(window.t('flow.run.failed'))
    loadReports()
  }
  finally {
    running.value = false
  }
}

async function exportOfficial() {
  if (!current.value)
    return

  const { success, path, skipped, canceled, error } = await invoke('flow:export', { path: current.value.path })
  if (canceled)
    return
  if (!success) {
    ElMessage.error(error)
    return
  }
  ElMessage.success(window.t('flow.export.done', {
    path,
    skipped: skipped?.length ? window.t('flow.export.skipped', { steps: skipped.join(', ') }) : '',
  }))
}

onMounted(() => {
  deviceStore.getList()
  loadFlows()
  loadReports()
})
</script>
