import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { hasConsoleBillingAccess } from './utils/billing.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { writeExitFooter } from './utils/gracefulShutdown.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      if (hasConsoleBillingAccess()) {
        writeExitFooter(formatTotalCost() + '\n')
      }

      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
