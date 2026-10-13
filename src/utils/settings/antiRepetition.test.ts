import { expect, test } from 'bun:test'
import mergeWith from 'lodash-es/mergeWith.js'
import { resolveAntiRepetitionConfig } from '../../services/antiRepetition/config.js'
import { buildQueryConfig } from '../../query/config.js'
import { getSessionSettingsCache, resetSettingsCache, setSessionSettingsCache } from './settingsCache.js'
import { AntiRepetitionSettingsSchema, SettingsSchema } from './types.js'

test('antiRepetition fields are optional and source parsing does not inject defaults', () => {
  expect(AntiRepetitionSettingsSchema().parse({})).toEqual({})
  expect(SettingsSchema().parse({})).not.toHaveProperty('antiRepetition')
  expect(SettingsSchema().parse({ antiRepetition: { text: true } }).antiRepetition).toEqual({ text: true })
})

test('fills defaults after merging sources without overriding explicit lower-priority settings', () => {
  const low = SettingsSchema().parse({ antiRepetition: { enabled: true, reasoning: false, maxRecoveries: 0 } })
  const high = SettingsSchema().parse({ antiRepetition: { text: true } })
  const merged = mergeWith({}, low, high)
  expect(resolveAntiRepetitionConfig(merged.antiRepetition)).toMatchObject({
    enabled: true, reasoning: false, text: true, maxRecoveries: 0, autoResume: true,
  })
  const override = SettingsSchema().parse({ antiRepetition: { enabled: false } })
  expect(resolveAntiRepetitionConfig(mergeWith({}, merged, override).antiRepetition).enabled).toBe(false)
})

test('query config reads a merged snapshot without sharing mutable settings objects', () => {
  const previous = getSessionSettingsCache()
  try {
    const settings = SettingsSchema().parse({ antiRepetition: { enabled: true, text: true, maxRecoveries: 1 } })
    setSessionSettingsCache({ settings, errors: [] })
    const snapshot = buildQueryConfig()
    expect(snapshot.antiRepetition).toMatchObject({ enabled: true, text: true, reasoning: true, maxRecoveries: 1 })
    settings.antiRepetition!.enabled = false
    expect(snapshot.antiRepetition.enabled).toBe(true)
    expect(buildQueryConfig().antiRepetition.enabled).toBe(false)
  } finally {
    if (previous) setSessionSettingsCache(previous)
    else resetSettingsCache()
  }
})

test('enforces Zod numeric ranges and integer limits', () => {
  const bounds = {
    maxRecoveries: [0, 10], maxCyclePeriod: [1, 512], reasoningCycleMinChars: [3, 65536],
    textCycleMinChars: [3, 65536], lineRepeatedMinChars: [1, 65536],
    lineCoverageMin: [0, 1], lineConcentrationMin: [1, 256],
  }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    for (const value of [min, max]) expect(AntiRepetitionSettingsSchema().safeParse({ [key]: value }).success).toBe(true)
    for (const value of [min! - 1, max! + 1, NaN, Infinity, '2']) {
      expect(AntiRepetitionSettingsSchema().safeParse({ [key]: value }).success).toBe(false)
    }
    if (!['lineCoverageMin', 'lineConcentrationMin'].includes(key)) {
      expect(AntiRepetitionSettingsSchema().safeParse({ [key]: min! + 0.5 }).success).toBe(false)
    }
  }
  for (const key of ['enabled', 'reasoning', 'text', 'autoResume']) {
    expect(AntiRepetitionSettingsSchema().safeParse({ [key]: 'false' }).success).toBe(false)
    expect(AntiRepetitionSettingsSchema().parse({ [key]: false })).toEqual({ [key]: false })
  }
})
