// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { resolveModelProfileEffort } from './model/modelProfiles.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = string | number

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Supported by a subset of Claude 4 models
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }
  // Default to true for unknown model strings on 1P.
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (model.toLowerCase().includes('opus-4-6')) {
    return true
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).trim()
  if (str.length > 0) return str
  return undefined
}

export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  const profile = resolveModelProfileEffort('main')
  return (profile || undefined) as EffortLevel | undefined
}

export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

export function getSubagentEffortEnvOverride(): EffortValue | null | undefined {
  const v = process.env.CLAUDE_CODE_SUBAGENT_EFFORT_LEVEL
  if (!v) return undefined
  return v.toLowerCase() === 'unset' || v.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(v)
}

export function getAdvisorEffortEnvOverride(): EffortValue | null | undefined {
  const v = process.env.CLAUDE_CODE_ADVISOR_EFFORT_LEVEL
  if (!v) return undefined
  return v.toLowerCase() === 'unset' || v.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(v)
}

/**
 * Resolve the effort value sent to the API for a given model.
 * Precedence: scope env → CLAUDE_CODE_EFFORT_LEVEL → modelProfiles → appState → model default
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  scope?: 'subagent' | 'advisor',
): EffortValue | undefined {
  const scopeOverride =
    scope === 'subagent'
      ? getSubagentEffortEnvOverride()
      : scope === 'advisor'
        ? getAdvisorEffortEnvOverride()
        : undefined
  const envOverride =
    scopeOverride !== undefined ? scopeOverride : getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const profileEffort = resolveModelProfileEffort(scope ?? 'main')
  const resolved =
    envOverride ?? (profileEffort as EffortValue | undefined) ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  return resolved
}

/**
 * Resolve the effort value for display. Returns the raw string (passes through
 * any arbitrary effort name), falling back to 'high' when nothing is configured.
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort)
  return (typeof resolved === 'string' ? resolved : 'high') as EffortLevel
}

/**
 * Build the effort suffix for Logo/Spinner display.
 * Passes through the raw effort string as-is.
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` · ${resolved}`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum available reasoning effort for this model'
  }
}

export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }
  if (typeof value === 'string') {
    if (isEffortLevel(value)) return getEffortLevelDescription(value)
    return `Reasoning effort: ${value}`
  }
  return 'Balanced approach with standard implementation and testing'
}

export type EffortDefaultConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const DEFAULT_EFFORT_CONFIG: EffortDefaultConfig = {
  enabled: false,
  dialogTitle: 'Configure reasoning effort',
  dialogDescription: 'Choose the reasoning effort for the selected model.',
}

export function getEffortDefaultConfig(): EffortDefaultConfig {
  return DEFAULT_EFFORT_CONFIG
}

export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    return undefined
  }
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }
  return undefined
}
