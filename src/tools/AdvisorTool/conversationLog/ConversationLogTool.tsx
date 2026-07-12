import { Text } from '../../../ink.js'
import { buildTool } from '../../../Tool.js'
import { conversationLogInputSchema, type ConversationLogInput } from '../schemas.js'
import type { ConversationEntry, SearchIndex, AppendResult } from '../types.js'
import { formatSearchResults, formatEntryLabel, bm25Search, buildSearchIndex } from './search.js'
import { tokenizeQuery } from './tokenizer.js'
import { CONVERSATION_LOG_TOTAL_CHARS } from './snapshot.js'
import { CONVERSATION_LOG_TOOL_NAME } from '../prompt.js'

// ---------------------------------------------------------------------------
// formatConversationIndex
// ---------------------------------------------------------------------------

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

  if (effectiveOffset >= total) {
    return `Offset ${effectiveOffset} is beyond the ${total} available messages.`
  }

  // Slice from the end so the most recent messages appear first
  const startIdx = Math.max(0, total - effectiveOffset - effectiveLimit)
  const endIdx = Math.max(0, total - effectiveOffset)
  const page = entries.slice(startIdx, endIdx).reverse()

  const hasMorePages = startIdx > 0
  const hasNewer = effectiveOffset > 0
  const nextOffset = effectiveOffset + effectiveLimit

  const firstId = page.length > 0 ? page[0]!.id : 0
  const lastId = page.length > 0 ? page[page.length - 1]!.id : 0
  const header = hasNewer
    ? `# Conversation log manifest (${total} messages available, ${effectiveOffset} skipped, showing [${firstId}]-[${lastId}])`
    : `# Conversation log manifest (${total} messages available, showing [${firstId}]-[${lastId}])`

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

// ---------------------------------------------------------------------------
// createConversationLogTool
// ---------------------------------------------------------------------------

function createConversationLogTool(entries: ConversationEntry[], prebuiltIndex?: SearchIndex) {
  const entryMap = new Map(entries.map(e => [e.id, e]))
  const searchIndex = prebuiltIndex ?? buildSearchIndex(entries)
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

    inputSchema: conversationLogInputSchema,
    // Bypass 50K persistence threshold — index/search/read each enforce
    // their own explicit budget.  Letting the framework persist would
    // break lazy-read: the model would only get a file path, not content.
    maxResultSizeChars: Infinity,

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

    renderToolUseMessage(input: ConversationLogInput) {
      if (input.action === 'index') return <Text>Reading conversation index</Text>
      if (input.action === 'search') return <Text>Searching conversation log</Text>
      return <Text>{`Reading ${input.message_ids.length} ${input.message_ids.length === 1 ? 'message' : 'messages'} from log`}</Text>
    },

    async call(input: ConversationLogInput) {
      if (input.action === 'index') {
        return { data: formatConversationIndex(entries, input.offset, input.limit) }
      }
      if (input.action === 'search') {
        const queryTokens = [...new Set(tokenizeQuery(input.query))]
        if (queryTokens.length > 64) {
          return { data: `Query has ${queryTokens.length} unique tokens; max 64 supported. Please narrow your search.` }
        }
        const response = bm25Search(input.query, searchIndex, input.top_k, input.match_mode)
        return { data: formatSearchResults(input.query, response.results, searchIndex.N, response.totalMatches, input.match_mode) }
      }
      // action === 'read'
      const ids = input.message_ids
      const seen = new Set<number>()
      const TRUNCATION_MARKER = '\n\n[...output truncated]'
      const SEPARATOR = '\n\n---\n\n'
      let totalChars = 0
      const results: string[] = []

      function appendLine(line: string): AppendResult {
        const separatorCost = results.length > 0 ? SEPARATOR.length : 0
        const cost = line.length + separatorCost
        if (totalChars + cost > CONVERSATION_LOG_TOTAL_CHARS) {
          const remaining = CONVERSATION_LOG_TOTAL_CHARS - totalChars - separatorCost - TRUNCATION_MARKER.length
          if (remaining > 0) {
            results.push(line.slice(0, remaining) + TRUNCATION_MARKER)
          }
          totalChars = CONVERSATION_LOG_TOTAL_CHARS
          return remaining > 0 ? 'partial' : 'none'
        }
        totalChars += cost
        results.push(line)
        return 'full'
      }

      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        const entry = entryMap.get(id)
        if (!entry) {
          if (appendLine(`[${id}] NOT FOUND — ID out of range`) !== 'full') break
          continue
        }
        const truncTag = entry.truncated ? ' [truncated]' : ''
        const searchTextInfo = entry.searchText
          ? `\n\n[tool inputs for search: ${entry.searchText.slice(0, 1000)}]`
          : ''
        const line = `[${id}] ${entry.role} (${entry.charLength} chars)${truncTag}:\n\n${entry.text}${searchTextInfo}`
        const result = appendLine(line)
        if (result === 'full') {
          uniqueReadIds.add(id)
        } else {
          // Partial: entry was truncated but some content was included — count as read.
          if (result === 'partial') uniqueReadIds.add(id)
          break
        }
      }
      return { data: results.join(SEPARATOR) }
    },

    userFacingName() { return CONVERSATION_LOG_TOOL_NAME },
  })

  return {
    tool,
    getUniqueReadCount(): number {
      return uniqueReadIds.size
    },
  }
}

export {
  formatConversationIndex,
  createConversationLogTool,
}
