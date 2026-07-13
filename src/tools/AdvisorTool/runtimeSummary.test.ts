import { describe, expect, it } from 'bun:test'
import { buildAdvisorBlocks, summarizeAdvisorMessages } from './runtimeSummary.js'

function assistant(
  content: unknown[],
  options: {
    id?: string
    usage?: Record<string, number>
    isApiErrorMessage?: boolean
  } = {},
) {
  return {
    type: 'assistant',
    message: { content, id: options.id, usage: options.usage },
    isApiErrorMessage: options.isApiErrorMessage,
  }
}

function user(content: unknown[]) {
  return { type: 'user', message: { content } }
}

describe('buildAdvisorBlocks', () => {
  const formatToolUse = (name: string, input: unknown) =>
    `${name}:${JSON.stringify(input)}`

  it('preserves assistant text and tool-use order', () => {
    const blocks = buildAdvisorBlocks([
      user([{ type: 'text', text: 'do not include' }]),
      assistant([
        { type: 'text', text: 'before' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'text', text: 'after' },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'x', is_error: false }]),
    ], formatToolUse)

    expect(blocks).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool', text: 'Read:{"file_path":"/a.ts"}' },
      { type: 'text', text: 'after' },
    ])
  })

  it('truncates text and tool blocks at the 20K budget', () => {
    const textOverflow = buildAdvisorBlocks([
      assistant([{ type: 'text', text: 'a'.repeat(20_001) }]),
    ], formatToolUse)
    expect(textOverflow).toEqual([
      { type: 'text', text: 'a'.repeat(20_000) },
      { type: 'tool', text: '[...blocks truncated]' },
    ])

    const toolOverflow = buildAdvisorBlocks([
      assistant([{ type: 'tool_use', name: 'Read', input: 'x'.repeat(20_000) }]),
    ], formatToolUse)
    expect(toolOverflow).toEqual([
      { type: 'tool', text: '[...blocks truncated]' },
    ])
  })
})

describe('summarizeAdvisorMessages', () => {
  it('deduplicates keyed response usage across interleaved tool results', () => {
    const summary = summarizeAdvisorMessages([
      assistant([{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a.ts' } }], {
        id: 'response-1',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      user([{ type: 'tool_result', tool_use_id: 'read-1', is_error: false }]),
      assistant([{ type: 'text', text: 'final advice' }], {
        id: 'response-1',
        usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 20 },
      }),
      assistant([{ type: 'text', text: 'later advice' }], {
        id: 'response-2',
        usage: { input_tokens: 200, output_tokens: 5 },
      }),
    ])

    expect(summary.tokens).toBe(350)
    expect(summary.filesRead).toBe(1)
    expect(summary.toolsCalled).toBe(1)
    expect(summary.advice).toBe('later advice')
  })

  it('uses contiguous unkeyed groups for token aggregation', () => {
    const summary = summarizeAdvisorMessages([
      assistant([{ type: 'text', text: 'first' }], { usage: { input_tokens: 10, output_tokens: 1 } }),
      assistant([{ type: 'text', text: 'second' }], { usage: { input_tokens: 20, output_tokens: 2 } }),
      user([{ type: 'tool_result', tool_use_id: 'x', is_error: false }]),
      assistant([{ type: 'text', text: 'final' }], { usage: { input_tokens: 30, output_tokens: 3 } }),
    ])

    // Max of first contiguous group (20 + 2), plus second group (30 + 3)
    expect(summary.tokens).toBe(55)
    // Existing unkeyed advice behavior combines all unkeyed fragments.
    expect(summary.advice).toBe('first\n\nsecond\n\nfinal')
  })

  it('counts successful unique Read paths and successful WebSearch only', () => {
    const summary = summarizeAdvisorMessages([
      assistant([
        { type: 'tool_use', id: 'read-ok', name: 'Read', input: { file_path: '/same.ts' } },
        { type: 'tool_use', id: 'read-duplicate', name: 'Read', input: { file_path: '/same.ts' } },
        { type: 'tool_use', id: 'read-error', name: 'Read', input: { file_path: '/bad.ts' } },
        { type: 'tool_use', id: 'web-ok', name: 'WebSearch', input: { query: 'docs' } },
        { type: 'tool_use', id: 'web-error', name: 'WebSearch', input: { query: 'broken' } },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 'read-ok', is_error: false },
        { type: 'tool_result', tool_use_id: 'read-duplicate', is_error: false },
        { type: 'tool_result', tool_use_id: 'read-error', is_error: true },
        { type: 'tool_result', tool_use_id: 'web-ok', is_error: false },
        { type: 'tool_result', tool_use_id: 'web-error', is_error: true },
      ]),
    ])

    expect(summary.toolsCalled).toBe(5)
    expect(summary.filesRead).toBe(1)
    expect(summary.webSearched).toBe(true)
  })

  it('uses the final keyed response for advice and reports API errors', () => {
    const summary = summarizeAdvisorMessages([
      assistant([{ type: 'text', text: 'old advice' }], { id: 'response-1' }),
      assistant([{ type: 'text', text: 'new advice' }], {
        id: 'response-2',
        isApiErrorMessage: true,
      }),
    ])

    expect(summary.advice).toBe('new advice')
    expect(summary.sawApiError).toBe(true)
  })

  it('ignores malformed envelopes without throwing', () => {
    const summary = summarizeAdvisorMessages([
      null,
      { type: 'assistant' },
      { type: 'other', message: { content: [] } },
    ])

    expect(summary).toEqual({
      advice: '',
      sawApiError: false,
      toolsCalled: 0,
      filesRead: 0,
      webSearched: false,
      tokens: 0,
    })
  })
})
