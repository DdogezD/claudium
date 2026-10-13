import { expect, test } from 'bun:test'
import { createAntiRepetitionPrompt } from './prompt.js'
import type { RepetitionHit } from './types.js'

test('Recovery prompt uses hit metadata without replaying thinking', () => {
  for (const channel of ['thinking', 'text'] as const) {
    const hit: RepetitionHit = { channel, code: channel === 'thinking' ? 'REASONING_LOOP' : 'TEXT_LOOP',
      rule: 'trailing-cycle', observedChars: 512, repeatedChars: 512 }
    const prompt = createAntiRepetitionPrompt(hit)
    expect(prompt).toContain(hit.code)
    expect(prompt).toContain('Continue the original unfinished task')
    expect(prompt).toContain('This was not output token exhaustion')
    expect(prompt).toContain('repeat reasoning')
    expect(prompt).toContain('repeat completed tool operations')
    expect(prompt).toContain('different concrete path')
    expect(prompt).not.toContain('512')
  }
})
