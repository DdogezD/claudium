/**
 * URL rule matching for WebSearch domain restrictions.
 *
 * Rule entries are scheme-free by design — URL authorization is about
 * host + path, and only https URLs can ever match (search results are
 * https in practice; the restriction is a system invariant, not
 * per-entry configuration):
 *
 * - `example.com` — host suffix match (subdomains included)
 * - `example.com/path` — host suffix match AND path root match:
 *   pathname == "/path" or starts with "/path/". A trailing `/*` is
 *   accepted and ignored (`example.com/path/*` ≡ `example.com/path`).
 */

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

export type RuleEntry = {
  host: string
  pathRoot?: string
}

/**
 * Parse a rule entry into host + optional path root, or null if invalid.
 * `example.com/` and `example.com/*` degenerate to the plain-host form.
 */
export function parseRuleEntry(entry: string): RuleEntry | null {
  const trimmed = entry.trim()
  if (!trimmed || trimmed.includes('://')) {
    return null
  }
  const slash = trimmed.indexOf('/')
  const host = (slash === -1 ? trimmed : trimmed.slice(0, slash)).toLowerCase()
  if (!HOST_RE.test(host)) {
    return null
  }
  if (slash === -1) {
    return { host }
  }
  let pathRoot = trimmed.slice(slash)
  if (pathRoot.endsWith('*')) {
    pathRoot = pathRoot.slice(0, -1)
  }
  if (pathRoot.endsWith('/')) {
    pathRoot = pathRoot.slice(0, -1)
  }
  if (pathRoot.length <= 1) {
    return { host }
  }
  return { host, pathRoot }
}

/** A path rule carries a `/` and is meaningless to provider search APIs. */
export function isPathRule(entry: string): boolean {
  return entry.includes('/')
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, '')
  if (!normalized) {
    return false
  }
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

/**
 * Match a URL against a single rule entry. Invalid entries never match;
 * non-https URLs never match.
 */
export function matchesWebSearchRule(entry: string, url: string): boolean {
  const rule = parseRuleEntry(entry)
  if (!rule) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') {
    return false
  }
  if (!hostMatchesDomain(parsed.hostname.toLowerCase(), rule.host)) {
    return false
  }
  if (rule.pathRoot === undefined) {
    return true
  }
  const pathname = parsed.pathname
  return pathname === rule.pathRoot || pathname.startsWith(rule.pathRoot + '/')
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
  return (entries ?? []).filter(entry => !isPathRule(entry))
}
