import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  getAdvisorModel,
  isAdvisorEnabled,
} from '../../utils/advisor.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  extractTag,
  extractTextContent,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { isAbortError } from '../../utils/errors.js'
import { checkReadOnlyConstraints } from '../BashTool/readOnlyValidation.js'
import { commandHasAnyCd } from '../BashTool/bashPermissions.js'
import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_NAME,
  ADVISOR_TOOL_DESCRIPTION,
  CONVERSATION_LOG_TOOL_NAME,
} from './prompt.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { WebSearchTool } from '../WebSearchTool/WebSearchTool.js'
import { WebFetchTool } from '../WebFetchTool/WebFetchTool.js'
import { ListMcpResourcesTool } from '../ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '../ReadMcpResourceTool/ReadMcpResourceTool.js'

// Read-only built-in tools the advisor subagent can use.
// Canonical identity check first (Set.has via reference equality) — catches MCP
// tools and plugins even if they share the name. Falls back to name matching
// with structural guards for provider-wrapped tools (e.g. OpenAI compat layer
// rewraps tools into `functions.Read` objects with different references).
const READ_ONLY_BUILTIN_TOOLS = new Set<Tool>([
  BashTool,
  FileReadTool,
  GrepTool,
  GlobTool,
  WebSearchTool,
  WebFetchTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
])

const READ_ONLY_BUILTIN_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'ListMcpResources',
  'ReadMcpResource',
])

/** Returns true when a tool is a built-in (non-MCP) read-only tool the advisor may use. */
function isAdvisorAllowedBuiltin(tool: Tool): boolean {
  // Canonical identity: exact singleton reference (catches MCP spoofing).
  if (READ_ONLY_BUILTIN_TOOLS.has(tool)) return true
  // Provider-wrapped tools (e.g. OpenAI compat): check name + structural guards.
  if ((tool as any).mcpInfo !== undefined) return false
  if ((tool as any).isMcp === true) return false
  return READ_ONLY_BUILTIN_TOOL_NAMES.has(tool.name)
}

const CONVERSATION_LOG_READ_LIMIT = 20
const CONVERSATION_LOG_TOTAL_CHARS = 80_000
const CONVERSATION_LOG_RESULT_CHARS = 8_000    // Per tool-result cap
const CONVERSATION_LOG_SEARCH_SNIPPET_CHARS = 2_000
const ADVISOR_MAX_TURNS = 200

const inputSchema = z.strictObject({
  question: z
    .string()
    .describe(
      'What do you need advice on? Describe the problem, what you are trying to do, ' +
        'what you have already tried, any constraints, and what you specifically ' +
        'want the advisor to answer.',
    ),
})

type InputSchema = typeof inputSchema

const outputSchema = z.strictObject({
  advice: z.string().describe('The advice from the advisor model'),
  contextMessagesAvailable: z
    .number()
    .int()
    .min(0)
    .describe('Number of conversation messages available for the advisor to read via ReadConversationLog.'),
  conversationsRead: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of conversation messages the advisor actually read.'),
  filesRead: z
    .number()
    .int()
    .min(0)
    .describe('Number of files the advisor read during its analysis.'),
  toolsCalled: z
    .number()
    .int()
    .min(0)
    .describe('Total number of tool calls the advisor made.'),
  tokens: z
    .number()
    .min(0)
    .default(0)
    .describe('Total tokens consumed.'),
  durationMs: z
    .number()
    .min(0)
    .default(0)
    .describe('Total wall-clock duration in milliseconds.'),
  webSearched: z
    .boolean()
    .default(false)
    .describe('Whether the advisor performed a web search.'),
  blocks: z
    .array(z.object({
      type: z.enum(['tool', 'text']),
      text: z.string(),
    }))
    .default([])
    .describe('The raw content blocks from the advisor query, in order.'),
  toolCallSequence: z
    .array(z.string())
    .optional()
    .describe('Deprecated. Use blocks instead.'),
  interrupted: z
    .boolean()
    .default(false)
    .describe('Whether the advisor query was interrupted before completion.'),
  model: z
    .string()
    .optional()
    .describe('The advisor model used for this query.'),
})
type Output = z.infer<typeof outputSchema>

// ---------------------------------------------------------------------------
// Conversation log — in-memory snapshot + lazy-read tool
// ---------------------------------------------------------------------------

type ConversationEntry = {
  id: number
  role: 'user' | 'assistant' | 'tool_result'
  text: string
  charLength: number
  tools?: string[]
  toolResults?: {
    toolUseId: string
    toolName?: string
    isError: boolean
  }[]
  hasThinking?: boolean
  truncated: boolean
  /** Tool input text for BM25 search (not displayed in read output). */
  searchText?: string
}

// ---------------------------------------------------------------------------
// BM25 search index
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Split camelCase and acronym boundaries before lowercasing
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const lowered = camelSplit.toLowerCase()
  const asciiTokens = lowered.split(/[^a-z0-9]+/).filter(t => t.length > 0)

  // CJK bigrams for basic Chinese/Japanese/Korean substring matching.
  // A single unspaced CJK sentence is one token under ascii rules; bigrams
  // allow multi-character queries like "分页" to match "实现分页功能".
  const cjkTokens: string[] = []
  const cjkOnly = text.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, '')
  if (cjkOnly.length >= 2) {
    for (let i = 0; i < cjkOnly.length - 1; i++) {
      cjkTokens.push(cjkOnly.slice(i, i + 2).toLowerCase())
    }
  }

  return [...asciiTokens, ...cjkTokens]
}

/** Tokenize a tool name — must use the same tokenizer as queries. */
function tokenizeToolName(name: string): string[] {
  return tokenize(name)
}

