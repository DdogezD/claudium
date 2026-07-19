import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics-stub.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(
  model: string,
  querySource?: string,
  contextWindowOverride?: number,
): number {
  const ctxType = getContextType(querySource)

  // Resolve the summary output token reservation, allowing context-specific
  // overrides (env var → setting → model default).
  let reservedTokensForSummary: number
  const generalEnvSummary = process.env.CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS

  // Check context-specific env var first
  if (ctxType === 'subagent') {
    const subagentEnvSummary =
      process.env.CLAUDE_CODE_SUBAGENT_SUMMARY_OUTPUT_TOKENS
    if (subagentEnvSummary !== undefined) {
      const parsed = parseInt(subagentEnvSummary, 10)
      if (!isNaN(parsed) && parsed > 0) {
        reservedTokensForSummary = parsed
      } else {
        reservedTokensForSummary = DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY
      }
    } else {
      // Check settings
      const override = getSubagentSummaryOutputOverride()
      if (override !== undefined) {
        reservedTokensForSummary = override
      } else if (generalEnvSummary !== undefined) {
        const parsed = parseInt(generalEnvSummary, 10)
        reservedTokensForSummary =
          !isNaN(parsed) && parsed > 0
            ? parsed
            : DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY
      } else {
        reservedTokensForSummary = Math.min(
          getMaxOutputTokensForModel(model),
          DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        )
      }
    }
  } else if (ctxType === 'advisor') {
    const advisorEnvSummary =
      process.env.CLAUDE_CODE_ADVISOR_SUMMARY_OUTPUT_TOKENS
    if (advisorEnvSummary !== undefined) {
      const parsed = parseInt(advisorEnvSummary, 10)
      if (!isNaN(parsed) && parsed > 0) {
        reservedTokensForSummary = parsed
      } else {
        reservedTokensForSummary = DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY
      }
    } else {
      const override = getAdvisorSummaryOutputOverride()
      if (override !== undefined) {
        reservedTokensForSummary = override
      } else if (generalEnvSummary !== undefined) {
        const parsed = parseInt(generalEnvSummary, 10)
        reservedTokensForSummary =
          !isNaN(parsed) && parsed > 0
            ? parsed
            : DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY
      } else {
        reservedTokensForSummary = Math.min(
          getMaxOutputTokensForModel(model),
          DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        )
      }
    }
  } else {
    // Main agent — existing logic unchanged
    const parsedSummaryTokens = generalEnvSummary
      ? parseInt(generalEnvSummary, 10)
      : DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY
    reservedTokensForSummary = generalEnvSummary !== undefined &&
      !Number.isNaN(parsedSummaryTokens)
      ? parsedSummaryTokens
      : Math.min(
          getMaxOutputTokensForModel(model),
          DEFAULT_MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        )
  }

  let contextWindow = getContextWindowForModel(
    model,
    getSdkBetas(),
    ctxType,
    contextWindowOverride,
  )

  // Apply context-type specific overrides (subagent / advisor)
  // These are applied BEFORE the CLAUDE_CODE_AUTO_COMPACT_WINDOW cap
  // so the global cap can further constrain if needed.
  if (ctxType === 'subagent') {
    const override = getSubagentContextWindowOverride()
    if (override !== undefined) {
      contextWindow = Math.min(contextWindow, override)
    }
  } else if (ctxType === 'advisor') {
    const override = getAdvisorContextWindowOverride()
    if (override !== undefined) {
      contextWindow = Math.min(contextWindow, override)
    }
  }

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

export const DEFAULT_AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// ---------------------------------------------------------------------------
// Context type detection — used to resolve subagent/adviser-specific
// context window and buffer overrides from settings and env vars.
// ---------------------------------------------------------------------------

type ContextType = 'main' | 'subagent' | 'advisor'

function getContextType(querySource?: string): ContextType {
  if (!querySource) return 'main'
  if (querySource === 'advisor') return 'advisor'
  if (
    querySource.startsWith('agent:') ||
    querySource === 'supervisor' ||
    querySource === 'speculation'
  ) {
    return 'subagent'
  }
  return 'main'
}

/**
 * Resolve the subagent context window override from env var or settings.
 * Returns undefined if no override is configured (falls through to default).
 */
function getSubagentContextWindowOverride(): number | undefined {
  // 1. Env var takes precedence
  const envOverride = process.env.CLAUDE_CODE_SUBAGENT_MAX_CONTEXT_TOKENS
  if (envOverride) {
    const parsed = parseInt(envOverride, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  // 2. Settings fallback
  try {
    const { getModelProfile } = require('../../utils/model/modelProfiles.js')
    const v = getModelProfile('subagent').contextWindowTokens
    if (v && v > 0) return v
  } catch { /* circular dep guard */ }
  return undefined
}

function getAdvisorContextWindowOverride(): number | undefined {
  // 1. Env var takes precedence
  const envOverride = process.env.CLAUDE_CODE_ADVISOR_MAX_CONTEXT_TOKENS
  if (envOverride) {
    const parsed = parseInt(envOverride, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  // 2. Settings fallback
  try {
    const { getModelProfile } = require('../../utils/model/modelProfiles.js')
    const v = getModelProfile('advisor').contextWindowTokens
    if (v && v > 0) return v
  } catch { /* circular dep guard */ }
  return undefined
}

function getSubagentBufferOverride(): number | undefined {
  const envOverride = process.env.CLAUDE_CODE_SUBAGENT_BUFFER_TOKENS
  if (envOverride) {
    const parsed = parseInt(envOverride, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
    const v = getInitialSettings().subagentBufferTokens
    if (v && v > 0) return v
  } catch {
    // Settings not available
  }
  return undefined
}

function getAdvisorBufferOverride(): number | undefined {
  const envOverride = process.env.CLAUDE_CODE_ADVISOR_BUFFER_TOKENS
  if (envOverride) {
    const parsed = parseInt(envOverride, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
    const v = getInitialSettings().advisorBufferTokens
    if (v && v > 0) return v
  } catch {
    // Settings not available
  }
  return undefined
}

function getSubagentSummaryOutputOverride(): number | undefined {
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
    const v = getInitialSettings().subagentSummaryOutputTokens
    if (v && v > 0) return v
  } catch {
    // Settings not available
  }
  return undefined
}

function getAdvisorSummaryOutputOverride(): number | undefined {
  try {
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
    const v = getInitialSettings().advisorSummaryOutputTokens
    if (v && v > 0) return v
  } catch {
    // Settings not available
  }
  return undefined
}

export function getAutoCompactBufferTokens(querySource?: string): number {
  // Allow context-specific overrides first
  const ctxType = getContextType(querySource)
  if (ctxType === 'subagent') {
    const override = getSubagentBufferOverride()
    if (override !== undefined) return override
  } else if (ctxType === 'advisor') {
    const override = getAdvisorBufferOverride()
    if (override !== undefined) return override
  }

  // Allow overriding autocompact buffer size via environment variable.
  // If the env var is defined, use the provided value directly.
  const envBuffer = process.env.CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS
  const parsed = envBuffer !== undefined ? parseInt(envBuffer, 10) : NaN
  if (envBuffer !== undefined && !Number.isNaN(parsed)) {
    return parsed
  }
  return DEFAULT_AUTOCOMPACT_BUFFER_TOKENS
}

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(
  model: string,
  querySource?: string,
  contextWindowOverride?: number,
): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(
    model,
    querySource,
    contextWindowOverride,
  )

  const autocompactBufferTokens = getAutoCompactBufferTokens(querySource)
  const autocompactThreshold =
    effectiveContextWindow - autocompactBufferTokens

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
  querySource?: string,
  contextWindowOverride?: number,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(
    model,
    querySource,
    contextWindowOverride,
  )
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model, querySource, contextWindowOverride)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(
    model,
    querySource,
    contextWindowOverride,
  )
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
  contextWindowOverride?: number,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(
    model,
    querySource,
    contextWindowOverride,
  )
  const effectiveWindow = getEffectiveContextWindowSize(
    model,
    querySource,
    contextWindowOverride,
  )

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
    querySource,
    contextWindowOverride,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
    toolUseContext.options.contextWindowTokens,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(
      model,
      querySource,
      toolUseContext.options.contextWindowTokens,
    ),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
