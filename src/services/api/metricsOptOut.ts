// Stubbed: all Anthropic metrics opt-out API communication removed.

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  return { enabled: false, hasError: false }
}

// Export for testing purposes only
export const _clearMetricsEnabledCacheForTesting = (): void => {
  // Stubbed
}
