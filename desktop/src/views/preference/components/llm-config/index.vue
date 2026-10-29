<template>
  <el-dialog
    :model-value="modelValue"
    :title="$t('flow.llm.dialog.title')"
    width="760px"
    :close-on-click-modal="false"
    append-to-body
    destroy-on-close
    class="el-dialog--beautify"
    @update:model-value="value => emit('update:modelValue', value)"
    @open="loadConfig"
  >
    <div v-loading="loading" class="min-h-[360px] flex gap-3">
      <div class="w-44 flex-none flex flex-col border rounded">
        <div class="flex-1 overflow-auto">
          <div
            v-for="vendor in vendors"
            :key="vendor.id"
            class="px-2 py-2 cursor-pointer hover:bg-primary-100 dark:hover:bg-primary-900"
            :class="{ 'bg-primary-200 dark:bg-primary-800': vendor === current }"
            @click="current = vendor"
          >
            <div class="text-sm truncate" :title="vendor.baseUrl">
              {{ vendor.name || vendor.id || $t('flow.llm.vendor.untitled') }}
            </div>
            <div class="text-xs opacity-60 truncate">
              {{ vendor.apiType || 'messages' }}
            </div>
          </div>
        </div>
        <div class="p-2 border-t flex gap-2">
          <el-button size="small" class="flex-1" @click="addVendor">
            {{ $t('flow.llm.vendor.add') }}
          </el-button>
          <el-button size="small" type="danger" plain :disabled="!current" @click="removeVendor">
            {{ $t('common.delete') }}
          </el-button>
        </div>
      </div>

      <div v-if="current" class="flex-1 min-w-0 flex flex-col gap-2">
        <div class="grid grid-cols-2 gap-2">
          <el-form-item :label="$t('flow.llm.vendor.id')" class="!mb-0">
            <el-input v-model="current.id" placeholder="magpie" />
          </el-form-item>
          <el-form-item :label="$t('flow.llm.vendor.name')" class="!mb-0">
            <el-input v-model="current.name" />
          </el-form-item>
          <el-form-item :label="$t('flow.llm.vendor.baseUrl')" class="!mb-0">
            <el-input v-model="current.baseUrl" placeholder="https://api.example.com" />
          </el-form-item>
          <el-form-item :label="$t('flow.llm.vendor.apiKey')" class="!mb-0">
            <el-input v-model="current.apiKey" type="password" show-password />
          </el-form-item>
          <el-form-item :label="$t('flow.llm.vendor.apiType')" class="!mb-0">
            <el-select v-model="current.apiType">
              <el-option
                v-for="(label, value) in API_TYPES"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
          <el-form-item :label="$t('flow.llm.vendor.models')" class="!mb-0">
            <el-button :loading="fetching" @click="fetchModels">
              {{ $t('flow.llm.models.fetch') }}
            </el-button>
          </el-form-item>
        </div>

        <div class="flex-1 min-h-0 border rounded overflow-auto">
          <div
            v-for="model in current.models"
            :key="model.id"
            class="px-2 py-1.5 flex items-center gap-2 border-b last:border-b-0"
          >
            <el-radio
              :model-value="active"
              :value="`${current.id}::${model.id}`"
              @change="active = `${current.id}::${model.id}`"
            >
              {{ model.id }}
            </el-radio>
            <div class="flex-1" />
            <el-tag v-if="active === `${current.id}::${model.id}`" size="small" type="success">
              {{ $t('flow.llm.active.tag') }}
            </el-tag>
            <el-button size="small" plain @click="testModel(model)">
              {{ testing === model.id ? $t('flow.llm.test.testing') : $t('flow.llm.test.name') }}
            </el-button>
            <span v-if="results[model.id]" class="text-xs" :class="results[model.id].success ? 'text-success' : 'text-danger'">
              {{ results[model.id].success
                ? $t('flow.llm.test.ok', { ms: results[model.id].ms })
                : $t('flow.llm.test.fail') }}
            </span>
            <el-button size="small" type="danger" plain circle @click="removeModel(model.id)">
              <template #icon>
                <el-icon-close />
              </template>
            </el-button>
          </div>
          <div v-if="!current.models?.length" class="p-3 text-sm opacity-60">
            {{ $t('flow.llm.models.empty') }}
          </div>
        </div>

        <div class="flex gap-2">
          <el-input
            v-model="manualModel"
            :placeholder="$t('flow.llm.models.manual')"
            size="small"
            @keyup.enter="addManualModel"
          />
          <el-button size="small" plain @click="addManualModel">
            {{ $t('common.add') }}
          </el-button>
        </div>
      </div>

      <div v-else class="flex-1 flex items-center justify-center text-sm opacity-60">
        {{ $t('flow.llm.vendor.empty') }}
      </div>
    </div>

    <template #footer>
      <div class="flex items-center">
        <div class="flex-1 text-xs opacity-60 truncate">
          {{ activeLabel }}
        </div>
        <el-button @click="emit('update:modelValue', false)">
          {{ $t('common.cancel') }}
        </el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">
          {{ $t('common.save') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ElMessage } from 'element-plus'

defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue'])

const API_TYPES = {
  messages: 'Anthropic Messages',
  responses: 'OpenAI Responses',
  chat_completions: 'OpenAI Chat Completions',
}

const loading = ref(false)
const saving = ref(false)
const fetching = ref(false)
const testing = ref('')
const vendors = ref([])
const active = ref('')
const current = ref(null)
const manualModel = ref('')
const results = ref({})

const activeLabel = computed(() => {
  if (!active.value)
    return window.t('flow.llm.active.empty')

  const [vendorId, ...rest] = active.value.split('::')

  return window.t('flow.llm.active.label', {
    vendor: vendors.value.find(item => item.id === vendorId)?.name || vendorId,
    model: rest.join('::'),
  })
})

function invoke(channel, payload) {
  return window.$preload.ipcxRenderer.invoke(channel, payload)
}

async function loadConfig() {
  loading.value = true
  try {
    const { success, config, error } = await invoke('flow:llm-config-get')
    if (!success) {
      ElMessage.error(error)
      return
    }
    vendors.value = (config?.vendors ?? []).map(vendor => ({ models: [], ...vendor }))
    active.value = config?.active ?? ''
    current.value = vendors.value[0] ?? null
    results.value = {}
  }
  finally {
    loading.value = false
  }
}

function addVendor() {
  const vendor = {
    id: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    apiType: 'chat_completions',
    models: [],
  }
  vendors.value.push(vendor)
  current.value = vendor
}

function removeVendor() {
  if (!current.value)
    return

  const index = vendors.value.indexOf(current.value)
  vendors.value.splice(index, 1)
  current.value = vendors.value[Math.max(0, index - 1)] ?? null
}

async function fetchModels() {
  const vendor = current.value
  if (!vendor?.baseUrl || !vendor?.apiKey) {
    ElMessage.warning(window.t('flow.llm.vendor.incomplete'))
    return
  }

  fetching.value = true
  try {
    const { success, models, error } = await invoke('flow:llm-models', {
      baseUrl: vendor.baseUrl,
      apiKey: vendor.apiKey,
      apiType: vendor.apiType,
    })
    if (!success) {
      ElMessage.error(error)
      return
    }
    const known = new Set(vendor.models.map(model => model.id))
    vendor.models = models.map(id => ({ id, ...(known.has(id) ? vendor.models.find(model => model.id === id) : {}) }))
  }
  finally {
    fetching.value = false
  }
}

function addManualModel() {
  const id = manualModel.value.trim()
  if (!id || !current.value)
    return

  if (!current.value.models.some(model => model.id === id))
    current.value.models.push({ id })

  manualModel.value = ''
}

function removeModel(id) {
  if (!current.value)
    return

  current.value.models = current.value.models.filter(model => model.id !== id)

  if (active.value === `${current.value.id}::${id}`)
    active.value = ''
}

async function testModel(model) {
  const vendor = current.value
  if (!vendor)
    return

  testing.value = model.id
  try {
    const { success, ms, tool, error } = await invoke('flow:llm-test', {
      baseUrl: vendor.baseUrl,
      apiKey: vendor.apiKey,
      model: model.id,
      apiType: vendor.apiType,
    })
    results.value = {
      ...results.value,
      [model.id]: success ? { success: true, ms } : { success: false, error },
    }
    if (!success)
      ElMessage.error(`${model.id}: ${error}`)
    else if (tool)
      console.debug('[Flow LLM] test decision:', tool)
  }
  finally {
    testing.value = ''
  }
}

async function saveConfig() {
  const payload = {
    active: active.value || undefined,
    vendors: vendors.value
      .filter(vendor => vendor.id?.trim() && vendor.baseUrl?.trim())
      .map(vendor => ({
        ...vendor,
        id: vendor.id.trim(),
        apiKey: vendor.apiKey?.trim() ?? '',
        models: vendor.models.filter(model => model.id?.trim()),
      })),
  }

  saving.value = true
  try {
    const { success, path, error } = await invoke('flow:llm-config-set', payload)
    if (!success) {
      ElMessage.error(error)
      return
    }
    ElMessage.success(window.t('flow.llm.saved', { path }))
    emit('update:modelValue', false)
  }
  finally {
    saving.value = false
  }
}
</script>