interface SearchDoc {
  entry: ConversationEntry
  tokens: string[]
  tf: Map<string, number>
  /** Tokens from visible message text (displayed in read output). */
  bodyTokens: Set<string>
  /** Tokens from tool names / tool-result metadata (visible in index labels). */
  metadataTokens: Set<string>
  /** Tokens found in hidden tool-use input/searchText. */
  searchTextTokens: Set<string>
}

interface SearchIndex {
  docs: SearchDoc[]
  df: Map<string, number>
  avgdl: number
  N: number
}

function buildSearchIndex(entries: ConversationEntry[]): SearchIndex {
  const docs: SearchDoc[] = []
  const df = new Map<string, number>()
  let totalTokens = 0

  for (const entry of entries) {
    const tokens: string[] = []
    const bodyTokens = new Set<string>()
    const metadataTokens = new Set<string>()
    const searchTextTokens = new Set<string>()

    // Entry text — displayed in read output
    for (const t of tokenize(entry.text)) {
      tokens.push(t)
      bodyTokens.add(t)
    }

    // Tool-use input snippets — searchable but hidden
    if (entry.searchText) {
      for (const t of tokenize(entry.searchText)) {
        tokens.push(t)
        searchTextTokens.add(t)
      }
    }

    // Tool names — displayed in index/search result labels (visible metadata)
    if (entry.tools) {
      for (const name of entry.tools) {
        for (const t of tokenizeToolName(name)) {
          tokens.push(t)
          metadataTokens.add(t)
        }
      }
    }

    // Tool result names + error status — displayed in result labels
    if (entry.toolResults) {
      for (const r of entry.toolResults) {
        if (r.toolName) {
          for (const t of tokenizeToolName(r.toolName)) {
            tokens.push(t)
            metadataTokens.add(t)
          }
        }
        if (r.isError) {
          tokens.push('error')
          metadataTokens.add('error')
        }
      }
    }

    if (tokens.length === 0) continue

    const tf = new Map<string, number>()
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }

    const termSet = new Set(tokens)
    for (const t of termSet) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }

    docs.push({ entry, tokens, tf, bodyTokens, metadataTokens, searchTextTokens })
    totalTokens += tokens.length
  }

  return {
    docs,
    df,
    avgdl: docs.length > 0 ? totalTokens / docs.length : 0,
    N: docs.length,
  }
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const BM25_SEARCH_TEXT_ONLY_PENALTY = 0.5
const BM25_AND_COORDINATION_BONUS = 1.1

function bm25Score(
  queryTokens: string[],
  doc: SearchDoc,
  index: SearchIndex,
): number {
  let score = 0
  const dl = doc.tokens.length

  for (const qt of queryTokens) {
    const df = index.df.get(qt)
    if (!df) continue
    const tf = doc.tf.get(qt)
    if (!tf) continue

    // Positive IDF variant
    const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5))
    const numerator = tf * (BM25_K1 + 1)
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / index.avgdl))
    score += idf * (numerator / denominator)
  }

  // Coordination bonus: slightly prefer docs matching ALL query terms
  if (queryTokens.length > 1) {
    const matchedCount = queryTokens.filter(qt => doc.tf.has(qt)).length
    if (matchedCount === queryTokens.length) {
      score *= BM25_AND_COORDINATION_BONUS
    }
  }

  // Hidden-input penalty: a document where every matched token comes from
  // tool-input/searchText only (none from visible body text or metadata)
  // should not outrank messages with visible explanatory content.
  let matchedAny = false
  let allFromSearchText = true
  for (const qt of queryTokens) {
    if (!doc.tf.has(qt)) continue
    matchedAny = true
    if (doc.bodyTokens.has(qt) || doc.metadataTokens.has(qt)) {
      allFromSearchText = false
      break
    }
    if (!doc.searchTextTokens.has(qt)) {
      allFromSearchText = false
      break
    }
  }
  if (matchedAny && allFromSearchText) {
    score *= BM25_SEARCH_TEXT_ONLY_PENALTY
  }

  return score
}

interface SearchResult {
  entry: ConversationEntry
  score: number
  matchedTokens: string[]
  excerpt?: string
}

interface SearchResponse {
  results: SearchResult[]
  totalMatches: number
}

function buildSearchExcerpt(
  doc: SearchDoc,
  matchedTokens: string[],
): string | undefined {
  // 1. Matches in body text — show context around the first matching token
  for (const token of matchedTokens) {
    if (!doc.bodyTokens.has(token)) continue
    const lower = doc.entry.text.toLowerCase()
    const idx = lower.indexOf(token)
    if (idx !== -1) {
      const start = Math.max(0, idx - 30)
      const end = Math.min(lower.length, idx + token.length + 30)
      const excerpt = doc.entry.text.slice(start, end).replace(/\s+/g, ' ')
      return excerpt
    }
  }
  // 2. All matches are in displayed metadata (tool names, result status)
  // — no excerpt needed; the index label already shows this
  if (matchedTokens.every(t => doc.metadataTokens.has(t))) {
    return undefined
  }
  // 3. Matches in hidden tool input
  for (const token of matchedTokens) {
    if (!doc.searchTextTokens.has(token)) continue
    if (doc.entry.searchText) {
      const lower = doc.entry.searchText.toLowerCase()
      const idx = lower.indexOf(token)
      if (idx !== -1) {
        const start = Math.max(0, idx - 30)
        const end = Math.min(lower.length, idx + token.length + 30)
        const excerpt = doc.entry.searchText.slice(start, end).replace(/\s+/g, ' ')
        return `tool input: ${excerpt}`
      }
    }
  }
  return undefined
}

