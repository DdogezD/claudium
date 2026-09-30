import { describe, expect, test } from 'bun:test'
import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'
import { findDomainPermissionRule } from './domainPermissionRule.js'

function makeRule(content: string): PermissionRule {
  return {
    ruleBehavior: 'allow',
    ruleValue: { toolName: 'WebFetch', ruleContent: content },
    source: 'userSettings',
  } as PermissionRule
}

describe('findDomainPermissionRule', () => {
  test('exact domain rule matches the same hostname', () => {
    const rules = new Map([['domain:example.com', makeRule('domain:example.com')]])
    expect(findDomainPermissionRule(rules, 'example.com')).toBeDefined()
    expect(findDomainPermissionRule(rules, 'other.com')).toBeUndefined()
    expect(findDomainPermissionRule(rules, 'docs.example.com')).toBeUndefined()
  })

  test('wildcard rule matches the suffix host and subdomains', () => {
    const rules = new Map([['domain:*.example.com', makeRule('domain:*.example.com')]])
    expect(findDomainPermissionRule(rules, 'example.com')).toBeDefined()
    expect(findDomainPermissionRule(rules, 'docs.example.com')).toBeDefined()
    expect(findDomainPermissionRule(rules, 'deep.docs.example.com')).toBeDefined()
    expect(findDomainPermissionRule(rules, 'notexample.com')).toBeUndefined()
    expect(findDomainPermissionRule(rules, 'example.com.evil.com')).toBeUndefined()
  })

  test('exact rule wins over wildcard', () => {
    const exact = makeRule('domain:example.com')
    const wildcard = makeRule('domain:*.example.com')
    const rules = new Map([
      ['domain:*.example.com', wildcard],
      ['domain:example.com', exact],
    ])
    expect(findDomainPermissionRule(rules, 'example.com')).toBe(exact)
    expect(findDomainPermissionRule(rules, 'docs.example.com')).toBe(wildcard)
  })

  test('hostname matching is case-insensitive', () => {
    const rules = new Map([['domain:*.Example.COM', makeRule('domain:*.Example.COM')]])
    expect(findDomainPermissionRule(rules, 'DOCS.EXAMPLE.COM')).toBeDefined()
  })

  test('empty map yields undefined', () => {
    expect(findDomainPermissionRule(new Map(), 'example.com')).toBeUndefined()
  })
})
