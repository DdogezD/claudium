// Stubbed: all Anthropic overage credit grant API communication removed.

export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

export type { CachedGrantEntry as OverageCreditGrantCacheEntry }

type CachedGrantEntry = {
  info: OverageCreditGrantInfo
  timestamp: number
}

export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  return null
}

export function invalidateOverageCreditGrantCache(): void {
  // Stubbed
}

export async function refreshOverageCreditGrantCache(): Promise<void> {
  // Stubbed
}

export function formatGrantAmount(
  info: OverageCreditGrantInfo,
): string | null {
  return null
}
