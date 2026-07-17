import { getSettings_DEPRECATED } from '../settings/settings.js'
import { resolveOverriddenModel } from './modelStrings.js'

/**
 * Check whether a model ID is allowed by the configured exact-model allowlist.
 * If availableModels is not set, all model IDs are allowed.
 */
export function isModelAllowed(model: string): boolean {
  const settings = getSettings_DEPRECATED() || {}
  const { availableModels } = settings
  if (!availableModels) return true
  if (availableModels.length === 0) return false

  const resolvedModel = resolveOverriddenModel(model).trim().toLowerCase()
  return availableModels.some(
    entry =>
      resolveOverriddenModel(entry).trim().toLowerCase() === resolvedModel,
  )
}
