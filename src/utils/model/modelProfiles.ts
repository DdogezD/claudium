import type { AdvisorProfile, ModelProfile, ModelProfiles } from '../settings/types.js'
import { getInitialSettings } from '../settings/settings.js'

export type ModelScope = 'main' | 'subagent' | 'advisor'

export function getModelProfile(scope: ModelScope): ModelProfile | AdvisorProfile {
  return getInitialSettings().modelProfiles?.[scope] ?? {}
}

export function getModelProfiles(): ModelProfiles {
  return getInitialSettings().modelProfiles ?? {}
}

// ---------------------------------------------------------------------------
// Centralized resolvers — single source of truth for profile-driven settings.
// All consumers must go through these, not read getInitialSettings().modelProfiles directly.
// ---------------------------------------------------------------------------

/** Resolve the effective model string from modelProfiles for a given scope. */
export function resolveModelProfileModel(scope: ModelScope): string | undefined {
  return getInitialSettings().modelProfiles?.[scope]?.model
}

/** Resolve the context window override from modelProfiles for a given scope. */
export function resolveModelProfileContext(scope: ModelScope): number | undefined {
  const v = getInitialSettings().modelProfiles?.[scope]?.contextWindowTokens
  return v && v > 0 ? v : undefined
}

/** Resolve the reasoning effort from modelProfiles for a given scope. */
export function resolveModelProfileEffort(scope: ModelScope): string | undefined {
  return getInitialSettings().modelProfiles?.[scope]?.reasoningEffort
}

/**
 * Check whether the advisor is explicitly enabled.
 * Returns undefined (not configured — implicit off), true (explicitly on),
 * or false (explicitly disabled, overrides model presence).
 */
export function resolveAdvisorEnabled(): boolean | undefined {
  return getInitialSettings().modelProfiles?.advisor?.enabled
}

export function formatProfileSummary(p: ModelProfile | AdvisorProfile, scope?: ModelScope): string {
  if (scope === 'advisor' && (p as AdvisorProfile).enabled === false) {
    return 'Disabled'
  }
  if (scope === 'advisor' && !p.model && !(p as AdvisorProfile).enabled) {
    return 'Not configured'
  }
  const parts: string[] = []
  if (p.model) parts.push(p.model)
  else if (scope === 'advisor') parts.push('Not configured')
  else if (scope === 'subagent') parts.push('Inherit main')
  else parts.push('Not configured')
  if (p.contextWindowTokens) parts.push(`${formatTokenCount(p.contextWindowTokens)}`)
  else parts.push('auto')
  if (p.reasoningEffort) parts.push(p.reasoningEffort)
  else parts.push('auto')
  return parts.join(' · ')
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    const s = m % 1 === 0 ? String(m) : m.toFixed(1)
    return `${s}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
