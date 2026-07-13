import { Text } from '../../../ink.js'
import { buildTool, type ToolDef } from '../../../Tool.js'
import {
  conversationLogInputSchema,
  conversationLogOutputSchema,
  type ConversationLogInput,
  type ConversationLogOutput,
} from '../schemas.js'
import type { ConversationEntry, SearchIndex, AppendResult } from '../types.js'
import { formatSearchResults, formatEntryLabel, bm25Search, buildSearchIndex } from './search.js'
import { tokenizeQuery } from './tokenizer.js'
import { CONVERSATION_LOG_TOTAL_CHARS, CONVERSATION_LOG_INDEX_CHARS } from './constants.js'
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

  const effectiveLimit = Math.max(1, Math.min(limit ?? 200, 500))
  const effectiveOffset = Math.max(0, offset ?? 0)
  const total = entries.length

  if (effectiveOffset >= total) {
    return `Offset ${effectiveOffset} is beyond the ${total} available messages.`
  }

  const startIdx = Math.max(0, total - effectiveOffset - effectiveLimit)
  const endIdx = Math.max(0, total - effectiveOffset)
  const page = entries.slice(startIdx, endIdx).reverse()
  const hasNewer = effectiveOffset > 0

  // Build message lines
  const msgLines: string[] = []
  for (const e of page) {
    const label = formatEntryLabel(e)
    const toolInfo = e.tools ? ` [tools: ${e.tools.join(', ').slice(0, 200)}]` : ''
    const trunc = e.truncated ? ' (truncated)' : ''
    msgLines.push(`[${e.id}] ${label} (${e.charLength} chars)${toolInfo}${trunc}`)
  }

  // Build complete output, then trim from end if over budget.
  // This is O(page.length) reconstruction — bounded by 500 entries.
  const newerLine = hasNewer ? `↑ ${effectiveOffset} newer messages above (use offset=0 to go back to latest)` : null

  function assemble(shown: number): string {
    const nextOffset = effectiveOffset + shown
    const hasMorePages = effectiveOffset + shown < total
    const remaining = total - effectiveOffset - shown
    const firstId = shown > 0 ? page[0]!.id : 0
    const lastId = shown > 0 ? page[shown - 1]!.id : 0

    const header = hasNewer
      ? `# Conversation log manifest (${total} messages available, ${effectiveOffset} skipped, showing [${firstId}]-[${lastId}])`
      : `# Conversation log manifest (${total} messages available, showing [${firstId}]-[${lastId}])`

    const parts: string[] = [header]
    if (newerLine) parts.push(newerLine)
    for (let i = 0; i < shown; i++) parts.push(msgLines[i]!)
    if (shown < msgLines.length) parts.push('[...index truncated]')
    if (hasMorePages) {
      parts.push(`↓ ${remaining} earlier messages below (use offset=${nextOffset} to page further back)`)
    }

    return parts.join('\n\n')
  }

  // Start with all messages, trim back until within budget
  let shown = msgLines.length
  while (shown > 0) {
    const text = assemble(shown)
    if (text.length <= CONVERSATION_LOG_INDEX_CHARS) break
    shown--
  }

  // If even the header + nav lines exceed budget, show at least that.
  return assemble(shown)
}

// ---------------------------------------------------------------------------
// createConversationLogTool
// ---------------------------------------------------------------------------

