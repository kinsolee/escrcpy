import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { createLlmClient, normalizeLlmApiType } from './heal.js'
import type { HealLlmClient, LlmApiType } from './heal.js'

export const llmModelSchema = z.object({
  id: z.string().min(1, '模型 ID 不能为空'),
  /** Whether the model accepts image input; the UI badges vision-capable rows with it. */
  vision: z.boolean().optional(),
}).passthrough()

export const llmVendorSchema = z.object({
  /** Stable slug referenced by `active`, e.g. `magpie`. */
  id: z.string().min(1, '供应商标识不能为空'),
  /** Cosmetic only; empty is allowed and the UI falls back to an untitled label. */
  name: z.string().optional(),
  baseUrl: z.string().min(1, '供应商 Base URL 不能为空'),
  /** Plain-text key. Prefer `apiKeyEnv` so the key never lands on disk. */
  apiKey: z.string().default(''),
  /** Name of an environment variable holding the key; when it is set and non-empty it wins over `apiKey`. */
  apiKeyEnv: z.string().optional(),
  /** See `normalizeLlmApiType`; defaults to `messages`. */
  apiType: z.string().optional(),
  models: z.array(llmModelSchema).default([]),
}).passthrough()

/**
 * Jev (TypeSafe System One) judgment endpoint. Everything is optional: the
 * default is the local magpie gateway with the magpie vendor's key.
 * Requests with images or Box questions go to the fallback endpoint once the
 * primary answers "Images are not turned on" (a gateway that drops the
 * `TypeSafe-Danger-Zone-Images` header).
 */
export const jevConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().optional(),
  fallbackBaseUrl: z.string().optional(),
  fallbackApiKey: z.string().optional(),
  fallbackApiKeyEnv: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).passthrough()

export const llmConfigSchema = z.object({
  /** `<vendorId>::<modelId>` picked at execution time; empty means healing stays off. */
  active: z.string().optional(),
  vendors: z.array(llmVendorSchema).default([]),
  jev: jevConfigSchema.optional(),
}).passthrough()

export type LlmVendor = z.infer<typeof llmVendorSchema>
export type LlmConfig = z.infer<typeof llmConfigSchema>
export type JevConfig = z.infer<typeof jevConfigSchema>

export function llmConfigPath(explicit?: string): string {
  return explicit ?? process.env.FLOW_LLM_CONFIG ?? join(homedir(), '.escrcpy', 'flow', 'llm.json')
}

const warnedPermissions = new Set<string>()

/** Warns once per file when a config that may hold API keys is readable by group/other. Never prints the key. */
function warnIfShared(file: string): void {
  if (process.platform === 'win32' || warnedPermissions.has(file))
    return
  try {
    const mode = statSync(file).mode & 0o777
    if (mode & 0o077) {
      warnedPermissions.add(file)
      console.warn(`[flow] warning: ${file} is readable by other users (mode ${mode.toString(8)}); it may contain API keys. Run \`chmod 600 ${file}\` or move keys to apiKeyEnv.`)
    }
  }
  catch {
    // A stat failure is not worth blocking the read for.
  }
}

/** Reads the config file; undefined when it does not exist yet. Throws on malformed JSON. */
export function loadLlmConfig(path?: string): LlmConfig | undefined {
  const file = llmConfigPath(path)
  if (!existsSync(file))
    return undefined
  warnIfShared(file)
  const parsed = llmConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.success)
    throw new Error(`invalid LLM config at ${file}: ${parsed.error.issues[0]?.message}`)
  return parsed.data
}

/** Writes the config owner-only (0600): it can hold plain-text API keys. */
export function saveLlmConfig(config: LlmConfig, path?: string): string {
  const file = llmConfigPath(path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // `mode` only applies when the file is created; tighten an existing one too.
  if (process.platform !== 'win32')
    chmodSync(file, 0o600)
  return file
}

/** The vendor's key: the `apiKeyEnv` variable when it is set and non-empty, else the inline `apiKey`. */
export function vendorApiKey(vendor: Pick<LlmVendor, 'apiKey' | 'apiKeyEnv'>, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = vendor.apiKeyEnv ? env[vendor.apiKeyEnv]?.trim() : undefined
  return fromEnv || vendor.apiKey?.trim() || ''
}

/** A fully resolved model endpoint. Holds the key: never log or persist it. */
export interface ResolvedLlmEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  apiType: LlmApiType
  vendorId: string
  /** `vision` flag of the model row; undefined when the model is not listed or not annotated. */
  vision?: boolean
}

/**
 * Resolves `<vendorId>::<modelId>` (default: the config's `active`) to an endpoint.
 * The model does not have to be listed under the vendor: gateways serve more models
 * than the dialog lists. Undefined when the vendor is unknown or has no key.
 */
export function resolveLlmEndpoint(config: LlmConfig | undefined, selector?: string, env: NodeJS.ProcessEnv = process.env): ResolvedLlmEndpoint | undefined {
  const active = selector ?? config?.active
  if (!config || !active)
    return undefined
  const separator = active.indexOf('::')
  if (separator <= 0)
    return undefined
  const vendorId = active.slice(0, separator)
  const model = active.slice(separator + 2).trim()
  const vendor = config.vendors.find(item => item.id === vendorId)
  const apiKey = vendor ? vendorApiKey(vendor, env) : ''
  if (!vendor || !model || !apiKey || !vendor.baseUrl.trim())
    return undefined
  return {
    baseUrl: vendor.baseUrl.trim().replace(/\/+$/, ''),
    apiKey,
    model,
    apiType: normalizeLlmApiType(vendor.apiType),
    vendorId,
    vision: vendor.models.find(item => item.id === model)?.vision,
  }
}

