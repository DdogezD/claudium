import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let configuredModel: string | undefined
let initialModel: string | undefined
let profiles: Record<string, { model?: string }> = {}
let settings: { availableModels?: string[] } = {}
let discovered: { id: string; displayName?: string }[] = []
let additional: { value: string; label: string; description: string }[] = []

mock.module('../../bootstrap/state.js', () => ({ getInitialMainLoopModel: () => initialModel }))
mock.module('../settings/settings.js', () => ({ getSettings_DEPRECATED: () => settings }))
mock.module('../config.js', () => ({ getGlobalConfig: () => ({ additionalModelOptionsCache: additional }) }))
mock.module('./modelAllowlist.js', () => ({
  isModelAllowed: (model: string) => settings.availableModels === undefined
    || settings.availableModels.some(id => id.toLowerCase() === model.toLowerCase()),
}))
mock.module('./modelDiscovery.js', () => ({ getDiscoveredModels: () => discovered }))
mock.module('./modelProfiles.js', () => ({ getModelProfiles: () => profiles }))
mock.module('./model.js', () => ({
  getUserSpecifiedModelSetting: () => configuredModel,
  parseUserSpecifiedModel: (model: string) => model,
  renderModelName: (model: string) => model,
}))

const { getModelOptions } = await import('./modelOptions.js')
const originalSmallFast = process.env.ANTHROPIC_SMALL_FAST_MODEL
const originalCustom = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

beforeEach(() => {
  configuredModel = undefined
  initialModel = undefined
  profiles = {}
  settings = {}
  discovered = []
  additional = []
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
})

afterAll(() => {
  if (originalSmallFast === undefined) delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  else process.env.ANTHROPIC_SMALL_FAST_MODEL = originalSmallFast
  if (originalCustom === undefined) delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  else process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = originalCustom
  mock.restore()
})

describe('model option sources', () => {
  test('does not invent built-in models when no provider model is configured', () => {
    expect(getModelOptions().map(option => option.value)).toEqual([null])
  })

  test('includes configured, current session and all explicit profile models', () => {
    configuredModel = 'configured'
    profiles = { main: { model: 'main' }, subagent: { model: 'sub' }, advisor: { model: 'advisor' } }
    expect(getModelOptions('session').map(option => option.value))
      .toEqual([null, 'configured', 'session', 'main', 'sub', 'advisor'])
  })

  test('includes custom options, small-fast models and exact configured allowlist IDs', () => {
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'small'
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'custom'
    settings.availableModels = ['small', 'custom', 'listed']
    expect(getModelOptions().map(option => option.value)).toEqual([null, 'small', 'custom', 'listed'])
  })

  test('merges the current endpoint directory, preserving raw ID casing', () => {
    configuredModel = 'provider/Model-A'
    discovered = [
      { id: 'provider/Model-A', displayName: 'Model A' },
      { id: 'provider/Model-B', displayName: 'Model B' },
    ]
    const options = getModelOptions()
    expect(options.map(option => option.value)).toEqual([null, 'provider/Model-A', 'provider/Model-B'])
    expect(options.find(option => option.value === configuredModel)?.label).toBe('Model A')
  })

  test('deduplicates model sources and still reads legacy configured options', () => {
    configuredModel = 'same'
    initialModel = 'initial'
    profiles.main = { model: 'same' }
    discovered = [{ id: 'same' }]
    additional = [
      { value: 'same', label: 'Duplicate', description: '' },
      { value: 'legacy', label: 'Legacy', description: '' },
    ]
    expect(getModelOptions('same').map(option => option.value)).toEqual([null, 'same', 'legacy'])
  })

  test('filters all candidate sources by allowlist without removing default', () => {
    configuredModel = 'blocked'
    profiles.advisor = { model: 'also-blocked' }
    discovered = [{ id: 'Allowed' }, { id: 'remote-blocked' }]
    additional = [{ value: 'legacy-blocked', label: 'Blocked', description: '' }]
    settings.availableModels = ['Allowed']
    expect(getModelOptions('session-blocked').map(option => option.value)).toEqual([null, 'Allowed'])
    settings.availableModels = []
    expect(getModelOptions().map(option => option.value)).toEqual([null])
  })

  test('does not retain a previous endpoint directory in local options', () => {
    discovered = [{ id: 'old-endpoint-model' }]
    expect(getModelOptions().map(option => option.value)).toEqual([null, 'old-endpoint-model'])
    discovered = []
    expect(getModelOptions().map(option => option.value)).toEqual([null])
  })
})
