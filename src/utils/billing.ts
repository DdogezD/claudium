import { getAnthropicApiKey } from './auth.js'
import { isEnvTruthy } from './envUtils.js'

export function hasConsoleBillingAccess(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }
  const hasApiKey = getAnthropicApiKey() !== null
  return hasApiKey
}

// Mock billing access for /mock-limits testing (set by mockRateLimits.ts)
let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

/**
 * Stub: OAuth/claude.ai billing access has been stripped.
 * Returns true if API key is configured (API key users always have billing access).
 */
export function hasClaudeAiBillingAccess(): boolean {
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }
  return getAnthropicApiKey() !== null
}
