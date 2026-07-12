export interface ConversationEntry {
  id: number
  role: 'user' | 'assistant' | 'tool_result'
  /** Display text (with tool-result wrappers) for read output. */
  text: string
  /** Semantic body text (without wrappers) for BM25 indexing. */
  searchBody: string
  charLength: number
  tools?: string[]
  toolResults?: {
    toolName?: string
    isError: boolean
  }[]
  hasThinking?: boolean
  truncated: boolean
  /** Tool input text for BM25 search (not displayed in read output). */
  searchText?: string
}

export interface SearchDoc {
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

export interface SearchIndex {
  docs: SearchDoc[]
  df: Map<string, number>
  avgdl: number
  N: number
}

export interface SearchResult {
  entry: ConversationEntry
  score: number
  matchedTokens: string[]
  excerpt?: string
}

export interface SearchResponse {
  results: SearchResult[]
  totalMatches: number
}

export type AppendResult = 'full' | 'partial' | 'none'

export type CachedSnapshot = {
  fingerprint: string
  entries: ConversationEntry[]
  index: SearchIndex
}
