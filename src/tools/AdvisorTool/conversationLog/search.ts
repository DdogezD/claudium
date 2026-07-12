import { tokenize, tokenizeQuery, tokenizeWithOffsets } from './tokenizer.js'
import type { ConversationEntry, SearchDoc, SearchIndex, SearchResult, SearchResponse } from '../types.js'

const BM25_K1 = 1.2
const BM25_B = 0.75
const BM25_SEARCH_TEXT_ONLY_PENALTY = 0.5
const BM25_AND_COORDINATION_BONUS = 1.1

export function buildSearchIndex(entries: ConversationEntry[]): SearchIndex {
  const docs: SearchDoc[] = []
  const df = new Map<string, number>()
  let totalTokens = 0

  for (const entry of entries) {
    const tokens: string[] = []
    const bodyTokens = new Set<string>()
    const metadataTokens = new Set<string>()
    const searchTextTokens = new Set<string>()

    // Semantic body text (without wrapper labels) for BM25 indexing
    for (const t of tokenize(entry.searchBody)) {
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
        for (const t of tokenize(name)) {
          tokens.push(t)
          metadataTokens.add(t)
        }
      }
    }

    // Tool result names + error status — displayed in result labels
    if (entry.toolResults) {
      for (const r of entry.toolResults) {
        if (r.toolName) {
          for (const t of tokenize(r.toolName)) {
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

function buildSearchExcerpt(
  doc: SearchDoc,
  matchedTokens: string[],
): string | undefined {
  // 1. Matches in body text — show context around the first matching token
  const bodyOffsets = tokenizeWithOffsets(doc.entry.searchBody)
  for (const token of matchedTokens) {
    if (!doc.bodyTokens.has(token)) continue
    const off = bodyOffsets.find(o => o.token === token)
    if (off) {
      const start = Math.max(0, off.start - 30)
      const end = Math.min(doc.entry.searchBody.length, off.end + 30)
      const excerpt = doc.entry.searchBody.slice(start, end).replace(/\s+/g, ' ')
      return excerpt
    }
  }
  // 2. All matches are in displayed metadata (tool names, result status)
  // — no excerpt needed; the index label already shows this
  if (matchedTokens.every(t => doc.metadataTokens.has(t))) {
    return undefined
  }
  // 3. Matches in hidden tool input
  if (doc.entry.searchText) {
    const searchOffsets = tokenizeWithOffsets(doc.entry.searchText)
    for (const token of matchedTokens) {
      if (!doc.searchTextTokens.has(token)) continue
      const off = searchOffsets.find(o => o.token === token)
      if (off) {
        const start = Math.max(0, off.start - 30)
        const end = Math.min(doc.entry.searchText.length, off.end + 30)
        const excerpt = doc.entry.searchText.slice(start, end).replace(/\s+/g, ' ')
        return `tool input: ${excerpt}`
      }
    }
  }
  return undefined
}

export function bm25Search(
  query: string,
  index: SearchIndex,
  topK: number,
  matchMode: 'or' | 'all' = 'or',
): SearchResponse {
  if (index.docs.length === 0) return { results: [], totalMatches: 0 }

  const queryTokens = [...new Set(tokenizeQuery(query))]
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
export function formatEntryLabel(e: ConversationEntry): string {
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

export function formatSearchResults(
  query: string,
  results: SearchResult[],
  totalIndexed: number,
  totalMatches?: number,
  matchMode?: 'or' | 'all',
): string {
  const SEARCH_OUTPUT_CHARS = 60_000
  const EXCERPT_MAX_CHARS = 200
  const exclusionNote =
    'Note: Entries without searchable tokens or metadata are excluded from search.'

  const quotedQuery = JSON.stringify(query)
  const modeNote = matchMode === 'all' ? ' (mode: all)' : ''

  if (results.length === 0) {
    const searched = totalIndexed > 0
      ? ` Searched ${totalIndexed} messages.`
      : ''
    return (
      `No conversation messages matched ${quotedQuery}${modeNote}.${searched}\n\n${exclusionNote}`
    )
  }

  const matchInfo =
    totalMatches !== undefined
      ? `searched ${totalIndexed} messages; ${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'}`
      : `searched ${totalIndexed} messages`

  // Build all result lines first
  const resultLines: string[] = []
  for (const r of results) {
    const label = formatEntryLabel(r.entry)
    const toolInfo = r.entry.tools ? ` [tools: ${r.entry.tools.join(', ')}]` : ''
    const trunc = r.entry.truncated ? ' (truncated)' : ''
    const matchedInfo = ` [matched: ${r.matchedTokens.join(', ')}]`
    const excerptStr = r.excerpt
      ? r.excerpt.length > EXCERPT_MAX_CHARS
        ? ` ${JSON.stringify(r.excerpt.slice(0, EXCERPT_MAX_CHARS) + '\u2026')}`
        : ` ${JSON.stringify(r.excerpt)}`
      : ''
    resultLines.push(`[${r.entry.id}] ${label} (${r.score.toFixed(3)} score) (${r.entry.charLength} chars)${toolInfo}${matchedInfo}${trunc}${excerptStr}`)
  }

  // Build complete output, then trim from end if over budget.
  function assemble(shown: number): string {
    const ids = results.slice(0, shown).map(r => r.entry.id)
    const shownHeader =
      `# Search results for ${quotedQuery}${modeNote} — showing ${shown} results (${matchInfo})`
    const hint = ids.length > 0
      ? `\n\nUse action="read" with message_ids=[${ids.join(', ')}] to fetch full content.`
      : ''

    const parts: string[] = [shownHeader, exclusionNote]
    for (let i = 0; i < shown; i++) parts.push(resultLines[i]!)
    if (shown < resultLines.length) parts.push('[...results truncated]')

    return parts.join('\n\n') + hint
  }

  let shown = resultLines.length
  while (shown > 0) {
    if (assemble(shown).length <= SEARCH_OUTPUT_CHARS) break
    shown--
  }
  return assemble(shown)
}
