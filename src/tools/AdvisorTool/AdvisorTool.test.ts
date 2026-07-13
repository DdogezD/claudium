import { describe, expect, it } from 'bun:test'
import {
  tokenize,
  tokenizeQuery,
} from './conversationLog/tokenizer.js'
import { buildSearchIndex, bm25Search, formatSearchResults, formatEntryLabel } from './conversationLog/search.js'
import { createConversationLogTool } from './conversationLog/ConversationLogTool.js'
import type { ConversationEntry, SearchIndex } from './types.js'

// ---------------------------------------------------------------------------
// Smoke: module imports without init-order crash
// ---------------------------------------------------------------------------

describe('module imports', () => {
  it('AdvisorTool imports without crash', () => {
    // Lazy allowlist means this must NOT throw during import
    const { AdvisorTool } = require('./AdvisorTool.js')
    expect(AdvisorTool).toBeDefined()
    expect(AdvisorTool.name).toBe('Advisor')
  })

  it('ConversationLogTool can be created', () => {
    const entries: ConversationEntry[] = []
    const index = buildSearchIndex(entries)
    const { tool, getUniqueReadCount } = createConversationLogTool(entries, index)
    expect(tool).toBeDefined()
    expect(tool.name).toBe('ReadConversationLog')
    expect(getUniqueReadCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tokenizer: mixed-script edge cases
// ---------------------------------------------------------------------------

describe('tokenize mixed script', () => {
  it('splits Chinese + ASCII mix without merging scripts', () => {
    const tokens = tokenize('测试API')
    expect(tokens).toContain('api')
    expect(tokens).toContain('测试')
    expect(tokens).toContain('测')
    expect(tokens).toContain('试')
  })

  it('splits ASCII + Chinese correctly', () => {
    const tokens = tokenize('API测试')
    expect(tokens).toContain('api')
    expect(tokens).toContain('测试')
    expect(tokens).toContain('测')
    expect(tokens).toContain('试')
  })

  it('empty string returns empty', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenizeQuery('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// BM25 search
// ---------------------------------------------------------------------------

describe('BM25 search', () => {
  function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
    return {
      id: 1,
      role: 'user',
      text: 'hello world',
      searchBody: 'hello world',
      charLength: 11,
      tools: undefined,
      toolResults: undefined,
      hasThinking: false,
      truncated: false,
      ...overrides,
    }
  }

  it('builds index from entries', () => {
    const entries = [makeEntry({ id: 1, searchBody: 'fix bug in advisor' })]
    const index = buildSearchIndex(entries)
    expect(index.N).toBeGreaterThanOrEqual(1)
    expect(index.docs).toHaveLength(1)
    expect(index.df.size).toBeGreaterThan(0)
  })

  it('finds matching documents with OR', () => {
    const entries = [makeEntry({ searchBody: 'fix bug in advisor' })]
    const index = buildSearchIndex(entries)
    const results = bm25Search('fix bug', index, 5)
    expect(results.results.length).toBeGreaterThan(0)
    expect(results.totalMatches).toBe(1)
  })

  it('returns empty for non-matching query', () => {
    const entries = [makeEntry({ searchBody: 'fix bug in advisor' })]
    const index = buildSearchIndex(entries)
    const results = bm25Search('nonexistent', index, 5)
    expect(results.results).toHaveLength(0)
  })

  it('ALL mode requires all tokens', () => {
    const entries = [makeEntry({ searchBody: 'fix bug in advisor' })]
    const index = buildSearchIndex(entries)
    const allResults = bm25Search('fix bug', index, 5, 'all')
    expect(allResults.totalMatches).toBe(1)
    const missResults = bm25Search('fix unicorn', index, 5, 'all')
    expect(missResults.totalMatches).toBe(0)
  })

  it('ranks relevant documents above irrelevant ones', () => {
    const entries = [
      makeEntry({ id: 1, searchBody: 'snapshot cache fingerprint' }),
      makeEntry({ id: 2, searchBody: 'also mentions snapshot here' }),
    ]
    const index = buildSearchIndex(entries)
    const results = bm25Search('cache fingerprint', index, 5, 'all')
    // Entry 1 has both "cache" and "fingerprint", entry 2 has neither
    expect(results.results.length).toBe(1)
    expect(results.results[0]!.entry.id).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: index action
// ---------------------------------------------------------------------------

describe('ConversationLogTool index', () => {
  function makeEntries(count: number): ConversationEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Message ${i + 1} content here for testing purposes`,
      searchBody: `Message ${i + 1} content`,
      charLength: 40 + (i % 10) * 100,
      tools: i % 3 === 0 ? ['Read'] : undefined,
      toolResults: undefined,
      hasThinking: i % 4 === 0,
      truncated: i > 80,
    }))
  }

  it('returns "No conversation history available" for empty entries', async () => {
    const index = buildSearchIndex([])
    const { tool } = createConversationLogTool([], index)
    const result = await tool.call({ action: 'index' })
    expect(result.data).toContain('No conversation history available.')
  })

  it('returns manifest for non-empty entries', async () => {
    const entries = makeEntries(10)
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'index', limit: 5 })
    expect(typeof result.data).toBe('string')
    expect(result.data).toContain('Conversation log manifest')
    expect(result.data).toContain('[10]')
  })

  it('respects offset beyond total', async () => {
    const entries = makeEntries(5)
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'index', offset: 100 })
    expect(result.data).toContain('is beyond')
  })

  it('output fits within 60K budget', async () => {
    const entries = makeEntries(500)
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'index', limit: 500 })
    expect(typeof result.data).toBe('string')
    // Must not exceed the declared budget
    expect((result.data as string).length).toBeLessThanOrEqual(60_000)
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: search action
// ---------------------------------------------------------------------------

describe('ConversationLogTool search', () => {
  it('handles search with no results', async () => {
    const entries: ConversationEntry[] = [{
      id: 1,
      role: 'user',
      text: 'hello',
      searchBody: 'hello',
      charLength: 5,
      truncated: false,
    }]
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'search', query: 'zzzmissing', top_k: 5 })
    expect(result.data).toContain('No conversation messages matched')
  })

  it('rejects query with > 64 unique tokens', async () => {
    const index = buildSearchIndex([])
    const { tool } = createConversationLogTool([], index)
    const longQuery = Array.from({ length: 65 }, (_, i) => `word${i}`).join(' ')
    const result = await tool.call({ action: 'search', query: longQuery, top_k: 5 })
    expect(result.data).toContain('max 64')
  })

  it('filters by role', async () => {
    const entries: ConversationEntry[] = [
      { id: 1, role: 'user', text: 'user query', searchBody: 'user query', charLength: 10, truncated: false },
      { id: 2, role: 'assistant', text: 'assistant reply', searchBody: 'assistant reply', charLength: 15, truncated: false },
      { id: 3, role: 'tool_result', text: 'tool result', searchBody: 'tool result', charLength: 11, truncated: false },
    ]
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'search', query: 'query reply result', top_k: 10, roles: ['user'] })
    expect(result.data).toContain('[1]')
    expect(result.data).not.toContain('[2]')
    expect(result.data).not.toContain('[3]')
  })

  it('search output fits within 60K budget', async () => {
    const entries: ConversationEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      role: 'assistant' as const,
      text: `entry ${i + 1} `.repeat(20),
      searchBody: `entry ${i + 1} `.repeat(20),
      charLength: 200,
      tools: ['Read', 'Grep'],
      truncated: false,
    }))
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'search', query: 'entry', top_k: 50 })
    expect(typeof result.data).toBe('string')
    expect((result.data as string).length).toBeLessThanOrEqual(60_000)
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: read action
// ---------------------------------------------------------------------------

describe('ConversationLogTool read', () => {
  function makeEntries(count: number): ConversationEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      role: 'assistant' as const,
      text: `Content of message ${i + 1}.\n`.repeat(5),
      searchBody: `Content of message ${i + 1}.`,
      charLength: 150,
      truncated: false,
    }))
  }

  it('reads existing message IDs', async () => {
    const entries = makeEntries(10)
    const index = buildSearchIndex(entries)
    const { tool, getUniqueReadCount } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'read', message_ids: [1, 3, 5] })
    expect(result.data).toContain('[1]')
    expect(result.data).toContain('[3]')
    expect(result.data).toContain('[5]')
    // Only full reads count
    expect(getUniqueReadCount()).toBe(3)
  })

  it('reports NOT FOUND for out-of-range IDs', async () => {
    const entries = makeEntries(5)
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'read', message_ids: [999] })
    expect(result.data).toContain('NOT FOUND')
  })

  it('deduplicates repeated IDs in read count', async () => {
    const entries = makeEntries(10)
    const index = buildSearchIndex(entries)
    const { tool, getUniqueReadCount } = createConversationLogTool(entries, index)
    await tool.call({ action: 'read', message_ids: [1, 1, 1] })
    expect(getUniqueReadCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Snapshot fingerprint consistency
// ---------------------------------------------------------------------------

describe('snapshot fingerprint', () => {
  it('getConversationSnapshot returns entries and index', async () => {
    const { getConversationSnapshot } = await import('./conversationLog/snapshot.js')
    const result = getConversationSnapshot([])
    expect(result.entries).toEqual([])
    expect(result.index).toBeDefined()
    expect(result.index.N).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatEntryLabel
// ---------------------------------------------------------------------------

describe('formatEntryLabel', () => {
  it('formats user message', () => {
    const entry: ConversationEntry = { id: 1, role: 'user', text: 'hello', searchBody: 'hello', charLength: 5, truncated: false }
    expect(formatEntryLabel(entry)).toBe('USER')
  })

  it('formats assistant label', () => {
    const entry: ConversationEntry = { id: 1, role: 'assistant', text: 'ok', searchBody: 'ok', charLength: 2, truncated: false }
    expect(formatEntryLabel(entry)).toBe('ASSISTANT')
  })

  it('formats assistant thinking-only label', () => {
    const entry: ConversationEntry = { id: 1, role: 'assistant', text: '', searchBody: '', charLength: 0, hasThinking: true, truncated: false }
    expect(formatEntryLabel(entry)).toBe('ASSISTANT(thinking)')
  })

  it('formats tool_result with success mark', () => {
    const entry: ConversationEntry = {
      id: 1, role: 'tool_result', text: '', searchBody: '', charLength: 0,
      toolResults: [{ toolName: 'Read', isError: false }], truncated: false,
    }
    const label = formatEntryLabel(entry)
    expect(label).toContain('TOOL_RESULT')
    expect(label).toContain('Read')
    expect(label).toContain('\u2713')
  })

  it('formats tool_result with error mark', () => {
    const entry: ConversationEntry = {
      id: 1, role: 'tool_result', text: '', searchBody: '', charLength: 0,
      toolResults: [{ toolName: 'Read', isError: true }], truncated: false,
    }
    const label = formatEntryLabel(entry)
    expect(label).toContain('Read')
    expect(label).toContain('\u2717')
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: around action
// ---------------------------------------------------------------------------

describe('ConversationLogTool around', () => {
  const entries: ConversationEntry[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    role: 'assistant' as const,
    text: `Message ${i + 1} body content.`,
    searchBody: `message ${i + 1}`,
    charLength: 25,
    truncated: false,
  }))

  it('reads context around a message', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'around', message_id: 5, before: 2, after: 2 })
    expect(result.data).toContain('[3]')
    expect(result.data).toContain('[4]')
    expect(result.data).toContain('[5]')
    expect(result.data).toContain('[6]')
    expect(result.data).toContain('[7]')
    // Should not include IDs outside range
    expect(result.data).not.toContain('[1]')
    expect(result.data).not.toContain('[10]')
  })

  it('clamps around range at boundaries', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'around', message_id: 1, before: 5, after: 2 })
    expect(result.data).toContain('[1]')
    expect(result.data).toContain('[3]')
    expect(result.data).not.toContain('[0]')
  })

  it('reports not found for missing ID', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'around', message_id: 999 })
    expect(result.data).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: read continuation
// ---------------------------------------------------------------------------

describe('ConversationLogTool read continuation', () => {
  const longText = 'A'.repeat(500) + 'B'.repeat(500)
  const entries: ConversationEntry[] = [{
    id: 1,
    role: 'assistant',
    text: longText,
    searchBody: 'long message',
    charLength: longText.length,
    truncated: false,
  }]

  it('reads from char_offset', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result1 = await tool.call({ action: 'read', message_ids: [1] })
    const result2 = await tool.call({ action: 'read', message_ids: [1], char_offset: 500 })

    // First read should contain A...A content
    expect(result1.data).toContain('AAA')
    // Continuation should start from the B region
    expect(result2.data).toContain('BBB')
    expect(result2.data).toContain('[offset=500]')
  })

  it('respects char_limit', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'read', message_ids: [1], char_limit: 300 })
    expect(typeof result.data).toBe('string')
    // Strict: output must not exceed the declared limit
    expect((result.data as string).length).toBeLessThanOrEqual(300)
  })

  it('truncation includes next_offset and stays within char_limit', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'read', message_ids: [1], char_limit: 300 })
    expect(result.data).toContain('next_offset=')
    expect(result.data).toContain('output truncated')
    // Strict: output must not exceed the declared limit
    expect((result.data as string).length).toBeLessThanOrEqual(300)
    // next_offset must be strictly after the input offset
    const match = (result.data as string).match(/next_offset=(\d+)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThan(0)
  })

  it('continuation read does not show content before offset', async () => {
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'read', message_ids: [1], char_offset: 500 })
    // Continuation should NOT show 'AAA' prefix
    expect(result.data).not.toContain('AAA')
    expect(result.data).toContain('BBB')
  })

  it('omits an oversized searchText footer without a false continuation', async () => {
    const footerOnly: ConversationEntry[] = [{
      id: 1,
      role: 'assistant',
      text: '',
      searchBody: '',
      searchText: 'tool-input '.repeat(200),
      charLength: 0,
      truncated: false,
    }]
    const index = buildSearchIndex(footerOnly)
    const { tool } = createConversationLogTool(footerOnly, index)
    const result = await tool.call({ action: 'read', message_ids: [1], char_limit: 300 })
    expect(result.data).toContain('[1] assistant')
    expect(result.data).not.toContain('next_offset=')
    expect(result.data).not.toContain('tool inputs for search')
    expect((result.data as string).length).toBeLessThanOrEqual(300)
  })
})

// ---------------------------------------------------------------------------
// ConversationLogTool: search filter before top_k
// ---------------------------------------------------------------------------

describe('ConversationLogTool search filtering', () => {
  it('filters before top_k — finds result outside topK', async () => {
    // 10 assistant entries with high TF of the query term ("match"),
    // 1 user entry with only one occurrence. The user should score
    // lower and rank outside top 5.
    const entries: ConversationEntry[] = []
    for (let i = 1; i <= 10; i++) {
      entries.push({
        id: i, role: 'assistant',
        text: 'match '.repeat(5),
        searchBody: 'match '.repeat(5),
        charLength: 30, truncated: false,
      })
    }
    // User entry: lower TF, higher ID (tie-break: newer wins)
    entries.push({
      id: 99, role: 'user',
      text: 'match',
      searchBody: 'match',
      charLength: 5, truncated: false,
    })

    const index = buildSearchIndex(entries)
    // Sanity: unfiltered top 5 should NOT include [99]
    const unfiltered = bm25Search('match', index, 5)
    const unfilteredIds = unfiltered.results.map(r => r.entry.id)
    expect(unfilteredIds).not.toContain(99)

    // Filtered should still find [99]
    const filtered = bm25Search('match', index, 5, 'or', e => e.role === 'user')
    expect(filtered.results.map(r => r.entry.id)).toContain(99)
    expect(filtered.totalMatches).toBe(1)

    // Integration: tool call with role filter
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'search', query: 'match', top_k: 5, roles: ['user'] })
    expect(result.data).toContain('[99]')
  })

  it('after_id filters correctly', async () => {
    const entries: ConversationEntry[] = [
      { id: 1, role: 'user', text: 'match', searchBody: 'match', charLength: 5, truncated: false },
      { id: 5, role: 'user', text: 'match', searchBody: 'match', charLength: 5, truncated: false },
      { id: 10, role: 'user', text: 'match', searchBody: 'match', charLength: 5, truncated: false },
    ]
    const index = buildSearchIndex(entries)
    const { tool } = createConversationLogTool(entries, index)
    const result = await tool.call({ action: 'search', query: 'match', top_k: 10, after_id: 3 })
    expect(result.data).toContain('[5]')
    expect(result.data).toContain('[10]')
    expect(result.data).not.toContain('[1]')
  })
})
