import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  BetaMessageParam,
  BetaToolUnion,
  MessageCountTokensParams,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

// Run as an isolated .cases file so these direct-dependency mocks cannot leak.
const MAIN_MODEL = 'configured-main-model'
const SMALL_MODEL = 'configured-small-fast-model'
const ALL_BETAS = [
  'interleaved-thinking-2025-05-14',
  'web-search-2025-03-05',
  'custom-token-count-beta',
]
const metadata = { user_id: 'token-estimation-test' }
const extraBodyParams = { temperature: 0, top_k: 7, gateway_extension: { test: true } }
const tools: BetaToolUnion[] = [{
  name: 'lookup',
  description: 'Look up a test record',
  input_schema: { type: 'object', properties: { key: { type: 'string' } } },
}]
const plainMessages: BetaMessageParam[] = [{ role: 'user', content: 'Count these tokens' }]
const thinkingBlocks = [
  { type: 'thinking' as const, thinking: 'Test reasoning', signature: 'test-signature' },
  { type: 'redacted_thinking' as const, data: 'test-redacted-data' },
]

let mainModel: string | undefined
let smallModel: string | undefined
let betas: string[]
let countResponse: { input_tokens?: unknown }
let usage: {
  input_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  output_tokens: number
}
let countFailure: Error | undefined
let clientFailure: Error | undefined
let createFailure: Error | undefined

const countTokens = mock(async (_request: MessageCountTokensParams) => {
  if (countFailure) throw countFailure
  return countResponse
})
const create = mock(async (_request: MessageCreateParamsNonStreaming) => {
  if (createFailure) throw createFailure
  return { usage }
})
const getClient = mock(async (_options: { maxRetries: number; model: string; source: string }) => {
  if (clientFailure) throw clientFailure
  return { beta: { messages: { countTokens, create } } }
})
const getMainModel = mock(() => mainModel)
const getSmallModel = mock(() => smallModel)
const getBetas = mock((_model: string) => betas)
const readMetadata = mock(() => metadata)
const readExtraBodyParams = mock(() => extraBodyParams)
const logError = mock((_error: unknown) => {})
const withTokenCountVCR = mock((
  _messages: BetaMessageParam[],
  _tools: BetaToolUnion[],
  run: () => Promise<number | null>,
) => run())

// No real clients, settings/authentication, logs, or fixture/user files are loaded.
mock.module('./api/client.js', () => ({ getAnthropicClient: getClient }))
mock.module('./api/claude.js', () => ({
  getAPIMetadata: readMetadata,
  getExtraBodyParams: readExtraBodyParams,
}))
mock.module('../utils/model/model.js', () => ({
  getMainLoopModel: getMainModel,
  getSmallFastModel: getSmallModel,
}))
mock.module('../utils/betas.js', () => ({ getModelBetas: getBetas }))
mock.module('./vcr.js', () => ({ withTokenCountVCR }))
mock.module('../utils/log.js', () => ({ logError }))
mock.module('../utils/messages.js', () => ({
  normalizeAttachmentForAPI: () => {
    throw new Error('Attachment normalization is outside these token API cases')
  },
}))
mock.module('../utils/slowOperations.js', () => ({ jsonStringify: JSON.stringify }))
mock.module('../utils/toolSearch.js', () => ({
  isToolReferenceBlock: (block: unknown) => typeof block === 'object'
    && block !== null && 'type' in block && block.type === 'tool_reference',
}))

const legacyKeys = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const
const envKeys = [...legacyKeys, 'CLOUD_ML_REGION'] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
  mainModel = MAIN_MODEL
  smallModel = SMALL_MODEL
  betas = [...ALL_BETAS]
  countResponse = { input_tokens: 42 }
  usage = {
    input_tokens: 11,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 3,
    output_tokens: 999,
  }
  countFailure = undefined
  clientFailure = undefined
  createFailure = undefined
  for (const fn of [
    countTokens, create, getClient, getMainModel, getSmallModel, getBetas,
    readMetadata, readExtraBodyParams, logError, withTokenCountVCR,
  ]) fn.mockClear()
})

