import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getGlobalConfig } from '../config.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getDiscoveredModels } from './modelDiscovery.js'
import { getModelProfiles } from './modelProfiles.js'
import {
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
  renderModelName,
  type ModelSetting,
} from './model.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(): ModelOption {
  return {
    value: null,
    label: 'Default',
    description: 'Use the configured model for this provider',
    descriptionForModel: 'Configured provider model',
  }
}

function getConfiguredModelOption(): ModelOption | undefined {
  const configuredModel = getUserSpecifiedModelSetting() ?? getInitialMainLoopModel()
  if (configuredModel === undefined || configuredModel === null) {
    return undefined
  }

  let label = configuredModel
  try {
    label = renderModelName(parseUserSpecifiedModel(configuredModel))
  } catch {
    // Legacy aliases without an explicit model remain visible so users can
    // replace them from the picker or /model command.
  }

  return {
    value: configuredModel,
    label,
    description: configuredModel,
    descriptionForModel: configuredModel,
  }
}

function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) return options
  return options.filter(
    option =>
      option.value === null ||
      (option.value !== null && isModelAllowed(option.value)),
  )
}

export function getModelOptions(sessionModel?: ModelSetting): ModelOption[] {
  const options: ModelOption[] = [getDefaultOptionForUser()]
  const configuredOption = getConfiguredModelOption()
  if (configuredOption && configuredOption.value !== null) {
    options.push(configuredOption)
  }

  const profiles = getModelProfiles()
  const settings = getSettings_DEPRECATED() || {}
  const localModels = [
    sessionModel,
    profiles.main?.model,
    profiles.subagent?.model,
    profiles.advisor?.model,
    process.env.ANTHROPIC_SMALL_FAST_MODEL,
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
    ...(settings.availableModels ?? []),
  ]
  const byId = new Map(options.map(option => [option.value, option]))
  for (const model of localModels) {
    if (model && !byId.has(model)) {
      const option = { value: model, label: model, description: 'Configured model' }
      options.push(option)
      byId.set(model, option)
    }
  }

  for (const model of getDiscoveredModels()) {
    const existing = byId.get(model.id)
    const displayName = model.displayName?.trim()
    if (existing && displayName) existing.label = displayName
    if (!existing) {
      const option: ModelOption = {
        value: model.id,
        label: displayName ?? model.id,
        description: 'Model available from the current endpoint',
      }
      options.push(option)
      byId.set(model.id, option)
    }
  }

  for (const option of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!byId.has(option.value)) {
      options.push(option)
      byId.set(option.value, option)
    }
  }

  return filterModelOptionsByAllowlist(options)
}
