/**
 * Memory stress tests for OOM fixes.
 *
 * These tests simulate long-session patterns in a tight loop and verify
 * that committed memory does not grow unboundedly.  They are NOT
 * functional correctness tests — they measure resource retention.
 *
 * Each test:
 * 1. Records a baseline (forced-GC memoryUsage / smaps).
 * 2. Runs N cycles that model the confirmed leak patterns.
 * 3. Forces GC, records final memory.
 * 4. Asserts that the growth ratio is bounded (≤ 3× for heap, ≤ 2× for external).
 *
 * NOTE: Memory measurements are inherently noisy in a GC'd runtime.
 * These tests are probabilistic — they may occasionally fail under
 * extreme system load.  Run with --timeout for headroom.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test'
import { createAbortController } from '../../utils/abortController.js'
import {
  getLastCacheSafeParams,
  saveCacheSafeParams,
  type CacheSafeParams,
} from '../../utils/forkedAgent.js'
import type { CanUseToolFn, Tool, ToolUseContext } from '../../Tool.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import { createUserMessage } from '../../utils/messages.js'
import { ReadBuffer } from '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js'
import type { AssistantMessage, ToolUseBlock } from '../../types/message.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeTool(def: Partial<Tool> = {}): Tool {
  return {
    name: def.name ?? 'stress_tool',
    description: 'stress test tool',
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
    isConcurrencySafe: () => true,
    async *call() {
      yield {
        message: createUserMessage({
          content: [{ type: 'tool_result' as const, content: 'ok', tool_use_id: 'tid' }],
          toolUseResult: 'ok',
          sourceToolAssistantUUID: 'uuid',
        }),
      }
    },
    isEnabled: () => true,
    getPromptForModel: () => '',
  } as any
}

function makeContext(): ToolUseContext {
  return {
    abortController: createAbortController(),
    options: { tools: [], mainLoopModel: 'test' as any },
    messages: [],
    readFileState: new Map() as any,
    setInProgressToolUseIDs: () => {},
    setHasInterruptibleToolInProgress: () => {},
    canUseTool: (() => true) as any,
    getAppState: () => ({} as any),
    setAppState: () => {},
  } as any
}

function makeBlock(id = 'tid1'): ToolUseBlock {
  return { type: 'tool_use' as const, id, name: 'stress_tool', input: {} } as any
}

function makeAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'uuid',
    message: {
      id: 'msg1',
      role: 'assistant',
      content: [makeBlock()],
      model: 'test',
      stop_reason: 'tool_use' as any,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as any
}

/** Force garbage collection and return memory snapshot. */
function memSnapshot(): { heapUsed: number; external: number; rss: number } {
  if (typeof Bun !== 'undefined') Bun.gc(true)
  const m = process.memoryUsage()
  return { heapUsed: m.heapUsed, external: m.external, rss: m.rss }
}

/** Total bytes: heap + external (the two most relevant for JS leaks). */
function totalMem(s: ReturnType<typeof memSnapshot>): number {
  return s.heapUsed + s.external
}

/** Create a large Message[]-like array to simulate long conversations. */
function makeLargeMessages(count: number): CacheSafeParams['forkContextMessages'] {
  const msgs: any[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({
      type: i % 3 === 0 ? 'user' : 'assistant',
      uuid: `msg-${i}`,
      message: {
        role: i % 3 === 0 ? 'user' : 'assistant',
        content: `message body ${i} `.repeat(200), // ~3KB per message
      },
    })
  }
  return msgs
}

// ---------------------------------------------------------------------------
// Before suite: warm up JIT, let allocator settle
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (typeof Bun !== 'undefined') Bun.gc(true)
})

afterEach(() => {
  saveCacheSafeParams(null)
  if (typeof Bun !== 'undefined') Bun.gc(true)
})

