import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'

const DOMAIN_PREFIX = 'domain:'
const WILDCARD_PREFIX = 'domain:*.'

/**
 * Find the permission rule governing a hostname. Exact `domain:host` rules
 * win; otherwise `domain:*.suffix` rules match the suffix host itself and
 * its subdomains (e.g. `domain:*.example.com` covers `example.com` and
 * `docs.example.com`). Wildcard support mirrors what the rule validator has
 * always accepted but the exact-map lookup never implemented.
 */
export function findDomainPermissionRule(
  rules: Map<string, PermissionRule>,
  hostname: string,
): PermissionRule | undefined {
  const exact = rules.get(`${DOMAIN_PREFIX}${hostname}`)
  if (exact) {
    return exact
  }

  const lowerHostname = hostname.toLowerCase()
  for (const [content, rule] of rules) {
    if (!content.startsWith(WILDCARD_PREFIX)) {
      continue
    }
    const suffix = content.slice(WILDCARD_PREFIX.length).toLowerCase()
    if (
      suffix.length > 0 &&
      (lowerHostname === suffix || lowerHostname.endsWith(`.${suffix}`))
    ) {
      return rule
    }
  }
  return undefined
}
