export type AntiRepetitionConfig = {
  enabled: boolean
  autoResume: boolean
  maxRecoveries: number
  maxCyclePeriod: number
  cycleMinChars: number
  lineRepeatedMinChars: number
  lineCoverageMin: number
  lineConcentrationMin: number
}

export type RepetitionHit = {
  code: 'REASONING_LOOP'
  rule: 'trailing-cycle' | 'phrase-pool'
  observedChars: number
  repeatedChars: number
  stats?: {
    period?: number
    eligibleLines?: number
    uniqueLines?: number
    coverage?: number
    concentration?: number
    uniqueRatio?: number
  }
}

export type RepetitionSseEvent = {
  type: string
  index?: number
  content_block?: { type: string }
  delta?: { type: string; thinking?: string }
}
