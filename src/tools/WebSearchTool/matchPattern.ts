/**
 * URL rule matching for WebSearch domain restrictions.
 *
 * Each settings/per-call entry is one of:
 *
 * - Plain domain: `csdn.net` — matches that host and its subdomains
 *   (backward-compatible with the original allowed_domains semantics).
 * - uBlacklist-style match pattern: `*://*.csdn.net/*` —
 *   `<scheme>://<host><path>` where scheme is `*` (http+https), `http` or
 *   `https`; host is `*` (any), `*.example.com` (domain + subdomains) or an
 *   exact host; path starts with `/` and `*` matches any character sequence.
 *   This covers host+path-prefix rules such as
 *   `*://cloud.tencent.com/developer/article/*`.
 */

const patternCache = new Map<string, RegExp | null>()

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a uBlacklist-style match pattern to a RegExp, or return null for
 * invalid patterns. Results are cached; patterns are few and long-lived.
 */
export function compileMatchPattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern)
  if (cached !== undefined) {
    return cached
  }

  const match = pattern.match(/^(\*|https?):\/\/([^/]*)(\/.*)?$/i)
  let regex: RegExp | null = null
  if (match) {
    const [, schemeRaw, hostRaw, pathRaw = '/*'] = match
    const scheme = schemeRaw!.toLowerCase()
    const host = hostRaw!.toLowerCase()

    const schemeRe = scheme === '*' ? 'https?' : escapeRegExp(scheme)

    let hostRe: string | null = null
    if (host === '*') {
      hostRe = '[^/]+'
    } else if (host.startsWith('*.')) {
      // *.example.com matches example.com itself and any subdomain
      hostRe = `([^/]+\\.)?${escapeRegExp(host.slice(2))}`
    } else if (!host.includes('*')) {
      hostRe = escapeRegExp(host)
    }
    // Partial host wildcards (e.g. "ex*ample.com") are unsupported,
    // matching uBlacklist.

    if (hostRe !== null) {
      const pathRe = pathRaw!.split('*').map(escapeRegExp).join('.*')
      regex = new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`)
    }
  }

  patternCache.set(pattern, regex)
  return regex
}

export function isMatchPattern(entry: string): boolean {
  return entry.includes('://')
}

/** Lowercase scheme and host so patterns match URLs case-insensitively. */
function normalizeUrlForMatching(url: string): string {
  return url.replace(/^([a-zA-Z]+:\/\/[^/]+)/, prefix => prefix.toLowerCase())
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, '')
  if (!normalized) {
    return false
  }
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

/**
 * Match a URL against a single rule entry (plain domain or match pattern).
 * Invalid patterns never match.
 */
export function matchesWebSearchRule(entry: string, url: string): boolean {
  if (isMatchPattern(entry)) {
    const regex = compileMatchPattern(entry)
    return regex !== null && regex.test(normalizeUrlForMatching(url))
  }

  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return hostMatchesDomain(hostname, entry)
}

export type WebSearchRuleConstraint = {
  /**
   * AND-of-ORs: the URL must match at least one rule in every set. An empty
   * array of sets means no allow constraint.
   */
  allowRuleSets: string[][]
  /** OR: matching any rule excludes the URL. */
  blockRules: string[]
}

export function matchesWebSearchRules(
  url: string,
  constraint: WebSearchRuleConstraint,
): boolean {
  for (const set of constraint.allowRuleSets) {
    if (!set.some(rule => matchesWebSearchRule(rule, url))) {
      return false
    }
  }
  return !constraint.blockRules.some(rule => matchesWebSearchRule(rule, url))
}

/** Extract plain-domain entries (the only kind a provider API accepts). */
export function toProviderDomains(entries: string[] | undefined): string[] {
  return (entries ?? []).filter(
    entry => !isMatchPattern(entry) && !entry.includes('/'),
  )
}
