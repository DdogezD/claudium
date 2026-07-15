import {
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
} from '../constants/figures.js'
import {
  type EffortLevel,
  type EffortValue,
  modelSupportsEffort,
} from '../utils/effort.js'

/**
 * Build the effort-notification text with optional context usage.
 * E.g. "max · 45K/200K (23%)" or just "max" if no usage data.
 * Passes through the raw effort string as-is — no level mapping or symbol prefix.
 */
export function getEffortNotificationText(
  effortValue: EffortValue | undefined,
  model: string,
  contextUsage?: { used: number; window: number },
): string | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const level = typeof effortValue === 'string' ? effortValue.toLowerCase() : (typeof effortValue === 'number' ? String(effortValue) : undefined)
  if (!level) return undefined
  let text = level
  if (contextUsage && contextUsage.window > 0) {
    const pct = Math.round((contextUsage.used / contextUsage.window) * 100)
    text += ` · ${formatTokenCount(contextUsage.used)}/${formatTokenCount(contextUsage.window)} (${pct}%)`
  }
  return text
}

export function effortLevelToSymbol(level: EffortLevel): string {
  switch (level) {
    case 'low': return EFFORT_LOW
    case 'medium': return EFFORT_MEDIUM
    case 'high': return EFFORT_HIGH
    case 'max': return EFFORT_MAX
    default: return EFFORT_HIGH
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}
