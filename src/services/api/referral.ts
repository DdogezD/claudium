// Stubbed: all Anthropic referral API communication removed.

export async function fetchReferralEligibility(
  ...args: any[]
): Promise<null> {
  return null
}

export async function fetchReferralRedemptions(
  ...args: any[]
): Promise<null> {
  return null
}

export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  return { eligible: false, needsRefresh: false, hasCache: false }
}

export function formatCreditAmount(...args: any[]): string | null {
  return null
}

export function getCachedReferrerReward(): null {
  return null
}

export function getCachedRemainingPasses(): null {
  return null
}

export async function fetchAndStorePassesEligibility(): Promise<null> {
  return null
}

export async function getCachedOrFetchPassesEligibility(): Promise<null> {
  return null
}

export async function prefetchPassesEligibility(): Promise<void> {
  // Stubbed
}
