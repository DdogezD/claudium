import { describe, expect, it } from 'bun:test'
import { validateAdvisorBashInput } from './toolPolicy.js'

describe('validateAdvisorBashInput', () => {
  it.each([null, 'not an object', {}, { command: 42 }])(
    'denies malformed Bash input %#',
    input => {
      const result = validateAdvisorBashInput(input)
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.command).toBeNull()
    },
  )

  it('allows a read-only command using parsed schema data', () => {
    const result = validateAdvisorBashInput({
      command: 'git status --short',
      timeout: '1000',
      run_in_background: 'false',
    })
    expect(result.allowed).toBe(true)
    if (result.allowed) {
      expect(result.input.command).toBe('git status --short')
      expect(result.input.timeout).toBe(1000)
      expect(result.input.run_in_background).toBe(false)
    }
  })

  it('denies a mutating command', () => {
    const result = validateAdvisorBashInput({ command: 'touch should-not-exist' })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.command).toBe('touch should-not-exist')
  })
})
