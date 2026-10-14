import { expect, test } from 'bun:test'
import { ANTI_REPETITION_DEFAULTS, isAntiRepetitionQuerySource, resolveAntiRepetitionConfig } from './config.js'

test('uses centralized defaults and does not share mutable objects', () => {
  expect(resolveAntiRepetitionConfig()).toEqual({ enabled: true,
    autoResume: true, maxRecoveries: 2, maxCyclePeriod: 512, cycleMinChars: 512,
    lineRepeatedMinChars: 2048, lineCoverageMin: 0.6, lineConcentrationMin: 4 })
  expect(resolveAntiRepetitionConfig({ enabled: true, autoResume: false, maxRecoveries: 0 }))
    .toMatchObject({ enabled: true, autoResume: false, maxRecoveries: 0 })
  const config = resolveAntiRepetitionConfig({ enabled: undefined })
  config.enabled = true
  expect(ANTI_REPETITION_DEFAULTS.enabled).toBe(true)
  expect(resolveAntiRepetitionConfig().enabled).toBe(true)
})

test('bounds resource limits and rejects non-finite inputs in the TypeScript resolver', () => {
  expect(resolveAntiRepetitionConfig({ maxCyclePeriod: 999999, maxRecoveries: -1,
    cycleMinChars: Infinity, lineRepeatedMinChars: 999999,
    lineCoverageMin: -1, lineConcentrationMin: 999 }))
    .toMatchObject({ maxCyclePeriod: 512, maxRecoveries: 0, cycleMinChars: 512,
      lineRepeatedMinChars: 65536, lineCoverageMin: 0, lineConcentrationMin: 256 })
})

test('allows only primary loop sources and skips auxiliary requests', () => {
  for (const source of ['sdk', 'repl_main_thread', 'repl_main_thread:outputStyle:custom',
    'agent:default', 'agent:custom', 'agent:builtin:Explore']) expect(isAntiRepetitionQuerySource(source)).toBe(true)
  for (const source of ['', 'sdk_extra', 'repl_main_thread_fake', 'agent:builtin:', 'agent:unknown',
    'advisor', 'session_memory', 'web_search_tool', 'prompt_suggestion', 'speculation',
    'tool_use_summary_generation', 'auto_dream', 'rename_generate_name']) expect(isAntiRepetitionQuerySource(source)).toBe(false)
})
