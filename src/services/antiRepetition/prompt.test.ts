import { expect, test } from 'bun:test'
import { createAntiRepetitionPrompt } from './prompt.js'
import type { RepetitionHit } from './types.js'

test('Recovery prompt uses reasoning hit metadata without replaying thinking', () => {
  const hit: RepetitionHit = {
    code: 'REASONING_LOOP', rule: 'trailing-cycle', observedChars: 512, repeatedChars: 512,
  }
  const prompt = createAntiRepetitionPrompt(hit)
  expect(prompt).toContain(hit.code)
  expect(prompt).toContain('reasoning output')
  expect(prompt).toContain('Continue the original unfinished task')
  expect(prompt).toContain('This was not output token exhaustion')
  expect(prompt).toContain('repeat reasoning')
  expect(prompt).toContain('repeat completed tool operations')
  expect(prompt).toContain('different concrete path')
  expect(prompt).not.toContain('512')
  expect(prompt).not.toContain('text output')
})
