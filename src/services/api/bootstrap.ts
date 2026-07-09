// Stubbed: all Anthropic bootstrap API communication removed.

import { logForDebugging } from '../../utils/debug.js'

async function fetchBootstrapAPI(): Promise<null> {
  logForDebugging('[Bootstrap] Skipped: stubbed')
  return null
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 * Stubbed: no HTTP calls.
 */
export async function fetchBootstrapData(): Promise<void> {
  // Stubbed
}