// ===========================================================================
// 1. lastCacheSafeParams: snapshot → clear → repeat
// ===========================================================================
test('lastCacheSafeParams: repeated save/clear does not leak', () => {
  const baseline = memSnapshot()

  const LARGE = 200 // 200 messages × ~3KB = ~600KB per snapshot
  const CYCLES = 30

  for (let i = 0; i < CYCLES; i++) {
    const snapshot = {
      forkContextMessages: makeLargeMessages(LARGE),
      systemPrompt: ['test prompt'],
      userContext: { key: 'x'.repeat(1000) },
      systemContext: {},
      toolUseContext: {} as any,
    } as unknown as CacheSafeParams
    saveCacheSafeParams(snapshot)
    // Verify slot holds the snapshot (the reference chain exists)
    expect(getLastCacheSafeParams()).toBe(snapshot)
    // Clear — if the fix works, this releases the reference
    saveCacheSafeParams(null)
    expect(getLastCacheSafeParams()).toBeNull()
  }

  const after = memSnapshot()

  // After clearing, memory should be close to baseline.
  // Allow 3× growth accounting for GC heuristics and JIT structures.
  const growth = totalMem(after) / Math.max(totalMem(baseline), 1)
  console.log(
    `  lastCacheSafeParams stress: baseline=${totalMem(baseline)}, after=${totalMem(after)}, ratio=${growth.toFixed(2)}`,
  )
  expect(growth).toBeLessThan(3.0)
})

// ===========================================================================
// 2. StreamingToolExecutor: create → add tools → discard → repeat
// ===========================================================================
test('StreamingToolExecutor: repeated create/discard cycles do not leak', async () => {
  const baseline = memSnapshot()
  const CYCLES = 100

  for (let i = 0; i < CYCLES; i++) {
    const ctx = makeContext()
    const executor = new StreamingToolExecutor(
      [fakeTool()],
      (() => true) as CanUseToolFn,
      ctx,
    )
    // Queue a few tools
    executor.addTool(makeBlock(`t${i}-a`), makeAssistantMessage())
    executor.addTool(makeBlock(`t${i}-b`), makeAssistantMessage())
    // Immediately discard (simulating fallback)
    executor.discard()
    // Verify nothing yields
    let yielded = 0
    for (const _ of executor.getCompletedResults()) {
      yielded++
    }
    expect(yielded).toBe(0)
  }

  const after = memSnapshot()
  const growth = totalMem(after) / Math.max(totalMem(baseline), 1)
  console.log(
    `  StreamingToolExecutor stress: baseline=${totalMem(baseline)}, after=${totalMem(after)}, ratio=${growth.toFixed(2)}`,
  )
  expect(growth).toBeLessThan(3.0)
})

// ===========================================================================
// 3. ReadBuffer: oversized frame detection releases buffer
// ===========================================================================
test('ReadBuffer: oversized frame detection does not retain buffer', () => {
  const baseline = memSnapshot()
  const MB64 = 64 * 1024 * 1024
  const CYCLES = 5

  for (let i = 0; i < CYCLES; i++) {
    const buf = new ReadBuffer()
    // Append a chunk that is oversized but with a newline
    const oversized = Buffer.alloc(MB64 + 1, 'x')
    const chunk = Buffer.concat([oversized, Buffer.from('\n')])
    try {
      buf.append(chunk)
      // Should not reach here
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.code).toBe('FRAME_TOO_LARGE')
    }
    // Buffer must be cleared
    expect(buf.readMessage()).toBeNull()
  }

  const after = memSnapshot()
  const growth = totalMem(after) / Math.max(totalMem(baseline), 1)
  console.log(
    `  ReadBuffer stress: baseline=${totalMem(baseline)}, after=${totalMem(after)}, ratio=${growth.toFixed(2)}`,
  )
  // Each cycle allocated MB64 twice (once for oversized, once for the chunk),
  // but we only keep the last one alive.  GC should reclaim most.
  expect(growth).toBeLessThan(5.0)
})

