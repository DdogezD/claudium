import type { Message } from '../../../types/message.js'
import { extractTextContent } from '../../../utils/messages.js'
import { buildSearchIndex } from './search.js'
import type { ConversationEntry, CachedSnapshot, SearchIndex } from '../types.js'
import {
  CONVERSATION_LOG_RESULT_CHARS,
  CONVERSATION_LOG_SEARCH_SNIPPET_CHARS,
  CONVERSATION_LOG_SEARCH_SNIPPET_TOTAL_CHARS,
} from './constants.js'

const ENTRY_DISPLAY_CAP = 16000

// ---------------------------------------------------------------------------
// Serialization cache (atomic snapshot: entries + search index)
// ---------------------------------------------------------------------------

let _cachedSnapshot: CachedSnapshot | null = null

/**
 * Build a fingerprint from the subset of message fields that affect
 * serialization output (entry text, searchBody, tools, toolResults, searchText,
 * truncated, hasThinking, charLength) and entry-id assignment.
 *
 * Uses a structured tuple projection + JSON.stringify.  For normal JSON messages
 * the same fingerprint guarantees the same observable snapshot.  The projection
 * may conservatively produce different fingerprints for snapshots that are
 * actually identical (e.g. UUID changes, unused trailing content), trading some
 * cache misses for safety.
 *
 * Coupling: if doSerializeConversationLog starts reading a new block field,
 * the corresponding case below MUST be updated in the same commit.
 */
function buildSnapshotFingerprint(messages: readonly Message[]): string {
  const projection = messages.map(m => {
    const msg = m as any
    const content = msg.message?.content

    let projectedContent: unknown

    if (typeof content === 'string') {
      projectedContent = ['s', content]
    } else if (Array.isArray(content)) {
      projectedContent = [
        'a',
        content.map((block: any) => {
          switch (block?.type) {
            case 'text':
              return ['t', block.text]

            case 'tool_use':
              return ['u', block.id, block.name, block.input]

            case 'tool_result':
              return ['r', block.tool_use_id, !!block.is_error, block.content]

            case 'thinking':
            case 'redacted_thinking':
              return ['h', typeof block.thinking === 'string' ? block.thinking.length : 0]

            case 'image':
            case 'image_url':
              // Serializer emits only the block-type marker; content is opaque.
              return [block.type]

            default:
              // Serializer currently ignores unknown block contents.
              return [block?.type ?? null]
          }
        }),
      ]
    } else {
      projectedContent = null
    }

    return [msg.type ?? null, msg.uuid ?? null, projectedContent]
  })

  return JSON.stringify(projection)
}

/**
 * Return the portion of `bodyText` that falls within the first `cap` chars
 * of display output.  `displayStart` is the position of the display part in
 * the assembled text, and `bodyOffsetInDisplay` is where the body content
 * starts within that display part (0 for text blocks, ≥0 for wrapped parts).
 */
function clampVisible(
  bodyText: string,
  displayStart: number,
  bodyOffsetInDisplay: number,
  cap: number,
): string | null {
  const bodyDisplayStart = displayStart + bodyOffsetInDisplay
  if (bodyDisplayStart >= cap) return null
  const available = cap - bodyDisplayStart
  if (available >= bodyText.length) return bodyText
  return bodyText.slice(0, Math.max(0, available))
}

