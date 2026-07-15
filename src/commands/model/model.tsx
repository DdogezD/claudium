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
import type { EffortLevel } from '../../utils/effort.js'
import { modelSupportsEffort, resolveAppliedEffort } from '../../utils/effort.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { formatTokenCount, formatProfileSummary, getModelProfile, resolveModelProfileModel } from '../../utils/model/modelProfiles.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { validateModel } from '../../utils/model/validateModel.js'

function ShowAllProfiles({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const effectiveModel = useMainLoopModel()
  // Resolve effort through the same chain as the API, with the same
  // capability gate — if the model doesn't support effort, don't show it.
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
  if (mainLoopModelForSession) {
    lines.push(`  (overridden for this session: ${chalk.bold(renderModelLabel(mainLoopModelForSession))})`)
  }
  lines.push(`${chalk.bold('Advisor model')}:   ${formatProfileSummary(getModelProfile('advisor'))}`)
  lines.push(`${chalk.bold('Subagent model')}:  ${formatProfileSummary(getModelProfile('subagent'))}`)
  lines.push('')
  lines.push(`Configure with ${chalk.bold('/config')}. Run ${chalk.bold('/model [model]')} to switch the main model temporary.`)
  onDone(lines.join('\n'))
  return null
}

function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(`Model '${model}' is not available. Your organization restricts model selection.`, {
          display: 'system',
        })
        return
      }

      if (model && isOpus1mUnavailable(model)) {
        onDone(
          `Opus 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          `Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      if (!model) {
        setModel(null)
        return
      }

      if (isKnownAlias(model)) {
        setModel(model)
        return
      }

      try {
        const { valid, error } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, { display: 'system' })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, { display: 'system' })
      }
    }

    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))}`

      let wasFastModeToggledOn = undefined
      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({ ...prev, fastMode: false }))
          wasFastModeToggledOn = false
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast mode ON`
          wasFastModeToggledOn = true
        }
      }

      if (isBilledAsExtraUsage(modelValue, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
        message += ` · Billed as extra usage`
      }
      if (wasFastModeToggledOn === false) {
        message += ` · Fast mode OFF`
      }
      onDone(message)
    }

    void handleModelChange()
  }, [model, onDone, setAppState])

  return null
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim())
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return !checkOpus1mAccess() && !isOpus1mMergeEnabled() && m.includes('opus') && m.includes('[1m]')
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return !checkSonnet1mAccess() && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Run /model to view all model profiles, or /model [name] to switch the main model.', {
      display: 'system',
    })
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
  const effective =
    model ??
    (process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      resolveModelProfileModel('main')) ??
    getDefaultMainLoopModelSetting()
  const rendered = renderDefaultModelSetting(effective)
  return model === null ? `${rendered} (default)` : rendered
}
