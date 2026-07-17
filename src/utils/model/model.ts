// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getSubscriptionType, isProSubscriber } from '../auth.js'
import { is1mContextDisabled } from '../context.js'
import {
  applyModelOverride,
  getModelStrings,
  resolveOverriddenModel,
} from './modelStrings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider } from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import { resolveModelProfileModel } from './modelProfiles.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | null

function getProviderModelEnvironmentVariable(): string | undefined {
  const value =
    getAPIProvider() === 'openai'
      ? process.env.OPENAI_MODEL
      : process.env.ANTHROPIC_MODEL
  const trimmed = value?.trim()
  return trimmed || undefined
}

function getConfiguredMainLoopModel(): ModelName | undefined {
  return getProviderModelEnvironmentVariable() ?? resolveModelProfileModel('main')
}

function requireConfiguredMainLoopModel(): ModelName {
  const model = getConfiguredMainLoopModel()
  if (model) return model
  throw new Error(
    'No model is configured. Set the provider-specific model environment variable or configure modelProfiles.main.model.',
  )
}

export function getMainLoopModelSetting(): ModelSetting | undefined {
  return getMainLoopModelOverride() ?? getConfiguredMainLoopModel()
}

export function getSmallFastModel(): ModelName {
  const configuredOverride =
    getAPIProvider() === 'openai'
      ? process.env.OPENAI_MODEL
      : process.env.ANTHROPIC_SMALL_FAST_MODEL
  const providerOverride = configuredOverride?.trim() || undefined
  return applyModelOverride(
    providerOverride ??
      resolveModelProfileModel('subagent') ??
      requireConfiguredMainLoopModel(),
  )
}

/**
 * Resolve the model explicitly selected for the active provider.
 * Undefined means the user has not configured a model yet.
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  const specifiedModel = getMainLoopModelSetting()

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/** Get the main loop model selected for the current session. */
export function getMainLoopModel(): ModelName {
  const specifiedModel = getMainLoopModelSetting()
  if (!specifiedModel) {
    throw new Error(
      'No model is configured. Set the provider-specific model environment variable or configure modelProfiles.main.model.',
    )
  }
  if (!isModelAllowed(specifiedModel)) {
    throw new Error(`Model '${specifiedModel}' is not available.`)
  }
  return parseUserSpecifiedModel(specifiedModel)
}

/**
 * Get the model to use for runtime. The active model is always selected
 * explicitly by the session, provider configuration, or model profile.
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  return params.mainLoopModel
}

/**
 * Return the explicitly configured main model.
 *
 * There is intentionally no built-in Anthropic model fallback. A provider/model
 * must be selected through an environment variable or model profile.
 */
export function getDefaultMainLoopModelSetting(): ModelName {
  const model = requireConfiguredMainLoopModel()
  if (!isModelAllowed(model)) {
    throw new Error(`Model '${model}' is not available.`)
  }
  return model
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

export function renderDefaultModelSetting(
  setting: ModelName,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and extra-usage billing
  // would be applied without confirmed subscription data.
  if (getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName): string {
  return renderModelName(setting)
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      return maskModelCodename(antModel.model)
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns the configured model ID for use in this session.
 *
 * Model family aliases and context suffixes are unsupported. Explicit model IDs
 * are preserved except for exact configured provider overrides.
 *
 * @param modelInput The explicit model ID provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(
      normalizedModel,
    )
    if (antModel) {
      return applyModelOverride(antModel.model)
    }
  }

  // Preserve original case and any provider-specific syntax for explicit model IDs.
  return applyModelOverride(modelInputTrimmed)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    // null = "re-resolve from env/profile/default".  Show the effective model.
    return `Default (${getMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}
