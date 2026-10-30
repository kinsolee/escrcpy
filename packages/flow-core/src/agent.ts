import { normalizeLlmApiType } from './heal.js'

/**
 * Minimal multi-turn tool-calling agent loop for the in-app Copilot chat.
 * Wire format: OpenAI-compatible `chat_completions` with function tools — the
 * format every gateway vendor in llm.json speaks. `messages`/`responses` API
 * types are intentionally rejected until a vendor needs them.
 */

export interface AgentTool {
  name: string
  description?: string
  /** JSON Schema for the tool arguments (MCP inputSchema fits as-is). */
  inputSchema?: Record<string, unknown>
}

export interface AgentToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
  tool_call_id?: string
}

export type AgentEvent
  = | { type: 'assistant', text: string, toolCalls: AgentToolCall[] }
    | { type: 'tool_result', call: AgentToolCall, ok: boolean, content: string, durationMs: number }

export interface AgentLoopOptions {
  endpoint: { baseUrl: string, apiKey: string, model: string, apiType?: string }
  /** Prepended once per request as the system message. */
  system?: string
  /** Conversation history; the loop appends assistant/tool messages to a copy. */
  messages: AgentMessage[]
  tools: AgentTool[]
  /** Executes one tool call and returns the text fed back to the model. */
  callTool: (call: AgentToolCall) => Promise<string>
  onEvent?: (event: AgentEvent) => void
  /** LLM round-trips before the loop gives up. Default 16. */
  maxTurns?: number
  /** Per-request max_tokens. Default 4096. */
  maxTokens?: number
  /** Checked between turns; when aborted the loop returns early with `aborted: true`. */
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface AgentLoopResult {
  messages: AgentMessage[]
  /** Final assistant text (empty when the turn budget ran out mid-tool-loop). */
  text: string
  turns: number
  /** True when the loop returned early because `signal` was aborted. */
  aborted?: boolean
}

/** Back-compat alias for the generic message shape used by copilot callers. */
export type CopilotMessage = AgentMessage

const MAX_TOOL_CONTENT = 8000

function chatUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/v1/chat/completions`
}

function toOpenAiTools(tools: AgentTool[]): Array<{ type: 'function', function: { name: string, description?: string, parameters?: Record<string, unknown> } }> {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
    },
  }))
}

function parseToolCalls(message: { tool_calls?: Array<{ id?: string, function?: { name?: string, arguments?: string } }> }): AgentToolCall[] {
  return (message.tool_calls ?? []).map((call, index) => {
    let args: Record<string, unknown> = {}
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
    }
    catch {
      // Kept empty; the loop feeds the parse error back to the model as the tool result.
    }
    return {
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? '',
      args,
    }
  })
}

async function chatCompletion(options: AgentLoopOptions, messages: AgentMessage[]): Promise<{ content: string | null, toolCalls: AgentToolCall[] }> {
  const { endpoint } = options
  if (normalizeLlmApiType(endpoint.apiType) !== 'chat_completions')
    throw new Error('copilot agent needs an OpenAI-compatible model (apiType chat_completions); pick a different vendor/model in the AI-model dialog')
  const doFetch = options.fetchImpl ?? fetch
  const body = JSON.stringify({
    model: endpoint.model,
    max_tokens: options.maxTokens ?? 4096,
    messages,
    tools: toOpenAiTools(options.tools),
  })
  const response = await doFetch(chatUrl(endpoint.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${endpoint.apiKey}`,
    },
    body,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`LLM ${response.status}: ${detail}`)
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null, tool_calls?: Array<{ id?: string, function?: { name?: string, arguments?: string } }> } }> }
  const message = data.choices?.[0]?.message
  if (!message)
    throw new Error('LLM returned no choices')
  return { content: message.content ?? null, toolCalls: parseToolCalls(message) }
}

/**
 * Drives assistant ⇄ tool turns until the model replies without tool calls
 * or `maxTurns` LLM round-trips are spent. The returned `messages` array is
 * the full history (input + everything generated) so callers can continue
 * the conversation later.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? 16
  const messages: AgentMessage[] = [
    ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
    ...options.messages,
  ]
  let text = ''
  let turn = 0
  while (turn < maxTurns) {
    if (options.signal?.aborted)
      return { messages, text: '', turns: turn, aborted: true }
    turn++
    const { content, toolCalls } = await chatCompletion(options, messages)
    messages.push({
      role: 'assistant',
      ...(content ? { content } : { content: null }),
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map(call => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
        : {}),
    })
    if (!toolCalls.length) {
      text = content ?? ''
      options.onEvent?.({ type: 'assistant', text, toolCalls: [] })
      return { messages, text, turns: turn }
    }
    options.onEvent?.({ type: 'assistant', text: content ?? '', toolCalls })
    for (const call of toolCalls) {
      const started = Date.now()
      let result: string
      let ok = true
      if (!call.name) {
        ok = false
        result = 'error: tool call is missing a name'
      }
      else {
        try {
          result = await options.callTool(call)
        }
        catch (error) {
          ok = false
          result = `error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (result.length > MAX_TOOL_CONTENT)
        result = `${result.slice(0, MAX_TOOL_CONTENT)}\n…(truncated)`
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      options.onEvent?.({ type: 'tool_result', call, ok, content: result, durationMs: Date.now() - started })
    }
  }
  return { messages, text: '', turns: turn }
}