function bm25Search(
  query: string,
  index: SearchIndex,
  topK: number,
  matchMode: 'or' | 'all' = 'or',
): SearchResponse {
  if (index.docs.length === 0) return { results: [], totalMatches: 0 }

  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return { results: [], totalMatches: 0 }

  const scored = index.docs.map(doc => ({
    doc,
    entry: doc.entry,
    score: bm25Score(queryTokens, doc, index),
    matchedTokens: queryTokens.filter(token => doc.tf.has(token)),
  }))

  let matched = scored.filter(s => s.score > 0)

  // 'all' mode: only documents where every query token matched
  if (matchMode === 'all') {
    matched = matched.filter(s => s.matchedTokens.length === queryTokens.length)
  }
  if (matched.length === 0) return { results: [], totalMatches: 0 }

  matched.sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
  const top = matched.slice(0, topK)
  const maxScore = top[0]!.score

  return {
    results: top.map(s => ({
      entry: s.entry,
      score: Number.isFinite(maxScore as number) && maxScore > 0
        ? s.score / maxScore
        : 0,
      matchedTokens: s.matchedTokens,
      excerpt: buildSearchExcerpt(s.doc, s.matchedTokens),
    })),
    totalMatches: matched.length,
  }
}

// Shared helper for role/tool-status labels used by both formatConversationIndex and formatSearchResults
function formatEntryLabel(e: ConversationEntry): string {
  let status = ''
  if (e.role === 'tool_result' && e.toolResults && e.toolResults.length > 0) {
    const parts = e.toolResults.map(r => {
      const prefix = r.toolName ?? '?'
      return `${prefix} ${r.isError ? '\u2717' : '\u2713'}`
    })
    status = ` ${parts.join(', ')}`
  }
  const roleLabel =
    e.role === 'user' ? 'USER'
    : e.role === 'assistant'
      ? (e.hasThinking && e.charLength === 0 && !e.tools && !e.toolResults
        ? 'ASSISTANT(thinking)' : 'ASSISTANT')
    : `TOOL_RESULT${status}`
  return roleLabel
}

function formatSearchResults(
  query: string,
  results: SearchResult[],
  totalIndexed: number,
  totalMatches?: number,
): string {
  const exclusionNote =
    'Note: Thinking-only entries and empty entries without searchable ' +
    'metadata are excluded from search.'

  if (results.length === 0) {
    const searched = totalIndexed > 0
      ? ` Searched ${totalIndexed} messages.`
      : ''
    return (
      `No conversation messages matched "${query}".${searched}\n\n${exclusionNote}`
    )
  }

  const matchInfo =
    totalMatches !== undefined
      ? `searched ${totalIndexed} messages; ${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}`
      : `searched ${totalIndexed} messages`

  const header =
    `# Search results for "${query}" — showing ${results.length} results (${matchInfo})`

  const lines = results.map(r => {
    const label = formatEntryLabel(r.entry)
    const toolInfo = r.entry.tools ? ` [tools: ${r.entry.tools.join(', ')}]` : ''
    const trunc = r.entry.truncated ? ' (truncated)' : ''
    const matchedInfo = ` [matched: ${r.matchedTokens.join(', ')}]`
    const excerpt = r.excerpt ? ` "${r.excerpt}"` : ''
    return `[${r.entry.id}] ${label} (${r.score.toFixed(3)} score) (${r.entry.charLength} chars)${toolInfo}${matchedInfo}${trunc}${excerpt}`
  })
  const ids = results.map(r => r.entry.id)
  const hint = results.length > 0
    ? `\n\nUse action="read" with message_ids=[${ids.join(', ')}] to fetch full content.`
    : ''
  return `${header}\n\n${exclusionNote}\n\n${lines.join('\n')}${hint}`
}

// ---------------------------------------------------------------------------
// Serialization cache
// ---------------------------------------------------------------------------
let _cachedEntries: ConversationEntry[] | null = null
let _cachedFingerprint = ''

function serializeConversationLog(
  messages: readonly Message[],
): ConversationEntry[] {
  const fp = messages.map((m: any) => m.uuid ?? '').join(':')
  if (fp === _cachedFingerprint && _cachedEntries) return _cachedEntries

  // Map tool_use_id → tool name for per-result metadata
  const toolNameMap = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = (msg.message as any)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolNameMap.set(block.id, block.name)
      }
    }
  }

  const entries = doSerializeConversationLog(messages, toolNameMap)
  _cachedEntries = entries
  _cachedFingerprint = fp
  return entries
}

