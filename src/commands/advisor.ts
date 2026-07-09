import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { isAdvisorEnabled } from '../utils/advisor.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()

  if (!arg) {
    const current = context.getAppState().advisorModel
    if (!current) {
      return {
        type: 'text',
        value:
          'Advisor: not set\n' +
          'Use "/advisor <model>" to enable (e.g. "/advisor claude-opus-4-6").\n' +
          'Or set CLAUDE_CODE_ADVISOR_MODEL environment variable.',
      }
    }
    return {
      type: 'text',
      value: `Advisor: ${current}\nUse "/advisor unset" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return {
      type: 'text',
      value: prev
        ? `Advisor disabled (was ${prev}).`
        : 'Advisor already unset.',
    }
  }

  const resolvedModel = parseUserSpecifiedModel(arg)
  const { valid, error } = await validateModel(resolvedModel)
  if (!valid) {
    return {
      type: 'text',
      value: error
        ? `Invalid advisor model: ${error}`
        : `Unknown model: ${arg} (${resolvedModel})`,
    }
  }

  const normalizedModel = normalizeModelStringForAPI(resolvedModel)

  context.setAppState(s => {
    if (s.advisorModel === normalizedModel) return s
    return { ...s, advisorModel: normalizedModel }
  })
  updateSettingsForSource('userSettings', { advisorModel: normalizedModel })

  return {
    type: 'text',
    value: `Advisor set to ${normalizedModel}.`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  description:
    'Configure the advisor model',
  argumentHint: '[<model>|off]',
  isEnabled: () => isAdvisorEnabled(),
  get isHidden() {
    return false
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
