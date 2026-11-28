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

function attempt({ outputTokens = 40_000, aborted = false, tracking }: {
  outputTokens?: number
  aborted?: boolean
  tracking?: AutoCompactTrackingState
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
  const state = mock<(active: boolean) => void>()
  const promise = autoCompactIfNeeded(messages, context, {
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    toolUseContext: context,
    forkContextMessages: messages,
  }, 'repl_main_thread', tracking, undefined, state)
  return { controller, model, messages, promise, state }
}

test('reports a real attempt even when the footer estimate is below the threshold', async () => {
  const entered = Promise.withResolvers<void>()
  const memory = Promise.withResolvers<compact.CompactionResult>()
  spyOn(sessionMemory, 'trySessionMemoryCompaction').mockImplementation(() => {
    entered.resolve()
    return memory.promise
  })
  const summary = spyOn(compact, 'compactConversation').mockRejectedValue(new Error('Unexpected summary request'))
  const { model, messages, promise, state } = attempt()
  expect(tokenCountForSubmittedContext(messages)).toBeLessThan(getAutoCompactThreshold(model))
  await entered.promise
  expect(state.mock.calls).toEqual([[true]])
  memory.resolve(result)
  expect((await promise).compactionResult).toBe(result)
  expect(state.mock.calls).toEqual([[true], [false]])
  expect(summary).not.toHaveBeenCalled()
})

test('stays active across fallback to summary and clears after a failure', async () => {
  spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(null)
  const entered = Promise.withResolvers<void>()
  const summary = Promise.withResolvers<compact.CompactionResult>()
  spyOn(compact, 'compactConversation').mockImplementation(() => {
    entered.resolve()
    return summary.promise
  })
  const { promise, state } = attempt()
  await entered.promise
  expect(state.mock.calls).toEqual([[true]])
  summary.reject(new Error(compact.ERROR_MESSAGE_USER_ABORT))
  expect(await promise).toEqual({ wasCompacted: false, consecutiveFailures: 1 })
  expect(state.mock.calls).toEqual([[true], [false]])
})

test('clears immediately on cancellation, without a late update during the next attempt', async () => {
  const entered = Promise.withResolvers<void>()
  const memory = Promise.withResolvers<compact.CompactionResult>()
  const nextEntered = Promise.withResolvers<void>()
  const nextMemory = Promise.withResolvers<compact.CompactionResult>()
  spyOn(sessionMemory, 'trySessionMemoryCompaction')
    .mockImplementationOnce(() => {
      entered.resolve()
      return memory.promise
    })
    .mockImplementationOnce(() => {
      nextEntered.resolve()
      return nextMemory.promise
    })
  const { controller, promise, state } = attempt()
  await entered.promise
  controller.abort()
  expect(state.mock.calls).toEqual([[true], [false]])

  const next = attempt()
  await nextEntered.promise
  memory.resolve(result)
  await promise
  expect(state.mock.calls).toEqual([[true], [false]])
  expect(next.state.mock.calls).toEqual([[true]])
  nextMemory.resolve(result)
  await next.promise
  expect(next.state.mock.calls).toEqual([[true], [false]])
})

test('does not report low usage, circuit-breaking, disabled, or already cancelled requests', async () => {
  const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(result)
  const low = attempt({ outputTokens: 0 })
  const circuitBroken = attempt({ tracking: { compacted: false, turnCounter: 1, turnId: 'test', consecutiveFailures: 3 } })
  await Promise.all([low.promise, circuitBroken.promise])
  expect(memory).not.toHaveBeenCalled()
  expect(low.state).not.toHaveBeenCalled()
  expect(circuitBroken.state).not.toHaveBeenCalled()

  process.env.DISABLE_AUTO_COMPACT = '1'
  const disabled = attempt()
  await disabled.promise
  expect(memory).not.toHaveBeenCalled()
  expect(disabled.state).not.toHaveBeenCalled()

  process.env.DISABLE_AUTO_COMPACT = ''
  const cancelled = attempt({ aborted: true })
  await cancelled.promise
  expect(cancelled.state).not.toHaveBeenCalled()
})