function doSerializeConversationLog(
  messages: readonly Message[],
  toolNameMap: Map<string, string>,
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.type !== 'user' && msg.type !== 'assistant') continue

    const rawContent = (msg.message as any)?.content
    // Handle string content (from createUserMessage with string arg)
    if (typeof rawContent === 'string') {
      const charLength = rawContent.length
      let text = rawContent
      let truncated = false
      if (charLength > 16000) {
        text = rawContent.slice(0, 16000) + '\n\n[...truncated]'
        truncated = true
      }
      entries.push({
        id: i,
        role: msg.type,
        text,
        charLength,
        truncated,
      })
      continue
    }

    if (!rawContent || !Array.isArray(rawContent)) continue

    const content = rawContent as any[]
    const textParts: string[] = []
    const tools: string[] = []
    const searchSnippets: string[] = []
    const toolResults: { toolUseId: string; toolName?: string; isError: boolean }[] = []
    let hasThinking = false
    let truncated = false

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        tools.push(block.name || 'unknown')
        // Capture tool-use input for BM25 search (bounded to prevent bloat)
        if (block.input && typeof block.input === 'object') {
          const inputStr = JSON.stringify(block.input)
          searchSnippets.push(inputStr.slice(0, CONVERSATION_LOG_SEARCH_SNIPPET_CHARS))
        }
      } else if (block.type === 'tool_result') {
        toolResults.push({
          toolUseId: block.tool_use_id ?? '',
          toolName: toolNameMap.get(block.tool_use_id),
          isError: !!block.is_error,
        })
        // tool_result.content can be string | ContentBlockParam[]
        const tc = block.content
        let resultText = ''
        if (typeof tc === 'string') {
          resultText = tc
        } else if (Array.isArray(tc)) {
          resultText = extractTextContent(tc, ' ')
        }
        if (resultText) {
          const label = block.is_error ? 'tool_result_error' : 'tool_result'
          textParts.push(`[${label}: ${resultText.slice(0, CONVERSATION_LOG_RESULT_CHARS)}]`)
        } else if (block.is_error) {
          textParts.push(`[tool_result_error]`)
        }
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        hasThinking = true
      } else if (block.type === 'image' || block.type === 'image_url') {
        // Emit a compact marker — actual base64 data is too large for the log
        textParts.push(`[${block.type}]`)
      }
    }

    let text = textParts.join('\n')
    const charLength = text.length
    if (charLength > 16000) {
      text = text.slice(0, 16000) + '\n\n[...truncated]'
      truncated = true
    }

    entries.push({
      id: i,
      role: msg.type === 'user' && toolResults.length > 0 ? 'tool_result' : msg.type,
      text,
      charLength,
      tools: tools.length > 0 ? tools : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      hasThinking: hasThinking || undefined,
      searchText: searchSnippets.length > 0 ? searchSnippets.join(' ') : undefined,
      truncated,
    })
  }
  return entries
}

function formatConversationIndex(
  entries: ConversationEntry[],
  offset?: number,
  limit?: number,
): string {
  if (entries.length === 0) return 'No conversation history available.'

  // Default: show the most recent messages (newest first = highest IDs).
  const effectiveLimit = Math.max(1, Math.min(limit ?? 200, 500))
  const effectiveOffset = Math.max(0, offset ?? 0)
  const total = entries.length

  // Slice from the end so the most recent messages appear first
  const startIdx = Math.max(0, total - effectiveOffset - effectiveLimit)
  const endIdx = total - effectiveOffset
  const page = entries.slice(startIdx, endIdx).reverse()

  const hasMorePages = startIdx > 0
  const hasNewer = effectiveOffset > 0
  const nextOffset = effectiveOffset + effectiveLimit

  const header = hasNewer
    ? `# Conversation log manifest (${total} messages available, ${effectiveOffset} skipped, showing ${startIdx}-${endIdx - 1})`
    : `# Conversation log manifest (${total} messages available, showing ${startIdx}-${endIdx - 1})`

  const lines = page.map(e => {
    const label = formatEntryLabel(e)
    const toolInfo = e.tools ? ` [tools: ${e.tools.join(', ')}]` : ''
    const trunc = e.truncated ? ' (truncated)' : ''
    return `[${e.id}] ${label} (${e.charLength} chars)${toolInfo}${trunc}`
  })

  if (hasNewer) {
    lines.unshift(`↑ ${effectiveOffset} newer messages above (use offset=0 to go back to latest)`)
  }
  if (hasMorePages) {
    lines.push(`↓ ${startIdx} earlier messages below (use offset=${nextOffset} to page further back)`)
  }

  return `${header}\n\n${lines.join('\n')}`
}