function getConversationSnapshot(
  messages: readonly Message[],
): { entries: ConversationEntry[]; index: SearchIndex } {
  const fp = buildSnapshotFingerprint(messages)
  if (_cachedSnapshot && _cachedSnapshot.fingerprint === fp) {
    return { entries: _cachedSnapshot.entries, index: _cachedSnapshot.index }
  }

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
  const index = buildSearchIndex(entries)
  _cachedSnapshot = { fingerprint: fp, entries, index }
  return { entries, index }
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
      let searchBody = rawContent
      let truncated = false
      if (charLength > ENTRY_DISPLAY_CAP) {
        text = rawContent.slice(0, ENTRY_DISPLAY_CAP) + '\n\n[...truncated]'
        searchBody = rawContent.slice(0, ENTRY_DISPLAY_CAP)
        truncated = true
      }
      entries.push({
        id: i,
        role: msg.type,
        text,
        searchBody,
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
    let searchSnippetsTotal = 0
    const toolResults: { toolName?: string; isError: boolean }[] = []
    let hasThinking = false
    let truncated = false
    // Track original (pre-truncation) display length separately from the
    // actual textParts content (which may be per-result-capped).
    let originalDisplayLen = 0
    // Build searchBody incrementally so it only includes semantic content
    // that falls within the read-visible 16K display window.
    const searchBodyParts: string[] = []
    let displayPos = 0  // current position in the assembled text (includes newlines)

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
        originalDisplayLen += block.text.length
        const visibleBody = clampVisible(block.text, displayPos, 0, ENTRY_DISPLAY_CAP)
        if (visibleBody) searchBodyParts.push(visibleBody)
        displayPos += block.text.length + 1  // +1 for newline separator
      } else if (block.type === 'tool_use') {
        tools.push(block.name || 'unknown')
        // Capture tool-use input for BM25 search (per-snippet + aggregate cap)
        if (block.input && typeof block.input === 'object') {
          const inputStr = JSON.stringify(block.input)
          const separatorCost = searchSnippets.length > 0 ? 1 : 0  // join(' ')
          if (searchSnippetsTotal + separatorCost < CONVERSATION_LOG_SEARCH_SNIPPET_TOTAL_CHARS) {
            const remaining = CONVERSATION_LOG_SEARCH_SNIPPET_TOTAL_CHARS - searchSnippetsTotal - separatorCost
            const snippet = inputStr.slice(0, Math.min(CONVERSATION_LOG_SEARCH_SNIPPET_CHARS, remaining))
            searchSnippets.push(snippet)
            searchSnippetsTotal += separatorCost + snippet.length
          }
        }
      } else if (block.type === 'tool_result') {
        toolResults.push({
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
          if (resultText.length > CONVERSATION_LOG_RESULT_CHARS) {
            truncated = true
          }
          const displayedResultText = resultText.slice(0, CONVERSATION_LOG_RESULT_CHARS)
          const wrapper = `[${label}: ${displayedResultText}]`
          textParts.push(wrapper)
          // [label: resultText] = 4 chars of framing + label + resultText
          originalDisplayLen += label.length + resultText.length + 4
          // Body text starts after "[label: " in the display string
          const bodyOffsetInDisplay = label.length + 3  // "[label: "
          const visibleBody = clampVisible(
            displayedResultText,
            displayPos, bodyOffsetInDisplay, ENTRY_DISPLAY_CAP,
          )
          if (visibleBody) searchBodyParts.push(visibleBody)
          displayPos += wrapper.length + 1
        } else if (block.is_error) {
          const wrapper = '[tool_result_error]'
          textParts.push(wrapper)
          originalDisplayLen += wrapper.length
          displayPos += wrapper.length + 1
        } else {
          // Non-text tool_result: array content with no text blocks
          const wrapper = '[tool_result: non-text content omitted]'
          textParts.push(wrapper)
          originalDisplayLen += wrapper.length
          displayPos += wrapper.length + 1
        }
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        hasThinking = true
      } else if (block.type === 'image' || block.type === 'image_url') {
        // Emit a compact marker — actual base64 data is too large for the log
        textParts.push(`[${block.type}]`)
        originalDisplayLen += `[${block.type}]`.length
        displayPos += `[${block.type}]`.length + 1
      }
    }

    let text = textParts.join('\n')
    // Original display length: sum of all part lengths + newline separators
    const separatorOverhead = Math.max(0, textParts.length - 1)
    const charLength = originalDisplayLen + separatorOverhead
    if (charLength > ENTRY_DISPLAY_CAP) {
      text = text.slice(0, ENTRY_DISPLAY_CAP) + '\n\n[...truncated]'
      truncated = true
    }
    const searchBody = searchBodyParts.join('\n')

    entries.push({
      id: i,
      role: msg.type === 'user' && content.length > 0 && content.every((b: any) => b?.type === 'tool_result')
        ? 'tool_result' : msg.type,
      text,
      searchBody,
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

export { getConversationSnapshot }