afterAll(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  mock.restore()
})

const {
  countTokensWithAPI,
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
} = await import('./tokenEstimation.js')

describe('Anthropic message token counting', () => {
  test('returns zero for empty text without invoking VCR or the client', async () => {
    expect(await countTokensWithAPI('')).toBe(0)
    expect(withTokenCountVCR).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
  })

  test('wraps nonempty text in a user message', async () => {
    expect(await countTokensWithAPI('Count this text')).toBe(42)
    expect(countTokens).toHaveBeenCalledWith({
      model: MAIN_MODEL,
      messages: [{ role: 'user', content: 'Count this text' }],
      tools: [],
      betas: ALL_BETAS,
    })
    expect(create).not.toHaveBeenCalled()
  })

  test('uses beta.messages.countTokens with the main model, original tools and every beta', async () => {
    expect(await countMessagesTokensWithAPI(plainMessages, tools)).toBe(42)
    expect(getClient).toHaveBeenCalledTimes(1)
    expect(getClient).toHaveBeenCalledWith({ maxRetries: 1, model: MAIN_MODEL, source: 'count_tokens' })
    expect(getBetas).toHaveBeenCalledWith(MAIN_MODEL)
    expect(countTokens).toHaveBeenCalledTimes(1)
    expect(countTokens).toHaveBeenCalledWith({
      model: MAIN_MODEL, messages: plainMessages, tools, betas: ALL_BETAS,
    })
    expect(withTokenCountVCR).toHaveBeenCalledTimes(1)
    expect(withTokenCountVCR.mock.calls[0]![0]).toBe(plainMessages)
    expect(withTokenCountVCR.mock.calls[0]![1]).toBe(tools)
    expect(getSmallModel).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  test('adds a dummy user message when counting tools without messages', async () => {
    expect(await countMessagesTokensWithAPI([], tools)).toBe(42)
    expect(countTokens).toHaveBeenCalledWith({
      model: MAIN_MODEL,
      messages: [{ role: 'user', content: 'foo' }],
      tools,
      betas: ALL_BETAS,
    })
    expect(withTokenCountVCR.mock.calls[0]![0]).toEqual([])
  })

  for (const block of thinkingBlocks) {
    test(`enables the minimal thinking budget for ${block.type} blocks`, async () => {
      const messages: BetaMessageParam[] = [{ role: 'assistant', content: [block] }]
      expect(await countMessagesTokensWithAPI(messages, tools)).toBe(42)
      expect(countTokens).toHaveBeenCalledWith({
        model: MAIN_MODEL,
        messages,
        tools,
        betas: ALL_BETAS,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      })
    })
  }

  test('omits an empty beta list and does not enable thinking for plain text', async () => {
    betas = []
    expect(await countMessagesTokensWithAPI(plainMessages, [])).toBe(42)
    const request = countTokens.mock.calls[0]![0]
    expect(request).toEqual({ model: MAIN_MODEL, messages: plainMessages, tools: [] })
    expect(request).not.toHaveProperty('betas')
    expect(request).not.toHaveProperty('thinking')
  })

  test('accepts a zero input token count', async () => {
    countResponse = { input_tokens: 0 }
    expect(await countMessagesTokensWithAPI(plainMessages, [])).toBe(0)
  })

  for (const value of [undefined, null, '42']) {
    test(`returns null for a nonnumeric input token count (${String(value)})`, async () => {
      countResponse = { input_tokens: value }
      expect(await countMessagesTokensWithAPI(plainMessages, [])).toBeNull()
    })
  }

  test('returns null without creating a client when the main model is unavailable', async () => {
    mainModel = undefined
    expect(await countMessagesTokensWithAPI(plainMessages, tools)).toBeNull()
    expect(getClient).not.toHaveBeenCalled()
    expect(countTokens).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  test('logs count API failures and returns null without generating a fallback response', async () => {
    countFailure = new Error('Test count API failure')
    expect(await countMessagesTokensWithAPI(plainMessages, tools)).toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(countFailure)
    expect(create).not.toHaveBeenCalled()
  })

  test('logs client initialization failures and returns null', async () => {
    clientFailure = new Error('Test client initialization failure')
    expect(await countMessagesTokensWithAPI(plainMessages, tools)).toBeNull()
    expect(logError).toHaveBeenCalledWith(clientFailure)
    expect(countTokens).not.toHaveBeenCalled()
  })
})

describe('Anthropic small-fast token fallback', () => {
  test('uses the small-fast model, preserves metadata and extra parameters, and sums input usage only', async () => {
    expect(await countTokensViaHaikuFallback(plainMessages, tools)).toBe(21)
    expect(getSmallModel).toHaveBeenCalledTimes(1)
    expect(getMainModel).not.toHaveBeenCalled()
    expect(getClient).toHaveBeenCalledWith({ maxRetries: 1, model: SMALL_MODEL, source: 'count_tokens' })
    expect(getBetas).toHaveBeenCalledWith(SMALL_MODEL)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      model: SMALL_MODEL,
      max_tokens: 1,
      messages: plainMessages,
      tools,
      betas: ALL_BETAS,
      metadata,
      ...extraBodyParams,
    })
    expect(readMetadata).toHaveBeenCalledTimes(1)
    expect(readExtraBodyParams).toHaveBeenCalledTimes(1)
    expect(countTokens).not.toHaveBeenCalled()
    expect(withTokenCountVCR).not.toHaveBeenCalled()
  })

  for (const block of thinkingBlocks) {
    test(`preserves ${block.type} blocks and budgets without switching to the main model`, async () => {
      const messages: BetaMessageParam[] = [{ role: 'assistant', content: [block] }]
      expect(await countTokensViaHaikuFallback(messages, tools)).toBe(21)
      expect(create).toHaveBeenCalledWith({
        model: SMALL_MODEL,
        max_tokens: 2048,
        messages,
        tools,
        betas: ALL_BETAS,
        metadata,
        ...extraBodyParams,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      })
      expect(getMainModel).not.toHaveBeenCalled()
    })
  }

  test('strips tool search fields without mutating messages or removing thinking and result content', async () => {
    const resultText = { type: 'text' as const, text: 'Lookup result' }
    const messages = [
      {
        role: 'assistant',
        content: [
          ...thinkingBlocks,
          { type: 'tool_use', id: 'mixed', name: 'lookup', input: { key: 'one' }, caller: { type: 'direct' } },
          { type: 'tool_use', id: 'references-only', name: 'lookup', input: {}, caller: { type: 'direct' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result', tool_use_id: 'mixed', is_error: false,
            content: [{ type: 'tool_reference', tool_name: 'lookup' }, resultText],
          },
          {
            type: 'tool_result', tool_use_id: 'references-only',
            content: [{ type: 'tool_reference', tool_name: 'lookup' }],
          },
        ],
      },
      ...plainMessages,
    ] as unknown as BetaMessageParam[]
    const original = structuredClone(messages)

    expect(await countTokensViaHaikuFallback(messages, tools)).toBe(21)
    expect(create.mock.calls[0]![0].messages).toEqual([
      {
        role: 'assistant',
        content: [
          ...thinkingBlocks,
          { type: 'tool_use', id: 'mixed', name: 'lookup', input: { key: 'one' } },
          { type: 'tool_use', id: 'references-only', name: 'lookup', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'mixed', is_error: false, content: [resultText] },
          { type: 'tool_result', tool_use_id: 'references-only', content: [{ type: 'text', text: '[tool references]' }] },
        ],
      },
      ...plainMessages,
    ])
    expect(messages).toEqual(original)
  })

  test('adds a dummy message and omits tools, betas and thinking when all are empty', async () => {
    betas = []
    expect(await countTokensViaHaikuFallback([], [])).toBe(21)
    const request = create.mock.calls[0]![0]
    expect(request).toEqual({
      model: SMALL_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'count' }],
      tools: undefined,
      metadata,
      ...extraBodyParams,
    })
    expect(request.tools).toBeUndefined()
    expect(request).not.toHaveProperty('betas')
    expect(request).not.toHaveProperty('thinking')
  })

  for (const value of [undefined, null, 0]) {
    test(`defaults absent or empty cache usage to zero (${String(value)})`, async () => {
      usage.cache_creation_input_tokens = value
      usage.cache_read_input_tokens = value
      expect(await countTokensViaHaikuFallback(plainMessages, [])).toBe(11)
    })
  }

  test('returns zero for zero input usage and missing cache usage', async () => {
    usage = { input_tokens: 0, output_tokens: 999 }
    expect(await countTokensViaHaikuFallback(plainMessages, [])).toBe(0)
  })

  test('returns null rather than using the main model when the small-fast model is unavailable', async () => {
    smallModel = undefined
    expect(await countTokensViaHaikuFallback(plainMessages, tools)).toBeNull()
    expect(getMainModel).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  test('propagates fallback generation failures rather than inventing a token count', async () => {
    createFailure = new Error('Test fallback API failure')
    await expect(countTokensViaHaikuFallback(plainMessages, tools)).rejects.toBe(createFailure)
    expect(countTokens).not.toHaveBeenCalled()
  })
})

describe('legacy cloud environment switches', () => {
  const modes = [
    { name: 'Bedrock', keys: [legacyKeys[0]] },
    { name: 'Vertex', keys: [legacyKeys[1]] },
    { name: 'Foundry', keys: [legacyKeys[2]] },
    { name: 'all three cloud providers', keys: legacyKeys },
  ]

  for (const mode of modes) {
    for (const withThinking of [false, true]) {
      test(`ignores legacy ${mode.name} switches ${withThinking ? 'with' : 'without'} thinking`, async () => {
        const messages: BetaMessageParam[] = withThinking
          ? [...plainMessages, { role: 'assistant', content: [...thinkingBlocks] }]
          : plainMessages
        const baseline = [
          await countMessagesTokensWithAPI(messages, tools),
          await countTokensViaHaikuFallback(messages, tools),
        ]
        expect(baseline).toEqual([42, 21])
        const baselineCountCall = structuredClone(countTokens.mock.calls[0])
        const baselineCreateCall = structuredClone(create.mock.calls[0])
        const baselineClientCalls = structuredClone(getClient.mock.calls)
        const baselineBetaCalls = structuredClone(getBetas.mock.calls)

        // The old Vertex global-region exception must not change model selection.
        process.env.CLOUD_ML_REGION = 'global'
        for (const key of mode.keys) process.env[key] = '1'
        expect([
          await countMessagesTokensWithAPI(messages, tools),
          await countTokensViaHaikuFallback(messages, tools),
        ]).toEqual(baseline)
        expect(countTokens).toHaveBeenCalledTimes(2)
        expect(create).toHaveBeenCalledTimes(2)
        expect(countTokens.mock.calls[1]).toEqual(baselineCountCall)
        expect(create.mock.calls[1]).toEqual(baselineCreateCall)
        expect(getClient.mock.calls.slice(2)).toEqual(baselineClientCalls)
        expect(getBetas.mock.calls.slice(2)).toEqual(baselineBetaCalls)
        expect(getMainModel).toHaveBeenCalledTimes(2)
        expect(getSmallModel).toHaveBeenCalledTimes(2)
        expect(logError).not.toHaveBeenCalled()
      })
    }
  }
})