function createConversationLogTool(entries: ConversationEntry[]) {
  const entryMap = new Map(entries.map(e => [e.id, e]))
  const searchIndex = buildSearchIndex(entries)
  // Track which unique IDs were successfully read (for conversationsRead stats)
  const uniqueReadIds = new Set<number>()

  const tool = buildTool({
    name: CONVERSATION_LOG_TOOL_NAME,

    async description() {
      return `Read the main agent's conversation history after the latest compact boundary. Use action="index" to browse, "search" to find messages by keyword, then "read" with message IDs.`
    },

    async prompt() {
      return `Read conversation history of the main agent. All post-compaction user and assistant messages are available. Use action: "index" to list recent messages, action: "search" to locate messages by keyword, and action: "read" with message_ids to fetch details for the ones you need.`
    },

    inputSchema: z.strictObject({
      action: z.enum(['index', 'read', 'search']).describe(
        '"index" lists available messages (newest first, most recent 200 by default). Use offset/limit to page. "read" fetches full content for specific message IDs. "search" finds messages matching a query via keyword-based ranking.',
      ),
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Text to search for. Required when action is "search".'),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .optional()
        .describe('Number of search results to return. Default 10, max 50.'),
      match_mode: z
        .enum(['or', 'all'])
        .default('or')
        .optional()
        .describe('"or" returns messages matching any query term (default). "all" requires every term to match.'),
      message_ids: z
        .array(z.number().int().min(0))
        .max(CONVERSATION_LOG_READ_LIMIT)
        .optional()
        .describe(`Message IDs to read. Maximum ${CONVERSATION_LOG_READ_LIMIT} per call.`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Number of most recent messages to skip (for paging back in history). Default 0.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Number of messages to show in the index. Default 200, max 500.'),
    }),

    maxResultSizeChars: CONVERSATION_LOG_TOTAL_CHARS,

    isEnabled() { return true },
    isConcurrencySafe() { return true },
    isReadOnly() { return true },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: typeof output === 'string' ? output : JSON.stringify(output),
      }
    },

    renderToolUseMessage(input) {
      const inp = input as Partial<{ action: string; message_ids?: number[]; query?: string }>
      if (inp.action === 'index') return <Text>Reading conversation index</Text>
      if (inp.action === 'search') return <Text>Searching conversation log</Text>
      const count = inp.message_ids?.length ?? 0
      return <Text>{`Reading ${count} ${count === 1 ? 'message' : 'messages'} from log`}</Text>
    },

    async call(input: { action: 'index' | 'read' | 'search'; message_ids?: number[]; offset?: number; limit?: number; query?: string; top_k?: number; match_mode?: 'or' | 'all' }) {
      if (input.action === 'index') {
        return { data: formatConversationIndex(entries, input.offset, input.limit) }
      }
      if (input.action === 'search') {
        if (!input.query) return { data: 'Query is required for search action.' }
        const response = bm25Search(input.query, searchIndex, input.top_k ?? 10, input.match_mode ?? 'or')
        return { data: formatSearchResults(input.query, response.results, searchIndex.N, response.totalMatches) }
      }
      if (input.action === 'read') {
        const ids = input.message_ids ?? []
        if (ids.length === 0) return { data: 'No message IDs specified.' }
        const seen = new Set<number>()
        // De-duplicate while preserving order; count unique valid IDs
        let totalChars = 0
        const results: string[] = []
        for (const id of ids) {
          if (seen.has(id)) continue
          seen.add(id)
          const entry = entryMap.get(id)
          if (!entry) {
            results.push(`[${id}] NOT FOUND — ID out of range`)
            continue
          }
          uniqueReadIds.add(id)
          const truncTag = entry.truncated ? ' [truncated]' : ''
          const line = `[${id}] ${entry.role} (${entry.charLength} chars)${truncTag}:\n\n${entry.text}`
          totalChars += line.length
          if (totalChars > CONVERSATION_LOG_TOTAL_CHARS) {
            results.push(line.slice(0, CONVERSATION_LOG_TOTAL_CHARS - totalChars + line.length) + '\n\n[...output truncated]')
            break
          }
          results.push(line)
        }
        return { data: results.join('\n\n---\n\n') }
      }
      return { data: 'Unknown action. Use "index", "read", or "search".' }
    },

    userFacingName() { return CONVERSATION_LOG_TOOL_NAME },
  })

  // Attach stats tracking for runAdvisorQuery to read
  ;(tool as any).__uniqueReadIds = uniqueReadIds
  return tool
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolLabel(name: string): string {
  if (name === 'Read') return 'Reading'
  if (name === 'Grep') return 'Searching'
  if (name === 'Glob') return 'Finding files'
  if (name === 'WebSearch') return 'Searching web'
  if (name === 'WebFetch') return 'Fetching URL'
  if (name === 'Bash') return 'Running'
  if (name === CONVERSATION_LOG_TOOL_NAME) {
    // renderToolUseMessage already handles index/search/read visually
    return 'Reading log'
  }
  return name
}

function truncateInput(input: unknown, maxLen: number): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

function formatToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return truncateInput(input, 60)
  const obj = input as Record<string, unknown>
  if (toolName === 'Read' && typeof obj.file_path === 'string') return obj.file_path
  if (toolName === 'Grep' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'WebSearch' && typeof obj.query === 'string') return truncateInput(obj.query, 80)
  if (toolName === 'WebFetch' && typeof obj.url === 'string') return obj.url
  if (toolName === 'Glob' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'Bash' && typeof obj.command === 'string') return truncateInput(obj.command, 80)
  if (toolName === CONVERSATION_LOG_TOOL_NAME) {
    if (obj.action === 'search') return `"${truncateInput(obj.query, 60)}"`
    if (obj.action === 'index') return '(index)'
    if (obj.action === 'read' && Array.isArray(obj.message_ids)) return `[${(obj.message_ids as number[]).join(', ')}]`
    return '(log)'
  }
  return truncateInput(input, 60)
}

type LiveAdvisorInfo = {
  model: string
  conversationMessagesRead: number
  toolUseCount: number
  fileReadCount: number
  webSearched: boolean
  lastTool: string
  lastInput: Record<string, unknown>
  startTime: number
}

function buildLiveBox(info: LiveAdvisorInfo): { jsx: JSX.Element; shouldHidePromptInput: false; shouldContinueAnimation: true; showSpinner: true } {
  const parts: string[] = []
  if (info.webSearched) parts.push('web searched')
  if (info.conversationMessagesRead > 0) parts.push(`${info.conversationMessagesRead} ${info.conversationMessagesRead === 1 ? 'message read' : 'messages read'}`)
  if (info.toolUseCount > 0) parts.push(`${info.toolUseCount} ${info.toolUseCount === 1 ? 'tool use' : 'tool uses'}`)
  if (info.fileReadCount > 0) parts.push(`${info.fileReadCount} ${info.fileReadCount === 1 ? 'file read' : 'files read'}`)
  const elapsed = Date.now() - info.startTime
  if (elapsed > 1000) parts.push(formatDuration(elapsed))
  const header = parts.length > 0 ? `${info.model} (${parts.join(' · ')})` : info.model
  const body = info.toolUseCount > 0
    ? `${toolLabel(info.lastTool)} ${formatToolInput(info.lastTool, info.lastInput)}`
    : 'Thinking…'
  return {
    jsx: (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{`${header}\n`}</Text>
        <Text dimColor>{body}</Text>
      </Box>
    ),
    shouldHidePromptInput: false,
    shouldContinueAnimation: true,
    showSpinner: true,
  }
}

// ---------------------------------------------------------------------------
// Context history helper
// ---------------------------------------------------------------------------

