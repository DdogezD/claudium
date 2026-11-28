import { describe, expect, test } from 'bun:test'
import { buildNotMatchedHint, findActualString } from './utils.js'

describe('Edit indentation mismatch hints', () => {
  test('pinpoints the differing line and returns an exact retry', () => {
    const prefix = ['if (ready) {', '  write(', '    ready,', '    rate /'].join('\n')
    const actual = `${prefix}\n${' '.repeat(41)}total);`
    const oldString = `${prefix}\n${' '.repeat(37)}total);`
    const file = `// context\n${actual}\n}\n`

    expect(findActualString(file, oldString)).toBeNull()
    const hint = buildNotMatchedHint(file, oldString)
    expect(hint).toContain('line 6: expected 41 leading spaces, got 37')
    expect(JSON.parse(hint.split('\n').at(-1)!)).toBe(actual)
  })

  test('preserves tabs, mixed indentation and a selected final newline', () => {
    const actual = 'write(\n \tvalue);\n'
    const file = `${actual}done();`
    const hint = buildNotMatchedHint(file, 'write(\n\t value);\n')

    expect(hint).toContain('line 2')
    expect(JSON.parse(hint.split('\n').at(-1)!)).toBe(actual)
  })

  test('finds a unique candidate after a repeated partial match', () => {
    const actual = '  row\n   row\n    done'
    const hint = buildNotMatchedHint(` row\n${actual}`, 'row\nrow\n  done')

    expect(hint).toContain('line 2: expected 2 leading spaces, got 0')
    expect(JSON.parse(hint.split('\n').at(-1)!)).toBe(actual)
  })

  test('does not suggest a retry for overlapping indentation-only candidates', () => {
    const hint = buildNotMatchedHint('  row\n    row\n      row', ' row\n row')

    expect(hint).toContain('File context around line 1')
    expect(hint).not.toContain('Exact old_string')
  })

  test('does not suggest a retry that would match multiple exact substrings', () => {
    const file = 'write(\n    value);\nbefore_write(\n    value);'
    const hint = buildNotMatchedHint(file, 'write(\n  value);')

    expect(hint).not.toContain('Exact old_string')
  })

  test('retains context for differences other than leading indentation', () => {
    const hint = buildNotMatchedHint('write(\n    first + second);', 'write(\n  first+second);')

    expect(hint).toContain('File context around line 1')
    expect(hint).not.toContain('Exact old_string')
  })
})