function createConversationLogTool(entries: ConversationEntry[], prebuiltIndex?: SearchIndex) {
  const entryMap = new Map(entries.map(e => [e.id, e]))
  const searchIndex = prebuiltIndex ?? buildSearchIndex(entries)
  // Track which unique IDs were successfully read (for conversationsRead stats)
  const uniqueReadIds = new Set<number>()

  // Shared read implementation reused by read and around actions
  function doRead(ids: number[], charOffset: number = 0, charLimit?: number): string {
    const seen = new Set<number>()
    const SEPARATOR = '\n\n---\n\n'
    const effectiveCap = charLimit ?? CONVERSATION_LOG_TOTAL_CHARS
    let totalChars = 0
    const results: string[] = []

    function appendLine(line: string, onTruncated?: (consumed: number) => void): AppendResult {
      const separatorCost = results.length > 0 ? SEPARATOR.length : 0
      const cost = line.length + separatorCost
      if (totalChars + cost > effectiveCap) {
        const remaining = effectiveCap - totalChars - separatorCost
        if (remaining <= 0) return 'none'
        // Build candidate: truncate, build marker, check total, trim if over
        let truncated = line.slice(0, remaining)
        let nextOffset = onTruncated ? onTruncated(truncated.length) : -1
        let marker = `\n\n[...output truncated, next_offset=${nextOffset >= 0 ? nextOffset : '?'}]`
        // Shrink until truncated + marker fits in remaining
        while (truncated.length > 0 && truncated.length + marker.length > remaining) {
          truncated = truncated.slice(0, -1)
          nextOffset = onTruncated ? onTruncated(truncated.length) : -1
          marker = `\n\n[...output truncated, next_offset=${nextOffset >= 0 ? nextOffset : '?'}]`
        }
        if (truncated.length > 0) {
          results.push(truncated + marker)
        }
        totalChars = effectiveCap
        return truncated.length > 0 ? 'partial' : 'none'
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
      const visibleText = charOffset > 0 ? entry.text.slice(charOffset) : entry.text
      const offsetTag = charOffset > 0 ? ` [offset=${charOffset}]` : ''
      const truncTag = entry.truncated ? ' [truncated]' : ''
      const headerPart = `[${id}] ${entry.role} (${entry.charLength} chars)${offsetTag}${truncTag}:\n\n`
      const bodyLine = headerPart + visibleText
      const footerPart = (charOffset === 0 && entry.searchText)
        ? `\n\n[tool inputs for search: ${entry.searchText.slice(0, 1000)}]`
        : ''

      const headerLen = headerPart.length
      const nextOffset = (truncatedLen: number) =>
        charOffset + Math.min(visibleText.length, Math.max(0, truncatedLen - headerLen))

      // Only include tool-input metadata when the complete body already fits.
      // The footer has no continuation coordinate, so it must never produce a
      // next_offset marker.  Omit it best-effort when the current budget cannot
      // contain it, rather than claiming a body continuation can recover it.
      const separatorCost = results.length > 0 ? SEPARATOR.length : 0
      const line = footerPart && totalChars + separatorCost + bodyLine.length + footerPart.length <= effectiveCap
        ? bodyLine + footerPart
        : bodyLine
      const result = appendLine(line, nextOffset)

      if (result === 'full' || result === 'partial') {
        uniqueReadIds.add(id)
      }
      if (result !== 'full') {
        break
      }
    }

    return results.join(SEPARATOR)
  }

  const tool = buildTool({
    name: CONVERSATION_LOG_TOOL_NAME,

    async description() {
      return `Read the main agent's conversation history after the latest compact boundary. Actions: "index" (browse), "search" (keyword with role/ID filters), "read" (fetch messages, support char_offset for continuation), "around" (context around a message).`
    },

    async prompt() {
      return `Read conversation history of the main agent. All post-compaction user and assistant messages are available. Use action: "index" to list recent messages, action: "search" to locate messages by keyword (optionally filtered by roles, after_id, before_id), action: "read" with message_ids to fetch details (use char_offset + char_limit for long messages), and action: "around" to read context around a message.`
    },

    inputSchema: conversationLogInputSchema,

    get outputSchema(): typeof conversationLogOutputSchema {
      return conversationLogOutputSchema
    },

    // Bypass 50K persistence threshold — index/search/read/around each enforce
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
        content: output,
      }
    },

    renderToolUseMessage(input: ConversationLogInput) {
      if (input.action === 'index') return <Text>Reading conversation index</Text>
      if (input.action === 'search') return <Text>Searching conversation log</Text>
      if (input.action === 'around') return <Text>Reading context around message</Text>
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
        // Build filter predicate for role/ID range (applied before top_k truncation)
        const roleSet = input.roles && input.roles.length > 0 ? new Set(input.roles) : null
        const after = input.after_id
        const before = input.before_id
        const filter = (roleSet || after !== undefined || before !== undefined)
          ? (e: ConversationEntry) =>
              (!roleSet || roleSet.has(e.role)) &&
              (after === undefined || e.id > after) &&
              (before === undefined || e.id < before)
          : undefined

        const response = bm25Search(input.query, searchIndex, input.top_k, input.match_mode, filter)
        return { data: formatSearchResults(input.query, response.results, searchIndex.N, response.totalMatches, input.match_mode) }
      }
      if (input.action === 'around') {
        const target = input.message_id
        const before = input.before ?? 3
        const after = input.after ?? 3
        const allIds = entries.map(e => e.id).sort((a, b) => a - b)
        const idx = allIds.indexOf(target)
        if (idx === -1) {
          return { data: `Message [${target}] not found in conversation log.` }
        }
        const start = Math.max(0, idx - before)
        const end = Math.min(allIds.length, idx + after + 1)
        const aroundIds = allIds.slice(start, end)
        return { data: doRead(aroundIds) }
      }
      // action === 'read'
      return { data: doRead(input.message_ids, input.char_offset, input.char_limit) }
    },

    userFacingName() { return CONVERSATION_LOG_TOOL_NAME },
  } satisfies ToolDef<typeof conversationLogInputSchema, ConversationLogOutput>)

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
