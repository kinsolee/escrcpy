import { describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from '../src/agent.js'
import type { AgentMessage, AgentTool } from '../src/agent.js'

const tools: AgentTool[] = [
  { name: 'device_tap', description: 'tap', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
]

function fetchResponder(responses: Array<{ content?: string | null, toolCalls?: Array<{ id: string, name: string, args: unknown }> }>) {
  let index = 0
  return vi.fn(async () => {
    const next = responses[Math.min(index++, responses.length - 1)]
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: next.content ?? null,
          ...(next.toolCalls
            ? {
                tool_calls: next.toolCalls.map(call => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

const endpoint = { baseUrl: 'http://gw.test/', apiKey: 'k', model: 'm', apiType: 'chat_completions' }

describe('runAgentLoop', () => {
  it('returns the plain answer when the model calls no tools', async () => {
    const fetchImpl = fetchResponder([{ content: '你好,设备已就绪' }])
    const result = await runAgentLoop({
      endpoint, messages: [{ role: 'user', content: 'hi' }], tools, callTool: async () => '', fetchImpl,
    })
    expect(result.text).toBe('你好,设备已就绪')
    expect(result.turns).toBe(1)
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: '你好,设备已就绪' })
  })

  it('executes tool calls and feeds results back until the model answers', async () => {
    const fetchImpl = fetchResponder([
      { toolCalls: [{ id: 'c1', name: 'device_tap', args: { x: 0.5 } }] },
      { content: '已点击屏幕中央' },
    ])
    const callTool = vi.fn(async () => 'ok: tapped')
    const events: string[] = []
    const result = await runAgentLoop({
      endpoint, messages: [{ role: 'user', content: '点屏幕中央' }], tools, callTool, fetchImpl,
      onEvent: (event) => {
        events.push(event.type === 'assistant' ? `assistant:${event.toolCalls.length}` : `tool:${event.ok}`)
      },
    })
    expect(callTool).toHaveBeenCalledWith({ id: 'c1', name: 'device_tap', args: { x: 0.5 } })
    expect(result.text).toBe('已点击屏幕中央')
    expect(result.turns).toBe(2)
    expect(result.messages).toHaveLength(4) // user, assistant(tool_call), tool, assistant
    expect(result.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'ok: tapped' })
    expect(events).toEqual(['assistant:1', 'tool:true', 'assistant:0'])
  })

  it('feeds tool errors back to the model instead of crashing', async () => {
    const fetchImpl = fetchResponder([
      { toolCalls: [{ id: 'c2', name: 'device_tap', args: {} }] },
      { content: '重试后成功' },
    ])
    const result = await runAgentLoop({
      endpoint, messages: [{ role: 'user', content: 'go' }], tools,
      callTool: async () => {
        throw new Error('device not found')
      },
      fetchImpl,
    })
    expect(result.text).toBe('重试后成功')
    const toolMessage = result.messages.find((message: AgentMessage) => message.role === 'tool')
    expect(toolMessage?.content).toContain('device not found')
  })

  it('reports malformed tool arguments as a tool error', async () => {
    const badFetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'device_tap', arguments: '{not json' } }] } }],
    }), { status: 200 }))
    const fetchImpl = fetchResponder([{ content: '参数已修正' }])
    const combined = async () => (await badFetch()) ?? (await fetchImpl())
    let flip = false
    const alternating = vi.fn(async () => {
      flip = !flip
      return flip ? badFetch() : fetchImpl()
    })
    const result = await runAgentLoop({
      endpoint, messages: [{ role: 'user', content: 'go' }], tools, callTool: async () => 'ok', fetchImpl: alternating as unknown as typeof fetch,
    })
    const toolMessage = result.messages.find(message => message.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(result.text).toBe('参数已修正')
    void combined
  })

  it('throws a clear error for unsupported api types and HTTP failures', async () => {
    await expect(runAgentLoop({
      endpoint: { ...endpoint, apiType: 'messages' }, messages: [], tools, callTool: async () => '', fetchImpl: fetchResponder([{}]),
    })).rejects.toThrow('chat_completions')

    const failing = vi.fn(async () => new Response('{"error":"quota"}', { status: 402 }))
    await expect(runAgentLoop({
      endpoint, messages: [], tools, callTool: async () => '', fetchImpl: failing as unknown as typeof fetch,
    })).rejects.toThrow('LLM 402')
  })

  it('stops at the turn budget while tools keep being requested', async () => {
    const alwaysTool = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 'cx', type: 'function', function: { name: 'device_tap', arguments: '{}' } }] } }],
    }), { status: 200 }))
    const result = await runAgentLoop({
      endpoint, messages: [], tools, callTool: async () => 'ok', fetchImpl: alwaysTool as unknown as typeof fetch, maxTurns: 3,
    })
    expect(result.turns).toBe(3)
    expect(result.text).toBe('')
  })

  it('returns early with the history when the signal aborts mid-loop', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls >= 2)
        controller.abort()
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'device_tap', arguments: '{}' } }] } }],
      }), { status: 200 })
    })
    const result = await runAgentLoop({
      endpoint, messages: [{ role: 'user', content: 'go' }], tools, callTool: async () => 'ok', fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.text).toBe('')
    // The abort fires inside the second fetch, so the c2 tool round completes before the loop notices.
    expect(result.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
  })
})