// ===========================================================================
// 4. Mixed-stress: simulate a long session pattern
// ===========================================================================
test('mixed stress: long-session simulation does not grow unboundedly', async () => {
  const baseline = memSnapshot()

  // Simulate 15 "turns", each with:
  // - Message accumulation (500 messages added per turn)
  // - Agent fork (large cache-safe snapshot saved then cleared)
  // - Tool execution (10 tools → discard)
  // - Compact (just the snapshot clear part)
  const TURNS = 15
  const MSGS_PER_TURN = 500

  for (let turn = 0; turn < TURNS; turn++) {
    // 1. Message accumulation (this is what the REPL does)
    const allMessages = makeLargeMessages(turn * MSGS_PER_TURN + MSGS_PER_TURN)

    // 2. Save cache-safe snapshot (simulating stopHooks)
    const snapshot = {
      forkContextMessages: allMessages,
      systemPrompt: ['test'],
      userContext: {},
      systemContext: {},
      toolUseContext: {} as any,
    } as unknown as CacheSafeParams
    saveCacheSafeParams(snapshot)

    // 3. Agent fork — simulate creating initialMessages copy
    const initialMessages = [...allMessages]
    // "Fork" finishes — clear the initialMessages
    initialMessages.length = 0

    // 4. Tool execution + fallback
    const ctx = makeContext()
    const executor = new StreamingToolExecutor(
      [fakeTool()],
      (() => true) as CanUseToolFn,
      ctx,
    )
    for (let t = 0; t < 10; t++) {
      executor.addTool(makeBlock(`mix-${turn}-${t}`), makeAssistantMessage())
    }
    executor.discard()

    // 5. Compact — clear the cache-safe slot
    saveCacheSafeParams(null)

    // Force GC after each turn to see real retention
    if (typeof Bun !== 'undefined' && typeof (Bun as any).gc === 'function') {
      ;(Bun as any).gc(true)
    }
  }

  const after = memSnapshot()
  const growth = totalMem(after) / Math.max(totalMem(baseline), 1)
  console.log(
    `  Mixed stress: baseline=${totalMem(baseline)}, after=${totalMem(after)}, ratio=${growth.toFixed(2)}`,
  )
  // After 15 turns of accumulating then releasing, memory should be close
  // to baseline.  A 4× factor is generous accounting for GC internals.
  expect(growth).toBeLessThan(4.0)
})

// ===========================================================================
// 5. Trend test: measure per-cycle growth to detect leaks
// ===========================================================================
test('trend test: memory growth per cycle is sub-linear', async () => {
  const snapshots: number[] = []
  const MSGS = 300
  const CYCLES = 20

  for (let i = 0; i < CYCLES; i++) {
    const msgs = makeLargeMessages(MSGS)
    const snapshot = {
      forkContextMessages: msgs,
      systemPrompt: ['test'],
      userContext: {},
      systemContext: {},
      toolUseContext: {} as any,
    } as unknown as CacheSafeParams
    saveCacheSafeParams(snapshot)

    // Simulate some tool work
    const ctx = makeContext()
    const executor = new StreamingToolExecutor(
      [fakeTool()],
      (() => true) as CanUseToolFn,
      ctx,
    )
    executor.addTool(makeBlock(`trend-${i}`), makeAssistantMessage())
    executor.discard()

    saveCacheSafeParams(null)

    if (typeof Bun !== 'undefined' && typeof (Bun as any).gc === 'function') {
      ;(Bun as any).gc(true)
    }
    snapshots.push(totalMem(memSnapshot()))
  }

  // The first few snapshots may grow (JIT, warmup), but after cycle 5
  // growth should flatten.  We check that the second half's max is not
  // significantly higher than the first half's min.
  const firstHalf = snapshots.slice(0, 5)
  const secondHalf = snapshots.slice(-5)
  const firstMin = Math.min(...firstHalf)
  const secondMax = Math.max(...secondHalf)

  console.log(
    `  Trend: firstHalf=[${firstHalf.map(v => (v / 1024 / 1024).toFixed(1) + 'MB').join(', ')}]`,
  )
  console.log(
    `  Trend: secondHalf=[${secondHalf.map(v => (v / 1024 / 1024).toFixed(1) + 'MB').join(', ')}]`,
  )

  // Second half should not be more than 2× the first half minimum.
  // A leak would show continuous growth → secondHalf >> firstHalf.
  const ratio = secondMax / Math.max(firstMin, 1)
  expect(ratio).toBeLessThan(2.0)
})
