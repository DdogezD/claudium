import { afterEach, expect, test } from 'bun:test'
import { createAbortController } from '../../utils/abortController.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import type {
  AssistantMessage,
  ToolUseBlock,
} from '../../types/message.js'
import type { CanUseToolFn, Tool, ToolUseContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'

function fakeTool(def: Partial<Tool> = {}): Tool {
  return {
    name: def.name ?? 'fake_tool',
    description: 'a fake tool for testing',
    inputSchema: def.inputSchema ?? {
      safeParse: () => ({ success: true, data: { action: 'test' } }),
    },
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    async *call(_input, _context) {
      yield {
        message: createUserMessage({
          content: [{ type: 'tool_result', content: 'done', tool_use_id: 'tid1' }],
          toolUseResult: 'done',
          sourceToolAssistantUUID: 'msguuid',
        }),
      }
    },
    isEnabled: () => true,
    getPromptForModel: () => '',
  } as any
}

function makeBlock(name = 'fake_tool', id = 'tid1'): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input: { action: 'test' },
  } as ToolUseBlock
}

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'msguuid',
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [makeBlock()],
      model: 'test',
      stop_reason: 'tool_use' as any,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as any
}

function makeContext(): ToolUseContext {
  const ids = new Set<string>()
  return {
    abortController: createAbortController(),
    options: { tools: [], mainLoopModel: 'test' as any },
    messages: [],
    readFileState: new Map() as any,
    setInProgressToolUseIDs: (fn: any) => {
      const next = fn(ids)
      ids.clear()
      for (const id of next) ids.add(id)
      return next
    },
    setHasInterruptibleToolInProgress: () => {},
    canUseTool: (() => true) as any,
    getAppState: () => ({} as any),
    setAppState: () => {},
  } as any
}

afterEach(() => {
  Bun.gc(true)
})

test('discard is idempotent', () => {
  const ctx = makeContext()
  const executor = new StreamingToolExecutor(
    [fakeTool()],
    (() => true) as CanUseToolFn,
    ctx,
  )
  executor.discard()
  // Second call must not throw
  executor.discard()
})

test('discard aborts sibling controller with streaming_fallback reason', () => {
  const ctx = makeContext()
  const executor = new StreamingToolExecutor(
    [fakeTool()],
    (() => true) as CanUseToolFn,
    ctx,
  )
  const block = makeBlock()
  executor.addTool(block, makeAssistantMessage())
  executor.discard()
  // Parent query controller must NOT be aborted
  expect(ctx.abortController.signal.aborted).toBe(false)
  // After discard, getCompletedResults yields nothing
  let yielded = false
  for (const _result of executor.getCompletedResults()) {
    yielded = true
  }
  expect(yielded).toBe(false)
})

test('discard does not abort parent query controller', () => {
  const ctx = makeContext()
  const executor = new StreamingToolExecutor(
    [fakeTool()],
    (() => true) as CanUseToolFn,
    ctx,
  )
  executor.discard()
  expect(ctx.abortController.signal.aborted).toBe(false)
})

test('discard removes in-progress tool IDs from shared set', () => {
  const ctx = makeContext()
  const block = makeBlock()
  ctx.setInProgressToolUseIDs(prev => new Set(prev).add(block.id))

  const executor = new StreamingToolExecutor(
    [fakeTool()],
    (() => true) as CanUseToolFn,
    ctx,
  )
  executor.addTool(block, makeAssistantMessage())

  executor.discard()

  // After discard, getCompletedResults yields nothing
  let count = 0
  for (const _result of executor.getCompletedResults()) {
    count++
  }
  expect(count).toBe(0)
})

test('discard resolves progress waiter so iterator exits', async () => {
  const ctx = makeContext()
  const executor = new StreamingToolExecutor(
    [fakeTool()],
    (() => true) as CanUseToolFn,
    ctx,
  )
  // Start the iterator but don't await yet
  const iter = executor.getRemainingResults()
  // Discard before the first yield
  executor.discard()
  // Async iterator must exit immediately
  let count = 0
  for await (const _result of iter) {
    count++
  }
  expect(count).toBe(0)
})

test('discard prevents queued tools from starting', () => {
  const ctx = makeContext()
  let started = false
  const tool = fakeTool({
    async *call(_input, _context) {
      started = true
      yield {
        message: createUserMessage({
          content: [{ type: 'tool_result', content: 'done', tool_use_id: 'tid1' }],
          toolUseResult: 'done',
          sourceToolAssistantUUID: 'msguuid',
        }),
      }
    },
  })

  const executor = new StreamingToolExecutor(
    [tool],
    (() => true) as CanUseToolFn,
    ctx,
  )
  // Add tool then immediately discard
  executor.addTool(makeBlock(), makeAssistantMessage())
  executor.discard()

  // The tool should not have started
  expect(started).toBe(false)
})
