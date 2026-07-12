const HAN_RUN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g

// Non-ASCII, non-Han letter/number runs (accented Latin, Cyrillic, Kana, Hangul, etc.)
const UNICODE_WORD_RE = /[\p{L}\p{N}]+/gu

export function tokenize(text: string): string[] {
  // Split camelCase and acronym boundaries before lowercasing
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const lowered = camelSplit.toLowerCase()
  const asciiTokens = lowered.split(/[^a-z0-9]+/).filter(t => t.length > 0)

  // Han bigrams by contiguous run (avoids cross-delimiter pseudo-tokens).
  // Index mode: unigrams + bigrams so single-char queries can match.
  const hanTokens: string[] = []
  HAN_RUN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HAN_RUN_RE.exec(text)) !== null) {
    const run = match[0]
    for (const ch of run) hanTokens.push(ch.toLowerCase())
    for (let i = 0; i < run.length - 1; i++) {
      hanTokens.push(run.slice(i, i + 2).toLowerCase())
    }
  }

  // Non-ASCII/non-Han Unicode words
  const unicodeTokens = extractUnicodeWords(text)

  return [...asciiTokens, ...hanTokens, ...unicodeTokens]
}

/** Query-mode tokenizer: single-char Han run → unigram; multi-char → bigrams only. */
export function tokenizeQuery(text: string): string[] {
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const lowered = camelSplit.toLowerCase()
  const asciiTokens = lowered.split(/[^a-z0-9]+/).filter(t => t.length > 0)

  const hanTokens: string[] = []
  HAN_RUN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HAN_RUN_RE.exec(text)) !== null) {
    const run = match[0]
    if (run.length === 1) {
      hanTokens.push(run[0]!.toLowerCase())
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        hanTokens.push(run.slice(i, i + 2).toLowerCase())
      }
    }
  }

  const unicodeTokens = extractUnicodeWords(text)
  return [...asciiTokens, ...hanTokens, ...unicodeTokens]
}

// Shared Unicode word scanner used by all tokenizers
export function extractUnicodeWords(text: string): string[] {
  const tokens: string[] = []
  UNICODE_WORD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = UNICODE_WORD_RE.exec(text)) !== null) {
    const word = match[0]
    if (/^[a-zA-Z0-9]+$/.test(word)) continue
    if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(word)) continue
    tokens.push(word.toLowerCase())
  }
  return tokens
}

/**
 * Tokenize text with character offsets — used by buildSearchExcerpt to
 * locate match positions without relying on naive indexOf().
 */
export function tokenizeWithOffsets(text: string): Array<{ token: string; start: number; end: number }> {
  const results: Array<{ token: string; start: number; end: number }> = []

  // ASCII: scan [a-zA-Z0-9]+ runs, split camelCase within each
  const asciiRe = /[a-zA-Z0-9]+/g
  let m: RegExpExecArray | null
  while ((m = asciiRe.exec(text)) !== null) {
    const word = m[0]
    const wordStart = m.index
    const parts = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 0)
    let pos = 0
    for (const part of parts) {
      const idx = word.toLowerCase().indexOf(part, pos)
      if (idx !== -1) {
        results.push({ token: part, start: wordStart + idx, end: wordStart + idx + part.length })
        pos = idx + part.length
      }
    }
  }

  // Han runs
  HAN_RUN_RE.lastIndex = 0
  while ((m = HAN_RUN_RE.exec(text)) !== null) {
    const run = m[0]
    const runStart = m.index
    // unigrams
    for (let i = 0; i < run.length; i++) {
      results.push({ token: run[i]!.toLowerCase(), start: runStart + i, end: runStart + i + 1 })
    }
    // bigrams
    for (let i = 0; i < run.length - 1; i++) {
      results.push({ token: run.slice(i, i + 2).toLowerCase(), start: runStart + i, end: runStart + i + 2 })
    }
  }

  // Non-ASCII/non-Han Unicode words with offsets
  UNICODE_WORD_RE.lastIndex = 0
  while ((m = UNICODE_WORD_RE.exec(text)) !== null) {
    const word = m[0]
    if (/^[a-zA-Z0-9]+$/.test(word)) continue
    if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(word)) continue
    results.push({ token: word.toLowerCase(), start: m.index, end: m.index + word.length })
  }

  return results
}
