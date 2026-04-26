/**
 * Adaptive Memory Pressure Advisor
 *
 * Monitors RSS memory usage and adjusts GC frequency based on pressure level.
 * Replaces the blind fixed-interval GC that could contribute to death spirals.
 *
 * Problem: At ~2000+ messages, React Fiber trees cause severe memory pressure.
 * Bun's GC behavior triggers excessive mmap/munmap → madvise() storms → soft lockup.
 *
 * Solution: Adaptive monitoring with 3 states (NORMAL → ELEVATED → CRITICAL)
 * that adjusts GC frequency and triggers more aggressive collection when needed.
 */

import { logForDebugging } from './debug.js'

/** Memory pressure states */
export type MemoryPressureState = 'NORMAL' | 'ELEVATED' | 'CRITICAL'

/** Memory pressure thresholds in MB */
const RSS_THRESHOLD_ELEVATED_MB = 500
const RSS_THRESHOLD_CRITICAL_MB = 1500

/** GC intervals based on state (milliseconds) */
const GC_INTERVAL_NORMAL_MS = 5000
const GC_INTERVAL_ELEVATED_MS = 2000
const GC_INTERVAL_CRITICAL_MS = 500

/** Number of samples to keep for trend analysis */
const TREND_WINDOW_SIZE = 5

/** Growth rate threshold for CRITICAL (MB per sample) */
const GROWTH_RATE_CRITICAL_MB = 100

/**
 * Tracks memory usage and RSS growth trend
 */
interface MemorySample {
  rss: number
  timestamp: number
}

/**
 * Adaptive memory pressure advisor with 3-state machine:
 * - NORMAL: Memory usage is healthy, infrequent GC
 * - ELEVATED: Memory pressure building, moderate GC frequency
 * - CRITICAL: High memory pressure, frequent GC to prevent death spiral
 */
export class MemoryPressureAdvisor {
  private samples: MemorySample[] = []
  private currentState: MemoryPressureState = 'NORMAL'
  private gcTimer: ReturnType<typeof setInterval> | null = null
  private isRunning = false

  /**
   * Get current RSS in MB
   */
  private getRssMB(): number {
    if (typeof Bun !== 'undefined') {
      const mem = Bun.memory()
      return mem.rss / (1024 * 1024)
    }
    // Fallback for non-Bun environment
    const usage = process.memoryUsage()
    return usage.rss / (1024 * 1024)
  }

  /**
   * Compute RSS growth rate in MB per sample interval
   */
  private computeGrowthRateMB(): number {
    if (this.samples.length < 2) return 0
    const oldest = this.samples[0]!
    const newest = this.samples[this.samples.length - 1]!
    const timeDeltaSec = (newest.timestamp - oldest.timestamp) / 1000
    if (timeDeltaSec === 0) return 0
    return (newest.rss - oldest.rss) / timeDeltaSec
  }

  /**
   * Determine pressure state based on RSS and growth trend
   */
  private computeState(rssMB: number): MemoryPressureState {
    // Check for critical growth rate first (predictive)
    const growthRate = this.computeGrowthRateMB()
    if (growthRate > GROWTH_RATE_CRITICAL_MB) {
      return 'CRITICAL'
    }

    // Check absolute thresholds
    if (rssMB >= RSS_THRESHOLD_CRITICAL_MB) {
      return 'CRITICAL'
    }
    if (rssMB >= RSS_THRESHOLD_ELEVATED_MB) {
      return 'ELEVATED'
    }
    return 'NORMAL'
  }

  /**
   * Get GC interval for given state
   */
  private getGcInterval(state: MemoryPressureState): number {
    switch (state) {
      case 'CRITICAL':
        return GC_INTERVAL_CRITICAL_MS
      case 'ELEVATED':
        return GC_INTERVAL_ELEVATED_MS
      case 'NORMAL':
      default:
        return GC_INTERVAL_NORMAL_MS
    }
  }

  /**
   * Record a memory sample
   */
  private recordSample(rss: number): void {
    this.samples.push({ rss, timestamp: Date.now() })
    // Keep only recent samples for trend analysis
    if (this.samples.length > TREND_WINDOW_SIZE) {
      this.samples.shift()
    }
  }

  /**
   * Perform adaptive GC based on current state
   */
  private adaptiveGC(): void {
    const rssMB = this.getRssMB()
    this.recordSample(rssMB)
    const newState = this.computeState(rssMB)

    // Log state transitions
    if (newState !== this.currentState) {
      const prevState = this.currentState
      this.currentState = newState
      logForDebugging(
        `[MemoryPressure] State: ${prevState} → ${newState} (RSS: ${rssMB.toFixed(1)} MB)`,
      )
      this.restartTimer()
    }

    // Only trigger full GC when memory is elevated
    if (newState !== 'NORMAL' && typeof Bun !== 'undefined') {
      Bun.gc(true)
    }
  }

  /**
   * Restart the GC timer with updated interval
   */
  private restartTimer(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
    }
    const interval = this.getGcInterval(this.currentState)
    this.gcTimer = setInterval(() => this.adaptiveGC(), interval)
    this.gcTimer.unref()
  }

  /**
   * Start the memory pressure advisor
   */
  start(): void {
    if (this.isRunning) return
    this.isRunning = true

    // Initial sample
    const initialRSS = this.getRssMB()
    this.recordSample(initialRSS)
    this.currentState = this.computeState(initialRSS)

    logForDebugging(
      `[MemoryPressure] Started - Initial RSS: ${initialRSS.toFixed(1)} MB, State: ${this.currentState}`,
    )

    // Start the adaptive GC timer
    this.restartTimer()
  }

  /**
   * Stop the memory pressure advisor
   */
  stop(): void {
    if (!this.isRunning) return
    this.isRunning = false

    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
    this.samples = []
    this.currentState = 'NORMAL'

    logForDebugging('[MemoryPressure] Stopped')
  }

  /**
   * Get current memory pressure state
   */
  getState(): MemoryPressureState {
    return this.currentState
  }
}

// Singleton instance
let advisorInstance: MemoryPressureAdvisor | null = null

/**
 * Start the global memory pressure advisor
 */
export function startMemoryPressureAdvisor(): MemoryPressureAdvisor {
  if (!advisorInstance) {
    advisorInstance = new MemoryPressureAdvisor()
  }
  advisorInstance.start()
  return advisorInstance
}

/**
 * Get the global memory pressure advisor instance
 */
export function getMemoryPressureAdvisor(): MemoryPressureAdvisor | null {
  return advisorInstance
}

/**
 * Stop the global memory pressure advisor
 */
export function stopMemoryPressureAdvisor(): void {
  if (advisorInstance) {
    advisorInstance.stop()
  }
}
