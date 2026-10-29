import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { createLlmClient, normalizeLlmApiType } from './heal.js'
import type { HealLlmClient } from './heal.js'

export const llmModelSchema = z.object({
  id: z.string().min(1),
  /** Whether the model accepts image input; the UI badges vision-capable rows with it. */
  vision: z.boolean().optional(),
}).passthrough()

export const llmVendorSchema = z.object({
  /** Stable slug referenced by `active`, e.g. `magpie`. */
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  /** See `normalizeLlmApiType`; defaults to `messages`. */
  apiType: z.string().optional(),
  models: z.array(llmModelSchema).default([]),
}).passthrough()

export const llmConfigSchema = z.object({
  /** `<vendorId>::<modelId>` picked at execution time; empty means healing stays off. */
  active: z.string().optional(),
  vendors: z.array(llmVendorSchema).default([]),
}).passthrough()

export type LlmVendor = z.infer<typeof llmVendorSchema>
export type LlmConfig = z.infer<typeof llmConfigSchema>

export function llmConfigPath(explicit?: string): string {
  return explicit ?? process.env.FLOW_LLM_CONFIG ?? join(homedir(), '.escrcpy', 'flow', 'llm.json')
}

/** Reads the config file; undefined when it does not exist yet. Throws on malformed JSON. */
export function loadLlmConfig(path?: string): LlmConfig | undefined {
  const file = llmConfigPath(path)
  if (!existsSync(file))
    return undefined
  const parsed = llmConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success)
    throw new Error(`invalid LLM config at ${file}: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

export function saveLlmConfig(config: LlmConfig, path?: string): string {
  const file = llmConfigPath(path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return file
}

export interface ResolvedLlm {
  client: HealLlmClient
  vendor: LlmVendor
  model: string
}

/** Builds a client for the `active` vendor + model; undefined when nothing usable is selected. */
export function resolveLlm(config: LlmConfig | undefined): ResolvedLlm | undefined {
  if (!config?.active)
    return undefined
  const separator = config.active.indexOf('::')
  if (separator <= 0)
    return undefined
  const vendorId = config.active.slice(0, separator)
  const model = config.active.slice(separator + 2)
  const vendor = config.vendors.find(item => item.id === vendorId)
  if (!vendor)
    return undefined
  const client = createLlmClient({ baseUrl: vendor.baseUrl, apiKey: vendor.apiKey, model, apiType: vendor.apiType })
  return client ? { client, vendor, model } : undefined
}

/** Fetches `/v1/models`; OpenAI- and Anthropic-style gateways both serve this shape. */
export async function listLlmModels(endpoint: { baseUrl: string, apiKey: string, apiType?: string }): Promise<string[]> {
  const baseUrl = endpoint.baseUrl.trim().replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${endpoint.apiKey.trim()}` }
  const url = `${baseUrl}/v1/models`
  let response: Response
  try {
    response = await fetch(url, {
      headers: normalizeLlmApiType(endpoint.apiType) === 'messages'
        ? { ...headers, 'x-api-key': endpoint.apiKey.trim(), 'anthropic-version': '2023-06-01' }
        : headers,
    })
  }
  catch (error) {
    throw new Error(`model list request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`model list returned ${response.status}: ${detail.slice(0, 200)}`)
  }
  const data = (await response.json()) as { data?: Array<{ id?: unknown }> }
  return Array.isArray(data.data)
    ? data.data.map(item => (typeof item.id === 'string' ? item.id : '')).filter(Boolean)
    : []
}
