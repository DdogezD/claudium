// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { resolveModelProfileModel, resolveAdvisorEnabled } from './model/modelProfiles.js'
import { applyModelOverride } from './model/modelStrings.js'

export function getAdvisorModel(): string | undefined {
  // Explicitly disabled overrides any model configuration.
  const enabled = resolveAdvisorEnabled()
  if (enabled === false) return undefined

  const model =
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
    resolveModelProfileModel('advisor') ||
    undefined
  return model ? applyModelOverride(model) : undefined
}

/** Read advisor model from an explicit modelProfiles object (reactive, no cache). */
export function getAdvisorModelFromProfiles(
  modelProfiles: { advisor?: { enabled?: boolean; model?: string } } | undefined,
): string | undefined {
  // Explicitly disabled overrides any model configuration.
  const enabled = modelProfiles?.advisor?.enabled
  if (enabled === false) return undefined

  const model =
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
    modelProfiles?.advisor?.model ||
    undefined
  return model ? applyModelOverride(model) : undefined
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
