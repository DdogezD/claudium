import type { AntiLoopConfig } from './types.js'

export const ANTI_LOOP_DEFAULTS: Readonly<AntiLoopConfig> = Object.freeze({
  enabled: true,
  thresholds: [3, 5, 8],
  argumentsPreviewChars: 500,
})

function isValidThresholds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(Number.isInteger) &&
    value.every(threshold => threshold >= 2) &&
    new Set(value).size === value.length &&
    value.every((threshold, index) => index === 0 || threshold > value[index - 1]!)
}

export function resolveAntiLoopConfig(
  input?: Partial<AntiLoopConfig>,
): AntiLoopConfig {
  if (input?.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('antiLoop.enabled must be a boolean')
  }
  if (input?.thresholds !== undefined && !isValidThresholds(input.thresholds)) {
    throw new TypeError('antiLoop.thresholds must be non-empty, unique, ascending integers >= 2')
  }
  if (input?.argumentsPreviewChars !== undefined &&
    (!Number.isInteger(input.argumentsPreviewChars) || input.argumentsPreviewChars <= 0)) {
    throw new TypeError('antiLoop.argumentsPreviewChars must be a positive integer')
  }

  return {
    enabled: input?.enabled ?? ANTI_LOOP_DEFAULTS.enabled,
    thresholds: [...(input?.thresholds ?? ANTI_LOOP_DEFAULTS.thresholds)],
    argumentsPreviewChars: input?.argumentsPreviewChars ?? ANTI_LOOP_DEFAULTS.argumentsPreviewChars,
  }
}

