import { describe, expect, test } from 'bun:test'
import {
  compileMatchPattern,
  matchesWebSearchRule,
  matchesWebSearchRules,
  toProviderDomains,
} from './matchPattern.js'

describe('compileMatchPattern', () => {
  test('compiles wildcard scheme, subdomain host and path', () => {
    const re = compileMatchPattern('*://*.csdn.net/*')!
    expect(re.test('https://csdn.net/article/1')).toBe(true)
    expect(re.test('http://blog.csdn.net/x')).toBe(true)
    expect(re.test('https://notcsdn.net/x')).toBe(false)
    expect(re.test('ftp://csdn.net/x')).toBe(false)
  })

  test('matches host plus path prefix only', () => {
    const re = compileMatchPattern('*://cloud.tencent.com/developer/article/*')!
    expect(
      re.test('https://cloud.tencent.com/developer/article/123'),
    ).toBe(true)
    expect(re.test('http://cloud.tencent.com/developer/article/123')).toBe(
      true,
    )
    expect(re.test('https://cloud.tencent.com/document/product/1')).toBe(false)
    expect(re.test('https://other.tencent.com/developer/article/1')).toBe(
      false,
    )
  })

  test('scheme-specific patterns only match that scheme', () => {
    const re = compileMatchPattern('https://example.com/*')!
    expect(re.test('https://example.com/a')).toBe(true)
    expect(re.test('http://example.com/a')).toBe(false)
  })

  test('exact host does not match subdomains', () => {
    const re = compileMatchPattern('*://example.com/*')!
    expect(re.test('https://example.com/a')).toBe(true)
    expect(re.test('https://www.example.com/a')).toBe(false)
  })

  test('missing path defaults to /*', () => {
    const re = compileMatchPattern('*://example.com')!
    expect(re.test('https://example.com/anything')).toBe(true)
  })

  test('rejects invalid patterns', () => {
    expect(compileMatchPattern('*://ex*ample.com/*')).toBeNull()
    expect(compileMatchPattern('not-a-pattern')).toBeNull()
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

  test('match patterns apply to the full URL', () => {
    expect(
      matchesWebSearchRule(
        '*://cloud.tencent.com/developer/article/*',
        'https://cloud.tencent.com/developer/article/1',
      ),
    ).toBe(true)
  })

  test('host matching is case-insensitive', () => {
    expect(
      matchesWebSearchRule('*://*.csdn.net/*', 'https://BLOG.CSDN.NET/a'),
    ).toBe(true)
  })
})

describe('matchesWebSearchRules', () => {
  test('allow sets are ANDed, rules within a set are ORed', () => {
    const constraint = {
      allowRuleSets: [
        ['example.com', '*.org://unused'], // settings ceiling
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
      blockRules: ['*://example.com/ads/*'],
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
        '*://*.csdn.net/*',
        'cloud.tencent.com/developer/article/',
      ]),
    ).toEqual(['example.com'])
  })
})
