import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getGlobalConfig } from '../config.js'
import { isModelAllowed } from './modelAllowlist.js'
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

export function getModelOptions(): ModelOption[] {
  const options: ModelOption[] = [getDefaultOptionForUser()]
  const configuredOption = getConfiguredModelOption()
  if (configuredOption && configuredOption.value !== null) {
    options.push(configuredOption)
  }

  for (const option of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === option.value)) {
      options.push(option)
    }
  }

  return filterModelOptionsByAllowlist(options)
}
