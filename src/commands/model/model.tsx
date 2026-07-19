import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics-stub.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { modelSupportsEffort, resolveAppliedEffort } from '../../utils/effort.js'
import {
  formatTokenCount,
  formatProfileSummary,
  getModelProfile,
} from '../../utils/model/modelProfiles.js'
import {
  getMainLoopModelSetting,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

function ShowAllProfiles({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const effortValue = useAppState(s => s.effortValue)
  const effectiveModel = useMainLoopModel()
  const effectiveEffort =
    modelSupportsEffort(effectiveModel)
      ? resolveAppliedEffort(effectiveModel, effortValue)
      : undefined
  const mainProfile = getModelProfile('main')
  const mainParts = [
    renderModelLabel(mainLoopModel),
    mainProfile.contextWindowTokens ? formatTokenCount(mainProfile.contextWindowTokens) : 'auto',
    effectiveEffort ?? 'auto',
  ]

  let lines = [`${chalk.bold('Model')}:           ${mainParts.join(' · ')}`]
  lines.push(`${chalk.bold('Subagent model')}:  ${formatProfileSummary(getModelProfile('subagent'), 'subagent')}`)
  lines.push(`${chalk.bold('Advisor model')}:   ${formatProfileSummary(getModelProfile('advisor'), 'advisor')}`)
  lines.push('')
  lines.push(`Run ${chalk.bold('/model [model]')} to set the main model. Add ${chalk.bold('[context]')} (e.g. 200000) and ${chalk.bold('[effort]')} (low/medium/high/max) to configure the profile.`)
  onDone(lines.join('\n'))
  return null
}

const VALID_EFFORT = new Set(['low', 'medium', 'high', 'max'])

/**
 * Parse /model args — supports "model [context] [effort]" in any order.
 * Context can be raw digits (200000), K-suffix (200K), or M-suffix (1M).
 */
function parseModelArgs(raw: string): {
  model: string | null
  contextWindowTokens?: number
  reasoningEffort?: string
  error?: string
} {
  // Split on whitespace; tolerate multiple spaces
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts[0] === 'default') {
    return { model: null }
  }

  const model = parts[0]!
  let contextWindowTokens: number | undefined
  let reasoningEffort: string | undefined

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!
    // Try parse as context: raw digits, or with K/M suffix
    const ctxMatch = /^(\d+)([kKmM]?)$/.exec(p)
    if (ctxMatch) {
      let num = parseInt(ctxMatch[1]!, 10)
      if (ctxMatch[2]!.toLowerCase() === 'k') num *= 1000
      else if (ctxMatch[2]!.toLowerCase() === 'm') num *= 1_000_000
      if (num < 1000) {
        return { model, error: `Context window too small: ${p}` }
      }
      contextWindowTokens = num
      continue
    }
    // Try parse as effort
    if (VALID_EFFORT.has(p.toLowerCase())) {
      reasoningEffort = p.toLowerCase()
      continue
    }
    return { model, error: `Unrecognised argument: ${p}` }
  }

  return { model, contextWindowTokens, reasoningEffort }
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const parsed = parseModelArgs(args)

  React.useEffect(() => {
    async function apply(): Promise<void> {
      if (parsed.error) {
        onDone(parsed.error, { display: 'system' })
        return
      }

      const model = parsed.model

      if (model && !isModelAllowed(model)) {
        onDone(`Model '${model}' is not available. Your organization restricts model selection.`, {
          display: 'system',
        })
        return
      }

      if (model) {
        try {
          const { valid, error } = await validateModel(model)
          if (!valid) {
            onDone(error || `Model '${model}' not found`, { display: 'system' })
            return
          }
        } catch (error) {
          onDone(`Failed to validate model: ${(error as Error).message}`, { display: 'system' })
          return
        }
      }

      // Build the persisted profile update
      const main: Record<string, unknown> = {}
      if (model !== undefined) main.model = model
      if (parsed.contextWindowTokens !== undefined) {
        main.contextWindowTokens = parsed.contextWindowTokens
      }
      if (parsed.reasoningEffort !== undefined) {
        main.reasoningEffort = parsed.reasoningEffort
      }

      // Persist to user settings
      const result = updateSettingsForSource('userSettings', {
        model: undefined,
        modelProfiles: { main: Object.keys(main).length > 0 ? main : undefined },
      })
      if (result.error) {
        onDone(`Failed to save settings: ${result.error.message}`, { display: 'system' })
        return
      }

      // Apply to current session
      setAppState(prev => ({
        ...prev,
        mainLoopModel: model,
      }))

      // Build success message
      const profile = getModelProfile('main')
      const summary = formatProfileSummary(profile, 'main')
      onDone(`Set model to ${chalk.bold(summary)}`)
    }

    void apply()
  }, [])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Run /model to view all model profiles, or /model [model] [context] [effort] to configure the main model profile.',
      { display: 'system' },
    )
    return
  }

  if (args && !COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={args} onDone={onDone} />
  }

  return <ShowAllProfiles onDone={onDone} />
}

function renderModelLabel(model: string | null): string {
  const effective = model ?? getMainLoopModelSetting()
  if (!effective) return 'Not configured'
  const rendered = renderDefaultModelSetting(effective)
  return model === null ? `${rendered} (configured)` : rendered
}
