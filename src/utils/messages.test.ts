import { describe, expect, it } from 'bun:test'
import { buildMessageLookups } from './messages.js'
import type { NormalizedMessage } from '../types/message.js'

function makeToolResult(
  toolUseId: string,
  isError: boolean | undefined,
  type: 'user' | 'assistant' = 'user',
): NormalizedMessage {
  return {
    type,
    message: {
      role: type,
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: isError,
        },
      ],
    },
    uuid: `uuid-${toolUseId}-${Math.random()}`,
  } as NormalizedMessage
}

function makeAssistantWithBlocks(
  blocks: Array<{ type: string; id: string; tool_use_id?: string }>,
): NormalizedMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'test',
      content: blocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    uuid: 'uuid-assistant',
  } as unknown as NormalizedMessage
}

// ---------------------------------------------------------------------------
// erroredToolUseIDs: last-write-wins via Map
// ---------------------------------------------------------------------------

describe('erroredToolUseIDs last-write-wins', () => {
  it('clears error when success follows error for the same tool_use_id', () => {
    const messages: NormalizedMessage[] = [
      makeToolResult('x1', true),
      makeToolResult('x1', undefined),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('x1')).toBe(false)
  })

  it('marks error when error follows success for the same tool_use_id', () => {
    const messages: NormalizedMessage[] = [
      makeToolResult('x1', undefined),
      makeToolResult('x1', true),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('x1')).toBe(true)
  })

  it('marks error when is_error is true and no subsequent result', () => {
    const messages: NormalizedMessage[] = [
      makeToolResult('x1', true),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('x1')).toBe(true)
  })

  it('does not mark error when is_error is omitted', () => {
    const messages: NormalizedMessage[] = [
      makeToolResult('x1', undefined),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('x1')).toBe(false)
  })

  it('marks orphan server_tool_use as errored when not the last message', () => {
    const orphanAssistant = makeAssistantWithBlocks([
      { type: 'server_tool_use', id: 's1' },
    ])
    const messages: NormalizedMessage[] = [
      orphanAssistant,
      makeToolResult('x1', undefined),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('s1')).toBe(true)
  })

  it('does not mark server_tool_use as errored when result exists', () => {
    const assistantWithResult = makeAssistantWithBlocks([
      { type: 'server_tool_use', id: 's1' },
      { type: 'web_search_tool_result', id: 'r1', tool_use_id: 's1' },
    ])
    const messages: NormalizedMessage[] = [
      assistantWithResult,
      makeToolResult('x1', undefined),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.resolvedToolUseIDs.has('s1')).toBe(true)
    expect(lookups.erroredToolUseIDs.has('s1')).toBe(false)
  })

  it('mixed: success clears error, error clears success in order', () => {
    const messages: NormalizedMessage[] = [
      makeToolResult('a', true),
      makeToolResult('a', undefined),
      makeToolResult('b', undefined),
      makeToolResult('b', true),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('a')).toBe(false)
    expect(lookups.erroredToolUseIDs.has('b')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// toolUseResult.interrupted → erroredToolUseIDs for title dot (not is_error)
// ---------------------------------------------------------------------------

describe('toolUseResult interrupted marking', () => {
  function makeInterruptedUser(
    toolUseId: string,
    isError: boolean | undefined,
    interrupted: boolean,
    terminationReason: string,
  ): NormalizedMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: isError,
          },
        ],
      },
      uuid: `uuid-${toolUseId}`,
      toolUseResult: {
        interrupted,
        terminationReason,
      },
    } as unknown as NormalizedMessage
  }

  it('marks interrupted advisor as errored (title dot red)', () => {
    const messages: NormalizedMessage[] = [
      makeInterruptedUser('advisor-1', undefined, true, 'aborted_streaming'),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('advisor-1')).toBe(true)
  })

  it('does not mark completed advisor as errored', () => {
    const messages: NormalizedMessage[] = [
      makeInterruptedUser('advisor-1', undefined, true, 'completed'),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('advisor-1')).toBe(false)
  })

  it('success after interrupted clears the error (last-write-wins)', () => {
    const messages: NormalizedMessage[] = [
      makeInterruptedUser('x', undefined, true, 'aborted_streaming'),
      makeToolResult('x', undefined),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('x')).toBe(false)
  })

  it('does not mark non-interrupted as errored', () => {
    const messages: NormalizedMessage[] = [
      makeInterruptedUser('advisor-1', undefined, false, 'completed'),
    ]
    const lookups = buildMessageLookups(messages, [])
    expect(lookups.erroredToolUseIDs.has('advisor-1')).toBe(false)
  })
})
