import { describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { query, type QueryParams } from '../query.js'
import { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } from '../utils/messages.js'
import { resolveAntiRepetitionConfig } from '../services/antiRepetition/config.js'
import type { QueryDeps } from './deps.js'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { enableConfigs } from '../utils/config.js'
import { getModelUsage, getTotalCost } from '../cost-tracker.js'
import { resetCostState } from '../bootstrap/state.js'
import * as modelCost from '../utils/modelCost.js'
import { buildTool } from '../Tool.js'
import { z } from 'zod/v4'

function sse(event: any) {
  return { type: 'stream_event', event } as any
}

function start(id = 'response-1') {
  return sse({ type: 'message_start', message: { id, usage: { input_tokens: 12, output_tokens: 0 } } })
}

function delta(text: string, channel: 'thinking' | 'text' = 'thinking') {
  return sse({ type: 'content_block_delta', index: 0, delta: channel === 'thinking'
    ? { type: 'thinking_delta', thinking: text }
    : { type: 'text_delta', text } })
}

async function* repetition(channel: 'thinking' | 'text' = 'thinking') {
  yield start()
  yield sse({ type: 'content_block_start', index: 0, content_block: channel === 'thinking'
    ? { type: 'thinking', thinking: '', signature: '' }
    : { type: 'text', text: '' } })
  for (let i = 0; i < 1000; i++) yield delta('Let me reconsider. ', channel)
}

function setup(callModel: QueryDeps['callModel'], settings: Record<string, unknown> = {}) {
  const controller = new AbortController()
  const hooks = { stop: 0, post: 0 }
  const state = {
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
    mcp: { tools: [], clients: [], resources: {} },
    tasks: {}, todos: {}, notifications: [], sessionHooks: new Map(),
  }
  const context: any = {
    abortController: controller,
    options: { tools: [], mainLoopModel: 'test-model', thinkingConfig: { type: 'enabled', budgetTokens: 2048 },
      isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    messages: [], readFileState: new Map(),
    getAppState: () => state, setAppState: () => {},
    setInProgressToolUseIDs: () => {}, setHasInterruptibleToolInProgress: () => {},
  }
  const deps: QueryDeps = {
    callModel,
    microcompact: async (messages: any) => ({ messages }) as any,
    autocompact: async () => ({}) as any,
    uuid: randomUUID,
    config: { sessionId: 'test-session' as any, gates: { streamingToolExecution: false, emitToolUseSummaries: false, isAnt: false },
      antiRepetition: resolveAntiRepetitionConfig({ enabled: true, ...settings }) },
    handleStopHooks: async function* () { hooks.stop++; return { preventContinuation: false, blockingErrors: [] } } as any,
    postSamplingHooks: async () => { hooks.post++ },
  }
  const params: QueryParams = { messages: [createUserMessage({ content: 'Complete the original task.' })],
    systemPrompt: [] as any, userContext: {}, systemContext: {}, canUseTool: async () => ({ behavior: 'allow' }) as any,
    toolUseContext: context, querySource: 'sdk', deps }
  return { params, controller, hooks, deps, context }
}

async function drain(generator: ReturnType<typeof query>) {
  const output: any[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { output, terminal: next.value }
    output.push(next.value)
  }
}

describe('AntiRep in the existing Query Loop', () => {
  test('closes the bad stream and continues with only valid history and a meta correction', async () => {
    const requests: any[] = []
    let closed = 0
    let tokensAfterHit = 0
    const { params, hooks } = setup(async function* (args: any) {
      requests.push(args)
      if (requests.length === 1) {
        try {
          yield start()
          yield createAssistantMessage({ content: [{ type: 'thinking', thinking: 'Earlier invalid reasoning', signature: 'bad-signature' }] as any })
          yield* repetition()
          tokensAfterHit++
        } finally { closed++ }
      } else {
        yield createAssistantMessage({ content: 'Task completed.' })
      }
    } as any)
    const { output, terminal } = await drain(query(params))
    expect(closed).toBe(1)
    expect(tokensAfterHit).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests[1].signal.aborted).toBe(false)
    const history = requests[1].messages
    expect(history).toHaveLength(2)
    expect(history[1].type).toBe('user')
    expect(history[1].isMeta).toBe(true)
    expect(JSON.stringify(history)).not.toContain('bad-signature')
    expect(JSON.stringify(history)).not.toContain('Earlier invalid reasoning')
    expect(output.filter(m => m.type === 'tombstone')).toHaveLength(1)
    expect(output.filter(m => m.type === 'stream_reset')).toHaveLength(1)
    expect(hooks).toEqual({ stop: 1, post: 1 })
    expect(terminal.reason).toBe('completed')
  })

  test('real Anthropic SSE wrapper cancels the transport without non-streaming fallback', async () => {
    let fetches = 0
    let canceled = 0
    const wireEvents = [
      { type: 'message_start', message: { id: 'wire-response', type: 'message', role: 'assistant', model: 'test-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      ...Array.from({ length: 1000 }, () => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me reconsider. ' } })),
    ]
    let position = 0
    const transport = async (_url: unknown, options: any) => {
      fetches++
      expect(JSON.parse(options.body).stream).toBe(true)
      return new Response(new ReadableStream({
        pull(controller) {
          const event = wireEvents[position++]
          if (event) controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
          else controller.close()
        },
        cancel() { canceled++ },
      }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'fixture-request' } })
    }
    const { params, controller } = setup(async function* (args: any) {
      yield* queryModelWithStreaming({ ...args, options: { ...args.options, fetchOverride: transport } })
    } as any, { autoResume: false })
    const envNames = ['NODE_ENV', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const
    const previous = envNames.map(key => process.env[key])
    const previousMacro = (globalThis as any).MACRO
    ;(globalThis as any).MACRO = { VERSION: '0.0.0-test', PACKAGE_URL: 'fixture', BUILD_TIME: 'fixture' }
    enableConfigs()
    process.env.NODE_ENV = 'development'
    process.env.ANTHROPIC_API_KEY = 'fixture-only-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-only-token'
    try {
      resetCostState()
      const calculateCost = spyOn(modelCost, 'calculateUSDCost').mockImplementation((_model, usage: any) =>
        (usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0)) / 1_000_000)
      const result = await drain(query(params))
      calculateCost.mockRestore()
      expect(result.terminal.code).toBe('REASONING_LOOP')
      expect(getModelUsage()['test-model']).toMatchObject({ inputTokens: 12, outputTokens: 0 })
      expect(getTotalCost()).toBeGreaterThan(0)
      expect(fetches).toBe(1)
      expect(canceled).toBe(1)
      expect(position).toBeLessThan(100)
      expect(controller.signal.aborted).toBe(false)
      expect(result.output.filter(m => m.type === 'stream_reset')).toHaveLength(1)
    } finally {
      if (previousMacro === undefined) delete (globalThis as any).MACRO
      else (globalThis as any).MACRO = previousMacro
      envNames.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
      })
    }
  })

  test('allows two recoveries, then reports REASONING_LOOP without a fourth request', async () => {
    let calls = 0
    let closed = 0
    const { params, hooks } = setup(async function* () {
      calls++
      try { yield* repetition() } finally { closed++ }
    } as any)
    const { output, terminal } = await drain(query(params))
    expect(calls).toBe(3)
    expect(closed).toBe(3)
    expect(output.filter(m => m.type === 'user' && m.isMeta)).toHaveLength(2)
    expect(output.filter(m => m.type === 'stream_reset').map(m => m.recovering)).toEqual([true, true, false])
    expect(output.at(-1).apiError).toBe('REASONING_LOOP')
    expect(output.at(-1).isApiErrorMessage).toBe(true)
    expect(terminal).toEqual({ reason: 'repetition_loop', code: 'REASONING_LOOP' })
    expect(hooks).toEqual({ stop: 0, post: 0 })
  })

  test('autoResume=false and maxRecoveries=0 each stop after the first hit', async () => {
    for (const settings of [{ autoResume: false }, { maxRecoveries: 0 }]) {
      let calls = 0
      const { params } = setup(async function* () { calls++; yield* repetition() } as any, settings)
      const { terminal } = await drain(query(params))
      expect(calls).toBe(1)
      expect(terminal.code).toBe('REASONING_LOOP')
    }
  })

  test('cancel at the warning yield takes precedence over automatic recovery', async () => {
    let calls = 0
    const { params, controller } = setup(async function* () { calls++; yield* repetition() } as any)
    const stream = query(params)
    let next = await stream.next()
    while (!next.done && !(next.value.type === 'system' && next.value.level === 'warning')) next = await stream.next()
    expect(next.done).toBe(false)
    controller.abort('interrupt')
    const result = await drain(stream)
    expect(calls).toBe(1)
    expect(result.terminal.reason).toBe('aborted_streaming')
    expect(result.output.some(m => m.type === 'user' && m.isMeta)).toBe(false)
  })

  test('text is independent and opt-in', async () => {
    for (const text of [false, true]) {
      const { params } = setup(async function* () {
        yield* repetition('text')
        yield createAssistantMessage({ content: 'Done.' })
      } as any, { text, autoResume: false })
      const { output, terminal } = await drain(query(params))
      expect(output.some(m => m.type === 'stream_reset')).toBe(text)
      expect(terminal.reason).toBe(text ? 'repetition_loop' : 'completed')
      if (text) expect(terminal.code).toBe('TEXT_LOOP')
    }
  })

  test('disabled Guard and auxiliary query sources leave generation untouched', async () => {
    for (const source of ['sdk', 'compact', 'session_memory', 'agent_summary']) {
      const { params } = setup(async function* () {
        yield* repetition()
        yield createAssistantMessage({ content: 'Normal completion.' })
      } as any, { enabled: source !== 'sdk' })
      params.querySource = source as any
      const result = await drain(query(params))
      expect(result.terminal.reason).toBe('completed')
      expect(result.output.some(m => m.type === 'stream_reset')).toBe(false)
    }
  })

  test('signature and input JSON are not rewritten, and tool signals disable retries', async () => {
    const signals = [
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'side-effect', name: 'Write', input: {} } }),
      sse({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'server', name: 'web_search', input: {} } }),
      sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"repeated":'.repeat(500) } }),
    ]
    for (const signal of signals) {
      let calls = 0
      const signature = sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed'.repeat(500) } })
      const { params } = setup(async function* () {
        calls++
        yield signature
        yield signal
        yield* repetition()
        yield createAssistantMessage({ content: 'Done.' })
      } as any)
      const { output, terminal } = await drain(query(params))
      expect(calls).toBe(1)
      expect(output).toContain(signal)
      expect(output).toContain(signature)
      expect(output.some(m => m.type === 'stream_reset')).toBe(false)
      expect(terminal.reason).toBe('completed')
    }
  })

  test('max_output_tokens still uses its own recovery and does not become REASONING_LOOP', async () => {
    let calls = 0
    const { params } = setup(async function* () {
      calls++
      if (calls === 1) yield createAssistantAPIErrorMessage({ content: 'Output limit', apiError: 'max_output_tokens' })
      else yield createAssistantMessage({ content: 'Continued after output limit.' })
    } as any)
    const result = await drain(query(params))
    expect(calls).toBe(2)
    expect(result.output.some(m => m.type === 'stream_reset')).toBe(false)
    expect(result.terminal.reason).toBe('completed')
  })

  test('output-token recovery does not replenish the AntiRep recovery budget', async () => {
    let calls = 0
    const { params } = setup(async function* () {
      calls++
      if (calls === 2) yield createAssistantAPIErrorMessage({ content: 'Output limit', apiError: 'max_output_tokens' })
      else yield* repetition()
    } as any)
    const result = await drain(query(params))
    expect(calls).toBe(4)
    expect(result.output.filter(m => m.type === 'stream_reset')).toHaveLength(3)
    expect(result.terminal.code).toBe('REASONING_LOOP')
  })

  test('streaming fallback resets detection once without forgetting tool risk', async () => {
    let calls = 0
    const fallbackMessage = createAssistantMessage({ content: 'Non-streaming fallback response.' })
    const { params } = setup(async function* (args: any) {
      calls++
      yield start()
      yield sse({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', name: 'web_search', id: 'server', input: {} } })
      args.options.onStreamingFallback()
      yield fallbackMessage
      yield* repetition()
      yield createAssistantMessage({ content: 'Done.' })
    } as any)
    const result = await drain(query(params))
    expect(calls).toBe(1)
    expect(result.output.filter(m => m.type === 'tombstone')).toHaveLength(0)
    expect(result.output.some(m => m.type === 'stream_reset')).toBe(false)
    expect(result.terminal.reason).toBe('completed')
  })

  test('upstream cancellation during iterator cleanup prevents recovery', async () => {
    let calls = 0
    let controller: AbortController
    const fixture = setup(async function* () {
      calls++
      try { yield* repetition() } finally { controller.abort('interrupt') }
    } as any)
    controller = fixture.controller
    const result = await drain(query(fixture.params))
    expect(calls).toBe(1)
    expect(result.terminal.reason).toBe('aborted_streaming')
    expect(result.output.filter(m => m.type === 'stream_reset').map(m => m.recovering)).toEqual([false])
  })

  test('completed tool calls are not replayed when later reasoning loops', async () => {
    let calls = 0
    let sideEffects = 0
    const requests: any[] = []
    const toolMessage = createAssistantMessage({ content: [{ type: 'tool_use', id: 'write-once', name: 'Write', input: {} }] as any })
    const { params, deps, context } = setup(async function* (args: any) {
      requests.push(args)
      calls++
      if (calls === 1) {
        yield toolMessage
        yield* repetition()
      } else if (calls === 2) {
        yield* repetition()
      } else yield createAssistantMessage({ content: 'Completed without repeating Write.' })
    } as any)
    context.agentId = 'tool-safety-test'
    deps.runTools = async function* () {
      sideEffects++
      yield { message: createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'write-once', content: 'written' }],
        sourceToolAssistantUUID: toolMessage.uuid, toolUseResult: { written: true } }) }
    } as any
    const old = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
    try {
      const result = await drain(query(params))
      expect(sideEffects).toBe(1)
      expect(calls).toBe(3)
      expect(result.output.filter(m => m.type === 'stream_reset')).toHaveLength(1)
      expect(JSON.stringify(requests[2].messages)).toContain('write-once')
      expect(JSON.stringify(requests[2].messages)).toContain('written')
      expect(result.terminal.reason).toBe('completed')
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
      else process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = old
    }
  })

  test('running StreamingToolExecutor side effects are never discarded and replayed by AntiRep', async () => {
    let calls = 0
    let sideEffects = 0
    let markStarted!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const completion = new Promise<void>(resolve => { finish = resolve })
    const tool = buildTool({
      name: 'AntiRepSideEffectFixture', maxResultSizeChars: 1024,
      inputSchema: z.object({}),
      description: async () => 'Fixture', prompt: async () => 'Fixture',
      renderToolUseMessage: () => null,
      async call() {
        sideEffects++
        markStarted()
        await completion
        return { data: 'side effect completed' }
      },
      mapToolResultToToolResultBlockParam(data: string, id: string) {
        return { type: 'tool_result' as const, tool_use_id: id, content: data }
      },
    } as any)
    const { params, deps, context } = setup(async function* () {
      calls++
      if (calls === 1) {
        yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'running-effect', name: tool.name, input: {} }] as any })
        await started
        yield* repetition()
        finish()
      } else yield createAssistantMessage({ content: 'Finished.' })
    } as any)
    deps.config!.gates.streamingToolExecution = true
    params.canUseTool = async (_tool, input) => ({ behavior: 'allow', updatedInput: input }) as any
    context.options.tools = [tool]
    context.agentId = 'streaming-tool-test'
    const old = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
    process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
    try {
      const result = await drain(query(params))
      expect(sideEffects).toBe(1)
      expect(calls).toBe(2)
      expect(result.output.some(m => m.type === 'stream_reset')).toBe(false)
      expect(result.output.filter(m => m.type === 'user' && Array.isArray(m.message.content) &&
        m.message.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === 'running-effect'))).toHaveLength(1)
      expect(result.terminal.reason).toBe('completed')
    } finally {
      finish()
      if (old === undefined) delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
      else process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = old
    }
  })

  test('tool progress resets recovery count only for a successful paired result', async () => {
    for (const isError of [false, true]) {
      let calls = 0
      const toolMessage = createAssistantMessage({ content: [{ type: 'tool_use', id: 'progress', name: 'Read', input: {} }] as any })
      const { params, deps, context } = setup(async function* () {
        calls++
        if (calls === 2) yield toolMessage
        else yield* repetition()
      } as any)
      context.agentId = 'progress-test'
      deps.runTools = async function* () {
        yield { message: createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'progress', content: 'result', is_error: isError }],
          sourceToolAssistantUUID: toolMessage.uuid }) }
      } as any
      const old = process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
      process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
      try {
        const result = await drain(query(params))
        expect(calls).toBe(isError ? 4 : 5)
        expect(result.terminal.code).toBe('REASONING_LOOP')
      } finally {
        if (old === undefined) delete process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS
        else process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = old
      }
    }
  })

  test('subagents never expose failed completed thinking blocks to legacy sidechain writers', async () => {
    let calls = 0
    const { params, context } = setup(async function* () {
      calls++
      if (calls === 1) {
        yield createAssistantMessage({ content: [{ type: 'thinking', thinking: 'Failed agent reasoning', signature: 'failed-agent-signature' }] as any })
        yield* repetition()
      } else yield createAssistantMessage({ content: 'Valid agent result.' })
    } as any)
    params.querySource = 'agent:default' as any
    context.agentId = 'sidechain-agent'
    const result = await drain(query(params))
    const recordable = result.output.filter(m => ['assistant', 'user', 'progress'].includes(m.type))
    expect(JSON.stringify(recordable)).not.toContain('failed-agent-signature')
    expect(JSON.stringify(recordable)).not.toContain('Failed agent reasoning')
    expect(result.output.filter(m => m.type === 'assistant')).toHaveLength(1)
    expect(result.terminal.reason).toBe('completed')
  })

  test('parallel agents have independent recovery counters', async () => {
    const looping = setup(async function* () { yield* repetition() } as any)
    const healthy = setup(async function* () { yield createAssistantMessage({ content: 'Healthy result.' }) } as any)
    looping.params.querySource = 'agent:default' as any
    healthy.params.querySource = 'agent:default' as any
    looping.context.agentId = 'looping-agent'
    healthy.context.agentId = 'healthy-agent'
    const [bad, good] = await Promise.all([drain(query(looping.params)), drain(query(healthy.params))])
    expect(bad.terminal.code).toBe('REASONING_LOOP')
    expect(good.terminal.reason).toBe('completed')
    expect(good.output.some(m => m.type === 'stream_reset')).toBe(false)
  })
})
