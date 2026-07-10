import chalk from 'chalk'
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getAdvisorModel } from '../utils/advisor.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { validateModel } from '../utils/model/validateModel.js'

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
      value: `Advisor: ${chalk.bold(current)}\nUse "/advisor unset" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    return {
      type: 'text',
      value: prev
        ? `Set advisor model to ${chalk.bold('default')} (was ${chalk.bold(prev)})`
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

  return {
    type: 'text',
    value: `Set advisor model to ${chalk.bold(normalizedModel)}`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  get description() {
    const model = getAdvisorModel()
    return model
      ? `Configure advisor model (currently ${model})`
      : 'Configure advisor model (currently disabled)'
  },
  argumentHint: '[<model>|off]',
  get isHidden() {
    return false
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
