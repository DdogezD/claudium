import { describe, expect, test } from 'bun:test'
import { resolveWebSearchDomains } from './domainRestrictions.js'

describe('resolveWebSearchDomains', () => {
  test('passes through model input when no settings exist', () => {
    expect(
      resolveWebSearchDomains(
        { allowed_domains: ['example.com'], blocked_domains: ['spam.com'] },
        undefined,
      ),
    ).toEqual({
      denyAll: false,
      allowedDomains: ['example.com'],
      blockedDomains: ['spam.com'],
    })
  })

  test('settings allowlist applies when model passes no list', () => {
    expect(
      resolveWebSearchDomains(
        { blocked_domains: ['spam.com'] },
        { allowedDomains: ['docs.example.com'] },
      ),
    ).toEqual({
      denyAll: false,
      allowedDomains: ['docs.example.com'],
      blockedDomains: ['spam.com'],
    })
  })

  test('model allowlist becomes an extra ANDed rule set under the ceiling', () => {
    expect(
      resolveWebSearchDomains(
        { allowed_domains: ['docs.example.com'] },
        { allowedDomains: ['example.com', 'other.org'] },
      ),
    ).toEqual({
      denyAll: false,
      allowedDomains: ['example.com', 'other.org'],
      extraAllowRuleSets: [['docs.example.com']],
    })
  })

  test('empty settings allowlist is deny-all', () => {
    expect(resolveWebSearchDomains({}, { allowedDomains: [] })).toEqual({
      denyAll: true,
    })
    expect(resolveWebSearchDomains({}, { allowedDomains: ['  '] })).toEqual({
      denyAll: true,
    })
  })

  test('blocked lists union and dedupe', () => {
    expect(
      resolveWebSearchDomains(
        { blocked_domains: ['spam.com', 'ads.example.com'] },
        { blockedDomains: ['spam.com', 'tracker.net'] },
      ),
    ).toEqual({
      denyAll: false,
      blockedDomains: ['spam.com', 'tracker.net', 'ads.example.com'],
    })
  })

  test('match patterns pass through unchanged', () => {
    expect(
      resolveWebSearchDomains({}, {
        blockedDomains: ['*://cloud.tencent.com/developer/article/*'],
      }),
    ).toEqual({
      denyAll: false,
      blockedDomains: ['*://cloud.tencent.com/developer/article/*'],
    })
  })

  test('no constraints yields denyAll false only', () => {
    expect(resolveWebSearchDomains({}, undefined)).toEqual({ denyAll: false })
  })
})