function selectAdvisorHistory(
  messages: readonly Message[],
): { messages: readonly Message[]; actualCount: number } {
  if (messages.length === 0) {
    return { messages: [], actualCount: 0 }
  }
  const afterBoundary = getMessagesAfterCompactBoundary(messages)
  const filtered = afterBoundary.filter(
    m => m.type === 'user' || m.type === 'assistant',
  )
  return { messages: filtered, actualCount: filtered.length }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const AdvisorTool = buildTool({
  name: ADVISOR_TOOL_NAME,

  get inputSchema(): InputSchema {
    return inputSchema
  },

  get outputSchema() {
    return outputSchema
  },

  isEnabled() {
    return isAdvisorEnabled()
  },

  isConcurrencySafe() {
    return false
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.question
  },

  async description() {
    const model = getAdvisorModel() || 'advisor'
    return `Consult a stronger advisor model (${model}) for strategic guidance. Use when facing architectural choices, debugging dead-ends, high-stakes changes, or security reviews.`
  },

  async prompt() {
    return ADVISOR_TOOL_DESCRIPTION
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.advice,
    }
  },

  renderToolUseErrorMessage(content, { verbose }) {
    if (!verbose && typeof content === 'string' && extractTag(content, 'tool_use_error')) {
      return <MessageResponse><Text color="error">Error calling advisor</Text></MessageResponse>
    }
    return <FallbackToolUseErrorMessage result={content} verbose={verbose ?? false} />
  },

  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
    options?: { verbose?: boolean },
  ) {
    const q = input.question || ''
    if (options?.verbose) return <Text>{q}</Text>
    const firstLine = q.split('\n')[0]
    const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine
    const needsTruncation = q.length > 100
    return <Text>{truncated}{needsTruncation ? '…' : ''}</Text>
  },

  renderToolResultMessage(
    content: Output,
    _progressMessages?: unknown,
    options?: { verbose?: boolean; input?: Record<string, unknown>; isTranscriptMode?: boolean },
  ) {
    const advice = content.advice || ''
    const model = content.model ?? getAdvisorModel() ?? 'advisor'
    const conversationsRead = content.conversationsRead ?? 0
    const filesRead = content.filesRead ?? 0
    const toolsCalled = content.toolsCalled ?? 0
    const tokens = content.tokens ?? 0
    const durationMs = content.durationMs ?? 0
    const webSearched = content.webSearched ?? false
    const interrupted = content.interrupted ?? false
    const stats = []
    if (interrupted) stats.push('interrupted')
    if (webSearched) stats.push('web searched')
    if (conversationsRead > 0) stats.push(`${conversationsRead} ${conversationsRead === 1 ? 'message read' : 'messages read'}`)
    if (toolsCalled > 0) stats.push(`${toolsCalled} ${toolsCalled === 1 ? 'tool use' : 'tool uses'}`)
    if (filesRead > 0) stats.push(`${filesRead} ${filesRead === 1 ? 'file read' : 'files read'}`)
    if (tokens > 0) {
      stats.push(`${formatNumber(tokens)} tokens`)
    } else if (toolsCalled > 0) {
      // Tools ran but usage was never reported. Provider (GPT shim via cliproxy)
      // may omit usage for multi-block responses when first-message aggregation
      // takes a zero/preliminary value. Show a diagnostic label.
      stats.push('tokens unavailable')
    }
    if (durationMs > 0) stats.push(formatDuration(durationMs))
    const header = stats.length > 0 ? `${model} (${stats.join(' · ')})` : model
    if (!advice) {
      return <Text dimColor>No response received</Text>
    }
    const children: React.ReactNode[] = []
    children.push(<Text bold>{`${header}\n`}</Text>)

    if (options?.verbose || options?.isTranscriptMode) {
      const blocks = content.blocks ?? []
      if (blocks.length > 0) {
        for (const block of blocks) {
          if (block.type === 'text') {
            children.push(<Text>{block.text + '\n'}</Text>)
          } else {
            children.push(<Text dimColor>{block.text + '\n'}</Text>)
          }
        }
      } else {
        children.push(<Text>{advice}</Text>)
      }
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {children}
        </Box>
      )
    }
    const previewLines = advice.split('\n').slice(0, 5)
    const preview = previewLines.join('\n').slice(0, 200)
    const adviceTruncated = advice.length > preview.length
    const hasToolBlocks = (content.blocks ?? []).some(b => b.type === 'tool')
    const needsExpand = adviceTruncated || hasToolBlocks
    children.push(
      <Text dimColor>{preview}{adviceTruncated ? '…' : ''}{needsExpand && <CtrlOToExpand />}</Text>,
    )
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        {children}
      </Box>
    )
  },

  async call({ question }, context) {
    const model = getAdvisorModel()
    if (!model) {
      throw new Error('Advisor is not configured. Set CLAUDE_CODE_ADVISOR_MODEL.')
    }

    const history = selectAdvisorHistory(context.messages)

    try {
      const result = await runAdvisorQuery(question, history, model, context)
      return {
        data: {
          ...result,
          contextMessagesAvailable: history.actualCount,

        },
      }
    } finally {
      if (context.setToolJSX) context.setToolJSX(null)
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// ---------------------------------------------------------------------------
// Advisor as lightweight subagent — multi-turn, tool-enabled query
// ---------------------------------------------------------------------------

async function runAdvisorQuery(
  question: string,
  history: { messages: readonly Message[]; actualCount: number },
  advisorModel: string,
  context: ToolUseContext,
): Promise<{ advice: string; filesRead: number; toolsCalled: number; tokens: number; durationMs: number; webSearched: boolean; blocks: Array<{ type: 'tool' | 'text'; text: string }>; interrupted: boolean; model: string; conversationsRead: number }> {
  const { query } = await import('../../query.js')
  const { getUserContext, getSystemContext } = await import('../../context.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')

  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])

  const { getCwd } = await import('../../utils/cwd.js')
  const cwd = getCwd()

  const systemPrompt = asSystemPrompt([
    `# Environment\nYou are running in the following environment:\nWorking directory: ${cwd}`,
    ADVISOR_SYSTEM_PROMPT,
  ])

  // Build conversation log snapshot + lazy-read tool
  const conversationEntries = serializeConversationLog(history.messages)
  const conversationTool = createConversationLogTool(conversationEntries)

  // Build identity-based allowlist from the current tool set.
  // Only built-in (non-MCP) tools are allowed — MCP tools with colliding
  // names must NOT be given built-in-tool privileges.
  const filteredTools = context.options.tools.filter(
    t => t.name !== ADVISOR_TOOL_NAME && isAdvisorAllowedBuiltin(t),
  )
  const advisorTools = [...filteredTools, conversationTool]

  const subagentCtx = createSubagentContext(context, {
    options: {
      ...context.options,
      mainLoopModel: advisorModel,
      tools: advisorTools,
      refreshTools: context.options.refreshTools
        ? () => {
            const allTools = context.options.refreshTools!()
            return [
              ...allTools.filter(
                t => t.name !== ADVISOR_TOOL_NAME && isAdvisorAllowedBuiltin(t),
              ),
              conversationTool,
            ]
          }
        : undefined,
    },
    requireCanUseTool: true,
  })

  // Only send the question — history is available via ReadConversationLog
  const queryMessages = [createUserMessage({ content: question })]

  const messages: any[] = []
  const info: LiveAdvisorInfo = {
    model: advisorModel,
    conversationMessagesRead: 0,
    toolUseCount: 0,
    fileReadCount: 0,
    webSearched: false,
    lastTool: '',
    lastInput: {} as Record<string, unknown>,
    startTime: Date.now(),
  }

  // Push live box once per second to keep the elapsed timer ticking
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const iterator = query({
    messages: queryMessages,
    systemPrompt,
    userContext,
    systemContext,
    maxTurns: ADVISOR_MAX_TURNS,
    canUseTool: async (tool, input) => {
      // Identity check: the conversation log tool is the exact object we created.
      if (tool === conversationTool) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      // Identity check: only built-in (non-MCP) tools from the allowlist.
      // Rejects MCP tools that happen to share a name with a built-in.
      if (isAdvisorAllowedBuiltin(tool as Tool)) {
        // Enforce read-only for Bash — prompt-level instructions are not a
        // security boundary. Uses the same read-only classifier as BashTool.
        if ((tool as Tool).name === 'Bash') {
          const cmd =
            typeof input === 'object' && input !== null && 'command' in input
              ? (input as any).command
              : ''
          const roCheck = checkReadOnlyConstraints(
            input as any,
            commandHasAnyCd(typeof cmd === 'string' ? cmd : ''),
          )
          if (roCheck.behavior !== 'allow') {
            return {
              behavior: 'deny' as const,
              updatedInput: input,
              message: `The advisor can only run read-only Bash commands. ` +
                `"${typeof cmd === 'string' ? cmd.slice(0, 100) : 'this command'}" was denied.`,
              decisionReason: {
                type: 'other' as const,
                reason: 'Advisor is restricted to read-only Bash commands.',
              },
            }
          }
        }
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return {
        behavior: 'deny' as const,
        updatedInput: input,
        message: `The advisor cannot use ${(tool as any).name ?? 'unknown tool'}.`,
        decisionReason: {
          type: 'other' as const,
          reason: 'Advisor tools are restricted to a read-only allowlist.',
        },
      }
    },
    toolUseContext: subagentCtx,
    querySource: 'advisor' as any,
    skipCacheWrite: true,
  })

  let terminalResult: { reason: string } | undefined
  let sawApiError = false

  // Start tick timer after iterator creation
  tickTimer = context.setToolJSX
    ? setInterval(() => { context.setToolJSX!(buildLiveBox(info)) }, 1000)
    : null

  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        terminalResult = next.value as { reason: string } | undefined
        break
      }
      const msg = next.value
      if (msg.type === 'tombstone') {
        const idx = messages.indexOf(msg.message)
        if (idx !== -1) messages.splice(idx, 1)
        continue
      }
      if (msg.type === 'assistant' || msg.type === 'user') {
        messages.push(msg)
      }
      if (msg.type === 'assistant' && (msg as any).isApiErrorMessage) {
        sawApiError = true
      }
      // Push live UI update
      if (msg.type === 'assistant') {
        const blocks_ = (msg.message as any)?.content as any[]
        if (blocks_) {
          let updated = false
          for (const b of blocks_) {
            if (b.type === 'tool_use') {
              info.toolUseCount++
              if (b.name === 'Read') info.fileReadCount++
              if (b.name === 'WebSearch') info.webSearched = true
              if (b.name === CONVERSATION_LOG_TOOL_NAME && b.input?.action === 'read') {
                info.conversationMessagesRead += (b.input?.message_ids as any[])?.length ?? 0
              }
              info.lastTool = b.name
              info.lastInput = (b.input as Record<string, unknown>) ?? {}
              updated = true
            }
          }
          if (updated && context.setToolJSX) {
            context.setToolJSX(buildLiveBox(info))
          }
        }
      }
    }
  } catch (err) {
    if (isAbortError(err) || context.abortController.signal.aborted) {
      terminalResult = { reason: 'aborted_streaming' }
    } else {
      throw err
    }
  } finally {
    if (tickTimer) clearInterval(tickTimer)
    // Ensure iterator is closed on all paths
    try { await iterator.return?.() } catch {}
  }

  if (terminalResult?.reason === 'model_error') {
    throw new Error(
      `Advisor model returned an error (reason: ${terminalResult?.reason}, ` +
      `messages received: ${messages.length}).`,
    )
  }
  if (sawApiError) {
    throw new Error(
      `Advisor model returned an API error (messages received: ${messages.length}).`,
    )
  }

  const interrupted =
    terminalResult?.reason === 'aborted_streaming' ||
    terminalResult?.reason === 'aborted_tools'

  // Build blocks from final (post-tombstone) messages
  const blocks: Array<{ type: 'tool' | 'text'; text: string }> = []
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = (m.message as any)?.content as any[]
    if (!content) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        const s = formatToolInput(b.name, b.input)
        blocks.push({ type: 'tool', text: s ? `${toolLabel(b.name)} ${s}` : toolLabel(b.name) })
      } else if (b.type === 'text' && b.text) {
        blocks.push({ type: 'text', text: b.text })
      }
    }
  }

  const assistantMessages = messages.filter(
    (m: any) => m.type === 'assistant',
  )
  const assistantBlocks = assistantMessages.flatMap(
    (m: any) => m.message.content,
  )
  const toolUses = assistantBlocks.filter((b: any) => b.type === 'tool_use')
  const filesRead = new Set(
    toolUses
      .filter((t: any) => t.name === 'Read')
      .map((t: any) => t.input?.file_path)
      .filter((p: unknown): p is string => typeof p === 'string'),
  ).size
  const toolsCalled = toolUses.length
  const webSearched = toolUses.some((t: any) => t.name === 'WebSearch')

  // Aggregate token usage deduplicated by API response ID (message.message.id).
  // Multi-block API responses produce multiple assistant messages per round;
  // usage is per-response, not per-block. Usage is set only on the LAST block
  // via message_delta, so we use component-wise max per response ID to avoid
  // taking a zero/preliminary value from an earlier block.
  const usageByResponse = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number }>()
  let unkeyedTokens = 0
  for (const m of assistantMessages) {
    const usage = (m as any).message?.usage
    if (!usage) continue
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheCreation = usage.cache_creation_input_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const responseId = (m as any).message?.id as string | undefined
    if (!responseId) {
      unkeyedTokens += input + output + cacheCreation + cacheRead
      continue
    }
    const prev = usageByResponse.get(responseId)
    usageByResponse.set(responseId, {
      input: Math.max(prev?.input ?? 0, input),
      output: Math.max(prev?.output ?? 0, output),
      cacheCreation: Math.max(prev?.cacheCreation ?? 0, cacheCreation),
      cacheRead: Math.max(prev?.cacheRead ?? 0, cacheRead),
    })
  }
  const tokens = unkeyedTokens +
    [...usageByResponse.values()].reduce(
      (sum, u) => sum + u.input + u.output + u.cacheCreation + u.cacheRead, 0
    )

  // Extract advice from the final logical API response only.
  // Multi-block responses produce several assistant messages sharing one
  // message.id — grouping by response ID gives the complete final answer.
  const lastAssistant = assistantMessages.at(-1)
  const finalResponseId = lastAssistant?.message?.id
  const finalMessages =
    finalResponseId !== undefined
      ? assistantMessages.filter(
          (m: any) => m.message?.id === finalResponseId,
        )
      : lastAssistant
        ? [lastAssistant]
        : []
  const finalBlocks = finalMessages.flatMap(
    (m: any) => m.message?.content ?? [],
  )
  const advice = extractTextContent(finalBlocks, '\n\n').trim()
  const durationMs = Date.now() - info.startTime
  const conversationsRead = (conversationTool as any).__uniqueReadIds instanceof Set
    ? (conversationTool as any).__uniqueReadIds.size
    : 0

  if (!advice) {
    const partial = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim()
    if (!partial) {
      const toolBlocks = blocks.filter(b => b.type === 'tool')
      const toolNames = toolBlocks.map(b => b.text).join(', ')
      if (terminalResult?.reason === 'max_turns') {
        return {
          advice:
            `Advisor ran out of turns (${ADVISOR_MAX_TURNS} max) while researching this question. ` +
            `It made ${toolsCalled} tool ${toolsCalled === 1 ? 'call' : 'calls'} ` +
            `(${toolNames || 'none'}), read ${filesRead} ${filesRead === 1 ? 'file' : 'files'}, ` +
            `and consumed ${formatNumber(tokens)} tokens. ` +
            `\n\nTry re-asking with a narrower question.`,
          filesRead,
          toolsCalled,
          tokens,
          durationMs,
          webSearched,
          blocks,
          interrupted: true,
          model: advisorModel,
          conversationsRead,
        }
      }
      if (terminalResult?.reason === 'aborted_tools') {
        return {
          advice:
            `Advisor was interrupted while running tools. ` +
            `It made ${toolsCalled} tool ${toolsCalled === 1 ? 'call' : 'calls'} ` +
            `(${toolNames || 'none'}) and read ${filesRead} ${filesRead === 1 ? 'file' : 'files'} ` +
            `before being stopped. ` +
            `\n\nTry re-asking or narrow the scope.`,
          filesRead,
          toolsCalled,
          tokens,
          durationMs,
          webSearched,
          blocks,
          interrupted: true,
          model: advisorModel,
          conversationsRead,
        }
      }
      throw new Error(
        `Advisor returned no response ` +
        `(terminal reason: ${terminalResult?.reason ?? 'none'}, ` +
        `messages: ${messages.length}, ` +
        `tool uses: ${toolNames || 'none'}, ` +
        `sawApiError: ${sawApiError}).`,
      )
    }
    return {
      advice: partial,
      filesRead,
      toolsCalled,
      tokens,
      durationMs,
      webSearched,
      blocks,
      interrupted: true,
      model: advisorModel,
      conversationsRead,
    }
  }

  return {
    advice,
    filesRead,
    toolsCalled,
    tokens,
    durationMs,
    webSearched,
    blocks,
    interrupted,
    model: advisorModel,
    conversationsRead,
  }
}
