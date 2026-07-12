import { describe, expect, it } from 'bun:test'
import {
  tokenize,
  tokenizeQuery,
} from './conversationLog/tokenizer.js'

describe('tokenize', () => {
  it('splits camelCase identifiers', () => {
    const tokens = tokenize('ReadConversationLog')
    expect(tokens).toContain('read')
    expect(tokens).toContain('conversation')
    expect(tokens).toContain('log')
  })

  it('handles acronym boundaries (XMLHttpRequest)', () => {
    const tokens = tokenize('XMLHttpRequest')
    expect(tokens).toContain('xml')
    expect(tokens).toContain('http')
    expect(tokens).toContain('request')
  })

  it('tokenizes regular text with mixed case', () => {
    const tokens = tokenize('already Read filePath')
    expect(tokens).toContain('already')
    expect(tokens).toContain('read')
    expect(tokens).toContain('file')
    expect(tokens).toContain('path')
  })

  it('generates Han bigrams by contiguous run (no cross-delimiter)', () => {
    const tokens = tokenize('分页，搜索')
    // Must contain bigrams from each run independently
    expect(tokens).toContain('分页')
    expect(tokens).toContain('搜索')
    // Must NOT contain cross-delimiter pseudo-bigram
    expect(tokens).not.toContain('页搜')
  })

  it('does not generate cross-language pseudo-bigrams', () => {
    const tokens = tokenize('中国 abc 人民')
    expect(tokens).toContain('中国')
    expect(tokens).toContain('人民')
    expect(tokens).not.toContain('国人')
  })

  it('generates Han unigrams (for single-char search support)', () => {
    const tokens = tokenize('分页')
    expect(tokens).toContain('分')
    expect(tokens).toContain('页')
    expect(tokens).toContain('分页')
  })

  it('handles single Han character in document index', () => {
    const tokens = tokenize('页')
    expect(tokens).toContain('页')
  })

  it('returns empty for empty string', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('tokenizeQuery', () => {
  it('single Han char query → unigram only', () => {
    const tokens = tokenizeQuery('页')
    expect(tokens).toEqual(['页'])
  })

  it('multi-char Han query → bigrams only (no unigrams)', () => {
    const tokens = tokenizeQuery('分页')
    expect(tokens).toContain('分页')
    expect(tokens).not.toContain('分')
    expect(tokens).not.toContain('页')
  })

  it('ASCII query unchanged from tokenize', () => {
    const t1 = tokenize('ReadFile test')
    const t2 = tokenizeQuery('ReadFile test')
    expect(t2).toEqual(t1)
  })
})
