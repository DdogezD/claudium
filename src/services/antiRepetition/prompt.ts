import type { RepetitionHit } from './types.js'

export function createAntiRepetitionPrompt(hit: RepetitionHit): string {
  return `The previous request's reasoning output entered a repetition loop (${hit.code}) and was discarded. Continue the original unfinished task from the valid context before this request. This was not output token exhaustion. Do not repeat reasoning or repeat completed tool operations. Use a different concrete path and proceed directly with the next step.`
}
