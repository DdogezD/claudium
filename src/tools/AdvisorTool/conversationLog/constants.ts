// ---------------------------------------------------------------------------
// Shared constants for conversation log serialization and search
// ---------------------------------------------------------------------------

export const CONVERSATION_LOG_READ_LIMIT = 20
export const CONVERSATION_LOG_TOTAL_CHARS = 80_000
export const CONVERSATION_LOG_RESULT_CHARS = 8_000    // Per tool-result cap
export const CONVERSATION_LOG_SEARCH_SNIPPET_CHARS = 2_000
export const CONVERSATION_LOG_SEARCH_SNIPPET_TOTAL_CHARS = 16_000  // Aggregate per-entry cap for all snippets
export const CONVERSATION_LOG_INDEX_CHARS = 60_000     // Max output chars for the index action
