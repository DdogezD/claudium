import type { ModelProfile, ModelProfiles } from '../settings/types.js'
import { getInitialSettings } from '../settings/settings.js'

export type ModelScope = 'main' | 'subagent' | 'advisor'

export function getModelProfile(scope: ModelScope): ModelProfile {
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

export function formatProfileSummary(p: ModelProfile): string {
  const parts: string[] = []
  if (p.model) parts.push(p.model)
  else parts.push('default')
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
