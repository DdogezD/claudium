/**
 * Resolves the effective domain/URL restrictions for a WebSearch call by
 * merging the per-call (model-provided) parameters with the persistent
 * settings.json `webSearch` configuration.
 *
 * Rule syntax (both lists, model parameters and settings alike):
 * - Plain domain: `csdn.net` — host suffix match (subdomains included)
 * - uBlacklist-style match pattern: `*://*.csdn.net/*`,
 *   `*://cloud.tencent.com/developer/article/*` — see matchPattern.ts
 *
 * Semantics:
 * - settings.allowedDomains is a hard ceiling. If the model also passes
 *   allowed_domains, both become allow rule sets that are ANDed: a URL must
 *   match at least one rule in the settings set AND one in the model set.
 *   (AND-of-sets replaces syntactic intersection so match patterns compose.)
 * - settings.allowedDomains present as an empty array is deny-all
 *   (same convention as availableModels).
 * - blockedDomains from settings and from the call are unioned (OR).
 */

export type WebSearchDomainSettings = {
  allowedDomains?: string[]
  blockedDomains?: string[]
}

export type ResolvedWebSearchDomains = {
  /** True when the settings allowlist explicitly denies every domain. */
  denyAll: boolean
  /**
   * Effective allow entries for display and provider-side schemas: the
   * settings ceiling when present, otherwise the model's list. Complex
   * (pattern) entries are additionally enforced client-side.
   */
  allowedDomains?: string[]
  /** Union of settings and per-call block entries. */
  blockedDomains?: string[]
  /**
   * Extra allow sets ANDed on top of allowedDomains. Non-empty only when
   * both settings and the model provided allowlists.
   */
  extraAllowRuleSets?: string[][]
}

function normalizeEntries(entries: string[] | undefined): string[] {
  return (entries ?? []).map(e => e.trim()).filter(e => e.length > 0)
}

function dedupe(entries: string[]): string[] {
  return [...new Set(entries)]
}

export function resolveWebSearchDomains(
  input: {
    allowed_domains?: string[]
    blocked_domains?: string[]
  },
  settings: WebSearchDomainSettings | undefined,
): ResolvedWebSearchDomains {
  const modelAllowed = normalizeEntries(input.allowed_domains)
  const modelBlocked = normalizeEntries(input.blocked_domains)

  const settingsAllowed =
    settings?.allowedDomains === undefined
      ? undefined
      : normalizeEntries(settings.allowedDomains)
  const settingsBlocked = normalizeEntries(settings?.blockedDomains)

  // Settings allowlist present but empty (before or after normalization with
  // no usable entries) is an explicit deny-all.
  if (settingsAllowed !== undefined && settingsAllowed.length === 0) {
    return { denyAll: true }
  }

  let allowedDomains: string[] | undefined
  let extraAllowRuleSets: string[][] | undefined
  if (settingsAllowed !== undefined) {
    allowedDomains = settingsAllowed
    if (modelAllowed.length > 0) {
      // Model narrows within the ceiling: both sets must match.
      extraAllowRuleSets = [modelAllowed]
    }
  } else if (modelAllowed.length > 0) {
    allowedDomains = modelAllowed
  }

  const blockedDomains = dedupe([...settingsBlocked, ...modelBlocked])

  return {
    denyAll: false,
    ...(allowedDomains !== undefined ? { allowedDomains } : {}),
    ...(blockedDomains.length > 0 ? { blockedDomains } : {}),
    ...(extraAllowRuleSets ? { extraAllowRuleSets } : {}),
  }
}
