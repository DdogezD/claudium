import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import * as config from '../../utils/config.js'
import { createAssistantMessage, createCompactBoundaryMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { tokenCountForSubmittedContext } from '../../utils/tokens.js'
import { autoCompactIfNeeded, getAutoCompactThreshold, type AutoCompactTrackingState } from './autoCompact.js'
import * as compact from './compact.js'
import * as sessionMemory from './sessionMemoryCompact.js'

const overrides = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '50000',
  CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS: '3000',
  CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS: '13000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
  DISABLE_COMPACT: '',
  DISABLE_AUTO_COMPACT: '',
}
const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
const result: compact.CompactionResult = {
  boundaryMarker: createCompactBoundaryMessage('auto', 50_000),
  summaryMessages: [],
  attachments: [],
  hookResults: [],
}

beforeAll(() => config.enableConfigs())
beforeEach(() => {
  Object.assign(process.env, overrides)
  const globalConfig = config.getGlobalConfig()
  spyOn(config, 'getGlobalConfig').mockReturnValue({ ...globalConfig, autoCompactEnabled: true })
})
afterEach(() => {
  mock.restore()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function attempt({ outputTokens = 40_000, aborted = false, tracking, beforeCompact = async () => {} }: {
  outputTokens?: number
  aborted?: boolean
  tracking?: AutoCompactTrackingState
  beforeCompact?: () => Promise<void>
} = {}) {
  const controller = new AbortController()
  if (aborted) controller.abort()
  const model = 'test-model'
  const response = createAssistantMessage({ content: 'Response.' })
  response.message.model = model
  response.message.stop_reason = 'end_turn'
  response.message.usage.input_tokens = 10_000
  response.message.usage.output_tokens = outputTokens
  const messages = [response]
  const context = {
    options: { mainLoopModel: model },
    abortController: controller,
  } as ToolUseContext
  const before = mock(beforeCompact)
  const promise = autoCompactIfNeeded(messages, context, {
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    toolUseContext: context,
    forkContextMessages: messages,
  }, 'repl_main_thread', tracking, undefined, before)
  return { controller, model, messages, promise, before }
}

function waitingAttempt() {
  const waiting = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  return {
    ...attempt({ beforeCompact: () => {
      waiting.resolve()
      return proceed.promise
    } }),
    waiting: waiting.promise,
    proceed: proceed.resolve,
  }
}

for (const useSessionMemory of [true, false]) {
  test(`waits for the notice before starting ${useSessionMemory ? 'session-memory' : 'summary'} compaction`, async () => {
    const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(useSessionMemory ? result : null)
    const summary = spyOn(compact, 'compactConversation').mockResolvedValue(result)
    const { model, messages, promise, before, waiting, proceed } = waitingAttempt()
    expect(tokenCountForSubmittedContext(messages)).toBeLessThan(getAutoCompactThreshold(model))
    await waiting
    expect(memory).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
    proceed()
    expect((await promise).compactionResult).toBe(result)
    expect(before).toHaveBeenCalledTimes(1)
    expect(memory).toHaveBeenCalledTimes(1)
    expect(summary).toHaveBeenCalledTimes(useSessionMemory ? 0 : 1)
  })
}

test('a late acknowledgement cannot start a cancelled attempt', async () => {
  const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(result)
  const summary = spyOn(compact, 'compactConversation').mockResolvedValue(result)
  const old = waitingAttempt()
  await old.waiting
  old.controller.abort('user-cancel')
  const next = waitingAttempt()
  await next.waiting

  old.proceed()
  expect(await old.promise).toEqual({ wasCompacted: false })
  expect(memory).not.toHaveBeenCalled()
  expect(summary).not.toHaveBeenCalled()

  next.proceed()
  expect((await next.promise).compactionResult).toBe(result)
  expect(memory).toHaveBeenCalledTimes(1)
})

test('skips compaction if disabled while waiting for the notice', async () => {
  const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(result)
  const { waiting, proceed, promise } = waitingAttempt()
  await waiting
  process.env.DISABLE_AUTO_COMPACT = '1'
  proceed()
  expect(await promise).toEqual({ wasCompacted: false })
  expect(memory).not.toHaveBeenCalled()
})

test('does not report low usage, circuit-breaking, disabled, or already cancelled requests', async () => {
  const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(result)
  const summary = spyOn(compact, 'compactConversation').mockResolvedValue(result)
  const low = attempt({ outputTokens: 0 })
  const circuitBroken = attempt({ tracking: { compacted: false, turnCounter: 1, turnId: 'test', consecutiveFailures: 3 } })
  await Promise.all([low.promise, circuitBroken.promise])
  expect(low.before).not.toHaveBeenCalled()
  expect(circuitBroken.before).not.toHaveBeenCalled()

  process.env.DISABLE_AUTO_COMPACT = '1'
  const disabled = attempt()
  await disabled.promise
  expect(disabled.before).not.toHaveBeenCalled()

  process.env.DISABLE_AUTO_COMPACT = ''
  const cancelled = attempt({ aborted: true })
  await cancelled.promise
  expect(cancelled.before).not.toHaveBeenCalled()
  expect(memory).not.toHaveBeenCalled()
  expect(summary).not.toHaveBeenCalled()
})
