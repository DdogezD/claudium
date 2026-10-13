import { describe, expect, test } from 'bun:test'
import {
  applyModelSuggestion,
  generateModelSuggestions,
  getModelCompletionToken,
} from './modelSuggestions.js'

const options = [
  { value: null, label: 'Default', description: 'Configured provider model' },
  { value: 'provider/Model-A:latest', label: 'Model A', description: 'Endpoint model' },
  { value: 'other-model', label: 'Other', description: 'Configured model' },
]

describe('model parameter token', () => {
  test('does not complete command names or other slash commands', () => {
    for (const input of ['/model', '/mod', '/models foo', '/resume foo', '/add-dir ./']) {
      expect(getModelCompletionToken(input, input.length)).toBeNull()
    }
  })

  test('completes an empty first argument, including multiple spaces and tabs', () => {
    for (const input of ['/model ', '/model   ', '/model\t']) {
      expect(getModelCompletionToken(input, input.length)).toEqual({
        start: input.length,
        end: input.length,
        query: '',
      })
    }
  })

  test('uses the prefix at the cursor but records the whole token', () => {
    expect(getModelCompletionToken('/model provider/old 200K max', 15)).toEqual({
      start: 7,
      end: 19,
      query: 'provider',
    })
  })

  test('does not complete inside the command or later arguments', () => {
    const input = '/model old 200K max'
    for (const cursor of [0, 3, 6, 11, 14, input.length]) {
      expect(getModelCompletionToken(input, cursor)).toBeNull()
    }
  })

  test('does not treat a newline as a command argument separator', () => {
    expect(getModelCompletionToken('/model\nfoo', 10)).toBeNull()
  })
})

describe('applying model candidates', () => {
  test('adds one separator after completing at the end', () => {
    expect(applyModelSuggestion('/model pro', 10, 'provider/Model-A:latest')).toEqual({
      newInput: '/model provider/Model-A:latest ',
      cursorPos: '/model provider/Model-A:latest '.length,
    })
  })

  test('replaces the entire first token while preserving context and custom effort', () => {
    expect(applyModelSuggestion('/model provider/old  200K custom-effort', 15, 'New/Model:1')).toEqual({
      newInput: '/model New/Model:1  200K custom-effort',
      cursorPos: 18,
    })
  })

  test('preserves leading separators, argument order and trailing whitespace', () => {
    expect(applyModelSuggestion('/model\told\tmax 1M ', 9, 'New')).toEqual({
      newInput: '/model\tNew\tmax 1M ',
      cursorPos: 10,
    })
  })

  test('does not accept a stale candidate outside the first argument', () => {
    expect(applyModelSuggestion('/model old 200K', 15, 'new')).toBeNull()
  })

  test('default replaces only the model token', () => {
    expect(applyModelSuggestion('/model old 200K max', 10, 'default')?.newInput)
      .toBe('/model default 200K max')
  })
})

describe('model candidate filtering', () => {
  test('uses exact provider IDs and default command semantics', () => {
    const suggestions = generateModelSuggestions(options, '')
    expect(suggestions.map(option => option.id)).toEqual(['default', 'provider/Model-A:latest', 'other-model'])
    expect(suggestions[1]?.displayText).toBe('provider/Model-A:latest')
    expect(suggestions[0]?.description).toContain('Reset')
  })

  test('matches IDs and display names without changing inserted casing', () => {
    expect(generateModelSuggestions(options, 'MODEL A').map(option => option.id))
      .toEqual(['provider/Model-A:latest'])
    expect(generateModelSuggestions(options, 'PROVIDER/').map(option => option.id))
      .toEqual(['provider/Model-A:latest'])
  })

  test('prefers ID prefix matches to substring matches', () => {
    const matches = generateModelSuggestions([
      { value: 'provider/model', label: 'provider/model', description: '' },
      { value: 'model-first', label: 'model-first', description: '' },
    ], 'model')
    expect(matches.map(option => option.id)).toEqual(['model-first', 'provider/model'])
  })

  test('prefers an exact model ID to longer matching names', () => {
    const matches = generateModelSuggestions([
      { value: 'model-longer', label: 'model-longer', description: '' },
      { value: 'model', label: 'model', description: '' },
    ], 'model')
    expect(matches.map(option => option.id)).toEqual(['model', 'model-longer'])
  })

  test('deduplicates exact IDs, not differently cased IDs', () => {
    const matches = generateModelSuggestions([
      { value: 'Model', label: 'Model', description: '' },
      { value: 'Model', label: 'Duplicate', description: '' },
      { value: 'model', label: 'model', description: '' },
    ], '')
    expect(matches.map(option => option.id)).toEqual(['Model', 'model'])
  })

  test('rejects whitespace, terminal controls, invisible ID characters and oversized IDs', () => {
    const invalid = ['', 'two words', 'new\nline', '\u001b[31mevil', 'a\u200bb', 'x'.repeat(513)]
    expect(generateModelSuggestions(invalid.map(value => ({ value, label: value, description: '' })), ''))
      .toEqual([])
  })

  test('sanitizes display descriptions and leaves manual IDs unvalidated', () => {
    expect(generateModelSuggestions([{ value: 'safe', label: 'safe', description: 'hello\u001b\nworld' }], '')[0]?.description)
      .toBe('hello  world')
    expect(generateModelSuggestions(options, 'unknown/manual-model')).toEqual([])
    expect(applyModelSuggestion('/model old', 10, 'unknown/manual-model')?.newInput)
      .toBe('/model unknown/manual-model ')
  })
})
