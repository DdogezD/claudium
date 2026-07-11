import chalk from 'chalk'
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getAdvisorModel } from '../utils/advisor.js'

const call: LocalCommandCall = async (_args, _context) => {
  const model = getAdvisorModel()
  if (!model) {
    return {
      type: 'text',
      value:
        'Advisor: not set\n' +
        'Set CLAUDE_CODE_ADVISOR_MODEL environment variable to enable.',
    }
  }
  return {
    type: 'text',
    value: `Advisor: ${chalk.bold(model)} (from env)`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  get description() {
    const model = getAdvisorModel()
    return model
      ? `Show advisor model (currently ${model})`
      : 'Show advisor model (currently disabled)'
  },
  argumentHint: '',
  get isHidden() {
    return false
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
