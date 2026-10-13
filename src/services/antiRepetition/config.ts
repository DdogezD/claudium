import type { AntiRepetitionConfig } from './types.js'
export type { AntiRepetitionConfig } from './types.js'

export const ANTI_REPETITION_DEFAULTS: Readonly<AntiRepetitionConfig> = Object.freeze({
  enabled: false,
  reasoning: true,
  text: false,
  autoResume: true,
  maxRecoveries: 2,
  maxCyclePeriod: 512,
  reasoningCycleMinChars: 512,
  textCycleMinChars: 256,
  lineRepeatedMinChars: 2048,
  lineCoverageMin: 0.6,
  lineConcentrationMin: 4,
})

export function resolveAntiRepetitionConfig(
  input?: Partial<AntiRepetitionConfig>,
): AntiRepetitionConfig {
  const result = { ...ANTI_REPETITION_DEFAULTS }
  for (const key of ['enabled', 'reasoning', 'text', 'autoResume'] as const) {
    if (typeof input?.[key] === 'boolean') result[key] = input[key]
  }
  const bounds = {
    maxRecoveries: [0, 10],
    maxCyclePeriod: [1, 512],
    reasoningCycleMinChars: [3, 65536],
    textCycleMinChars: [3, 65536],
    lineRepeatedMinChars: [1, 65536],
    lineCoverageMin: [0, 1],
    lineConcentrationMin: [1, 256],
  } as const
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = input?.[key]
    const [min, max] = bounds[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.max(min, Math.min(max,
        key === 'lineCoverageMin' || key === 'lineConcentrationMin'
          ? value : Math.trunc(value)))
    }
  }
  return result
}

export function isAntiRepetitionQuerySource(source: string): boolean {
  return source === 'sdk' || source === 'repl_main_thread' ||
    source.startsWith('repl_main_thread:outputStyle:') ||
    source === 'agent:default' || source === 'agent:custom' ||
    /^agent:builtin:.+/.test(source)
}