/**
 * Endpoint for agents run from the CLI / MCP: `selector` (`vendor::model`) or the
 * config's `active` from llm.json first; without a usable config entry, the
 * `FLOW_LLM_BASE_URL` / `FLOW_LLM_API_KEY` / `FLOW_LLM_MODEL` / `FLOW_LLM_API_TYPE` env.
 * Throws a message that never contains the key.
 */
export function requireLlmEndpoint(selector?: string, env: NodeJS.ProcessEnv = process.env, configPath?: string): ResolvedLlmEndpoint {
  const config = loadLlmConfig(configPath)
  const fromConfig = resolveLlmEndpoint(config, selector, env)
  if (fromConfig)
    return fromConfig
  if (selector && config?.vendors.some(vendor => vendor.id === selector.split('::')[0]))
    throw new Error(`model ${selector} cannot be used: the vendor has no API key (set apiKey or the env var named by apiKeyEnv)`)
  const baseUrl = env.FLOW_LLM_BASE_URL?.trim()
  const apiKey = env.FLOW_LLM_API_KEY?.trim()
  const model = (selector?.includes('::') ? undefined : selector) ?? env.FLOW_LLM_MODEL?.trim()
  if (baseUrl && apiKey && model)
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, apiType: normalizeLlmApiType(env.FLOW_LLM_API_TYPE), vendorId: 'env' }
  throw new Error(`no usable LLM: ${selector ? `${selector} is not in ${llmConfigPath(configPath)}` : `set an active model in ${llmConfigPath(configPath)}`} (vendor::model), or set FLOW_LLM_BASE_URL, FLOW_LLM_API_KEY and FLOW_LLM_MODEL`)
}

export interface ResolvedLlm {
  client: HealLlmClient
  vendor: LlmVendor
  model: string
}

/** Builds a client for the `active` vendor + model; undefined when nothing usable is selected. */
export function resolveLlm(config: LlmConfig | undefined): ResolvedLlm | undefined {
  const endpoint = resolveLlmEndpoint(config)
  if (!endpoint)
    return undefined
  const vendor = config!.vendors.find(item => item.id === endpoint.vendorId)!
  const client = createLlmClient({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: endpoint.model, apiType: vendor.apiType })
  // `vendor.apiKey` carries the resolved key so callers that spread the vendor into an endpoint keep working with apiKeyEnv.
  return client ? { client, vendor: { ...vendor, apiKey: endpoint.apiKey }, model: endpoint.model } : undefined
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

// ---------------------------------------------------------------------------
// Jev endpoint

export const DEFAULT_JEV_BASE_URL = 'http://127.0.0.1:3425'
export const DEFAULT_JEV_MODEL = 'typesafe-ai/jev'
/** Env var read for the fallback key when the config names none. */
export const DEFAULT_JEV_FALLBACK_KEY_ENV = 'FLOW_JEV_FALLBACK_API_KEY'

/** Resolved Jev endpoints. Holds keys: never log or persist it. */
export interface ResolvedJevSettings {
  /** Undefined when no key is available for the primary endpoint. */
  primary?: { baseUrl: string, apiKey: string }
  /** Used for requests with images / Box questions once the primary refuses them. */
  fallback?: { baseUrl: string, apiKey: string }
  model: string
  timeoutMs?: number
}

const trimUrl = (value: string) => value.trim().replace(/\/+$/, '')

/**
 * Jev endpoints from llm.json's `jev` section and the environment:
 * - base URL: `FLOW_JEV_BASE_URL` > `jev.baseUrl` > magpie (`http://127.0.0.1:3425`);
 * - key: `FLOW_JEV_API_KEY` > env named by `jev.apiKeyEnv` > `jev.apiKey` > the `magpie` vendor's key;
 * - model: `FLOW_JEV_MODEL` > `jev.model` > `typesafe-ai/jev`;
 * - fallback: `FLOW_JEV_FALLBACK_BASE_URL` > `jev.fallbackBaseUrl`, key from the env var named by
 *   `jev.fallbackApiKeyEnv` (default `FLOW_JEV_FALLBACK_API_KEY`) > `jev.fallbackApiKey`.
 */
export function resolveJevSettings(config: LlmConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedJevSettings {
  const jev = config?.jev ?? {}
  const baseUrl = trimUrl(env.FLOW_JEV_BASE_URL?.trim() || jev.baseUrl?.trim() || DEFAULT_JEV_BASE_URL)
  const magpie = config?.vendors.find(vendor => vendor.id === 'magpie')
  const apiKey = env.FLOW_JEV_API_KEY?.trim()
    || (jev.apiKeyEnv ? env[jev.apiKeyEnv]?.trim() : undefined)
    || jev.apiKey?.trim()
    || (magpie ? vendorApiKey(magpie, env) : '')
  const fallbackBaseUrl = env.FLOW_JEV_FALLBACK_BASE_URL?.trim() || jev.fallbackBaseUrl?.trim()
  const fallbackApiKey = env[jev.fallbackApiKeyEnv?.trim() || DEFAULT_JEV_FALLBACK_KEY_ENV]?.trim() || jev.fallbackApiKey?.trim()
  return {
    ...(apiKey ? { primary: { baseUrl, apiKey } } : {}),
    ...(fallbackBaseUrl && fallbackApiKey ? { fallback: { baseUrl: trimUrl(fallbackBaseUrl), apiKey: fallbackApiKey } } : {}),
    model: env.FLOW_JEV_MODEL?.trim() || jev.model?.trim() || DEFAULT_JEV_MODEL,
    ...(jev.timeoutMs ? { timeoutMs: jev.timeoutMs } : {}),
  }
}
