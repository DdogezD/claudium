import { describe, expect, test } from 'bun:test'
import {
  isPathRule,
  matchesWebSearchRule,
  matchesWebSearchRules,
  parseRuleEntry,
  toProviderDomains,
} from './matchPattern.js'

describe('parseRuleEntry', () => {
  test('plain host', () => {
    expect(parseRuleEntry('csdn.net')).toEqual({ host: 'csdn.net' })
  })

  test('host plus path root', () => {
    expect(parseRuleEntry('cloud.tencent.com/document')).toEqual({
      host: 'cloud.tencent.com',
      pathRoot: '/document',
    })
  })

  test('trailing /* and / are normalized away', () => {
    expect(parseRuleEntry('example.com/docs/*')).toEqual({
      host: 'example.com',
      pathRoot: '/docs',
    })
    expect(parseRuleEntry('example.com/docs/')).toEqual({
      host: 'example.com',
      pathRoot: '/docs',
    })
  })

  test('bare slash or star degenerates to plain host', () => {
    expect(parseRuleEntry('example.com/')).toEqual({ host: 'example.com' })
    expect(parseRuleEntry('example.com/*')).toEqual({ host: 'example.com' })
  })

  test('host is lowercased, path keeps case', () => {
    expect(parseRuleEntry('EXAMPLE.com/Docs')).toEqual({
      host: 'example.com',
      pathRoot: '/Docs',
    })
  })

  test('rejects invalid entries', () => {
    expect(parseRuleEntry('')).toBeNull()
    expect(parseRuleEntry('https://example.com/docs')).toBeNull()
    expect(parseRuleEntry('*://*.example.com/*')).toBeNull()
    expect(parseRuleEntry('-bad-.com')).toBeNull()
  })
})

describe('matchesWebSearchRule', () => {
  test('plain domains keep suffix semantics', () => {
    expect(matchesWebSearchRule('csdn.net', 'https://blog.csdn.net/a')).toBe(
      true,
    )
    expect(matchesWebSearchRule('csdn.net', 'https://csdn.net/a')).toBe(true)
    expect(matchesWebSearchRule('csdn.net', 'https://notcsdn.net/a')).toBe(
      false,
    )
  })

  test('path roots match the root itself and everything under it', () => {
    expect(
      matchesWebSearchRule(
        'cloud.tencent.com/document',
        'https://cloud.tencent.com/document/product/1',
      ),
    ).toBe(true)
    expect(
      matchesWebSearchRule(
        'cloud.tencent.com/document',
        'https://cloud.tencent.com/document',
      ),
    ).toBe(true)
    // Query strings don't break the bare-root match (URL pathname excludes them)
    expect(
      matchesWebSearchRule(
        'cloud.tencent.com/document',
        'https://cloud.tencent.com/document?lang=en',
      ),
    ).toBe(true)
    // Prefix must end at a path boundary
    expect(
      matchesWebSearchRule(
        'cloud.tencent.com/document',
        'https://cloud.tencent.com/documents',
      ),
    ).toBe(false)
    expect(
      matchesWebSearchRule(
        'cloud.tencent.com/document',
        'https://cloud.tencent.com/developer/article/1',
      ),
    ).toBe(false)
  })

  test('path rules share the host suffix semantics of plain domains', () => {
    expect(
      matchesWebSearchRule('tencent.com/document', 'https://cloud.tencent.com/document/1'),
    ).toBe(true)
  })

  test('only https URLs match', () => {
    expect(matchesWebSearchRule('example.com', 'http://example.com/a')).toBe(
      false,
    )
    expect(matchesWebSearchRule('example.com/docs', 'http://example.com/docs')).toBe(
      false,
    )
    expect(matchesWebSearchRule('example.com', 'ftp://example.com/a')).toBe(
      false,
    )
  })

  test('host matching is case-insensitive', () => {
    expect(matchesWebSearchRule('csdn.net', 'https://BLOG.CSDN.NET/a')).toBe(
      true,
    )
  })

  test('invalid entries never match', () => {
    expect(
      matchesWebSearchRule('https://example.com/', 'https://example.com/a'),
    ).toBe(false)
  })
})

describe('matchesWebSearchRules', () => {
  test('allow sets are ANDed, rules within a set are ORed', () => {
    const constraint = {
      allowRuleSets: [
        ['example.com', 'example.org/docs'], // settings ceiling
        ['docs.example.com'], // model narrows
      ],
      blockRules: [],
    }
    expect(
      matchesWebSearchRules('https://docs.example.com/a', constraint),
    ).toBe(true)
    expect(matchesWebSearchRules('https://example.com/a', constraint)).toBe(
      false,
    )
    expect(matchesWebSearchRules('https://other.org/a', constraint)).toBe(
      false,
    )
  })

  test('block rules subtract after allow', () => {
    const constraint = {
      allowRuleSets: [['example.com']],
      blockRules: ['example.com/ads'],
    }
    expect(matchesWebSearchRules('https://example.com/ads/x', constraint)).toBe(
      false,
    )
    expect(matchesWebSearchRules('https://example.com/docs', constraint)).toBe(
      true,
    )
  })

  test('no allow constraint allows everything not blocked', () => {
    const constraint = { allowRuleSets: [], blockRules: ['spam.com'] }
    expect(matchesWebSearchRules('https://anything.io/', constraint)).toBe(true)
    expect(matchesWebSearchRules('https://spam.com/', constraint)).toBe(false)
  })
})

describe('toProviderDomains', () => {
  test('keeps only plain domains', () => {
    expect(
      toProviderDomains([
        'example.com',
        'cloud.tencent.com/document',
        'cloud.tencent.com/document/*',
      ]),
    ).toEqual(['example.com'])
  })
})

describe('isPathRule', () => {
  test('entries with a slash are path rules', () => {
    expect(isPathRule('example.com')).toBe(false)
    expect(isPathRule('example.com/docs')).toBe(true)
  })
})
