import { describe, expect, mock, test } from 'bun:test'
import chalk from 'chalk'
import { marked, type Tokens } from 'marked'
import { fileURLToPath } from 'node:url'
import { isValidElement } from 'react'
import { Parser } from '../ink/termio/parser.js'
import { defaultStyle, type TextStyle } from '../ink/termio/types.js'

const stubModule = (path: string, exports: Record<string, unknown>) =>
  mock.module(fileURLToPath(new URL(path, import.meta.url)), () => exports)

const Ansi = () => null
stubModule('../ink.js', { Ansi, useTheme: () => ['dark'] })
stubModule('../hooks/useTerminalSize.js', {
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
})
// Keep formatToken, padAligned, theme colors, and stringWidth real. These
// unrelated dependencies otherwise pull in session/configuration services.
stubModule('../utils/env.js', { env: { platform: 'linux', terminal: 'test' } })
stubModule('../utils/debug.js', { logForDebugging: () => {} })
stubModule('../utils/messages.js', { stripPromptXMLTags: (text: string) => text })
stubModule('../ink/supports-hyperlinks.js', { supportsHyperlinks: () => false })

const { MarkdownTable } = await import('./MarkdownTable.js')
// Do not let CI's non-TTY/NO_COLOR or the developer's tmux settings hide ANSI.
chalk.level = 3

// The current dark theme's permission color, used by real codespan formatting.
const CODE_COLOR = { type: 'rgb', r: 177, g: 185, b: 249 } as const
const COMMAND = '/ryzenai-imagegen'
type Glyph = { value: string; style: TextStyle }
type Line = Glyph[]
const textOf = (glyphs: Line) => glyphs.map(glyph => glyph.value).join('')
const nonBlank = (glyphs: Line) => glyphs.filter(glyph => glyph.value.trim())

function renderTable(source: string, forceWidth?: number): Line[] {
  const token = marked.lexer(source).find(token => token.type === 'table')
  expect(token?.type).toBe('table')
  const element = MarkdownTable({ token: token as Tokens.Table, highlight: null, forceWidth })
  if (!isValidElement<{ children: string }>(element)) {
    throw new Error('MarkdownTable must return an Ansi element')
  }
  expect(element.type).toBe(Ansi)
  expect(typeof element.props.children).toBe('string')

  // Parse the entire output as one stream: never reset style at a newline or
  // cell boundary, since a real terminal does not reset it there either.
  const parser = new Parser()
  const lines: Line[] = [[]]
  for (const action of parser.feed(element.props.children)) {
    if (action.type !== 'text') {
      throw new Error(`Unexpected terminal action: ${action.type}`)
    }
    for (const grapheme of action.graphemes) {
      if (grapheme.value === '\n') lines.push([])
      else lines[lines.length - 1]!.push({ value: grapheme.value, style: action.style })
    }
  }
  expect(parser.style).toEqual(defaultStyle())
  return lines
}

function bodyCells(lines: Line[]): Line[][] {
  expect(textOf(lines[0]!)).toStartWith('┌')
  expect(textOf(lines[lines.length - 1]!)).toStartWith('└')
  const separator = lines.findIndex(line => textOf(line).startsWith('├'))
  expect(separator).toBeGreaterThan(0)
  return lines.slice(separator + 1, -1).filter(line => textOf(line).startsWith('│')).map(line => {
    const cells: Line[] = []
    let cell: Line = []
    for (const glyph of line.slice(1)) {
      if (glyph.value === '│') {
        cells.push(cell)
        cell = []
      } else cell.push(glyph)
    }
    expect(cells).toHaveLength(2)
    return cells
  })
}

function column(rows: Line[][], index: number): Line {
  return rows.flatMap(row => nonBlank(row[index]!))
}

function expectCode(glyphs: Line, expected: string) {
  expect(textOf(glyphs)).toBe(expected)
  expect(glyphs.length).toBeGreaterThan(0)
  for (const glyph of glyphs) {
    expect(glyph.style.fg, `Code character ${JSON.stringify(glyph.value)}`).toEqual(CODE_COLOR)
    expect(glyph.style.bold).toBe(false)
  }
}

function expectPlain(glyphs: Line, expected: string) {
  expect(textOf(glyphs)).toBe(expected)
  for (const glyph of glyphs) {
    expect(glyph.style, `Plain character ${JSON.stringify(glyph.value)}`).toEqual(defaultStyle())
  }
}

function expectNeutralScaffolding(lines: Line[]) {
  const scaffolding = lines.flat().filter(glyph => /[\s│┌┬┐├┼┤└┴┘─]/u.test(glyph.value))
  expect(scaffolding.length).toBeGreaterThan(0)
  for (const glyph of scaffolding) {
    expect(glyph.style, `Border/padding ${JSON.stringify(glyph.value)}`).toEqual(defaultStyle())
  }
}

const commandTable = (command: string, neighbor = '生成图片') =>
  `| Cmd | Info |\n| --- | --- |\n| \`${command}\` | ${neighbor} |`

describe('MarkdownTable ANSI style boundaries', () => {
  test('keeps a short codespan local in a wide table using terminal columns', () => {
    const lines = renderTable(commandTable('/help'))
    const rows = bodyCells(lines)
    expect(rows).toHaveLength(1)
    expectCode(column(rows, 0), '/help')
    expectPlain(column(rows, 1), '生成图片')
    expectNeutralScaffolding(lines)
  })

  test.each([36, 37])('does not wrap code at or above the exact-fit boundary (width %i)', width => {
    // 17 code cells + 8 CJK cells + 7 borders/padding + 4 safety margin.
    const lines = renderTable(commandTable(COMMAND), width)
    const rows = bodyCells(lines)
    expect(rows).toHaveLength(1)
    expectCode(column(rows, 0), COMMAND)
    expectPlain(column(rows, 1), '生成图片')
    expectNeutralScaffolding(lines)
  })

  test('does not turn the Chinese neighbor blue when /ryzenai-imagegen hard-wraps', () => {
    const lines = renderTable(commandTable(COMMAND), 32)
    const rows = bodyCells(lines)
    expect(rows).toHaveLength(2)
    // Verify the screenshot's hard-wrap actually happened, not a fallback or
    // an unrelated word wrap that could accidentally make this test pass.
    expect(textOf(nonBlank(rows[0]![0]!))).toBe('/ryzenai-image')
    expect(textOf(nonBlank(rows[1]![0]!))).toBe('gen')
    expectPlain(column(rows, 1), '生成图片')
    expectCode(column(rows, 0), COMMAND)
  })

  test('closes code color before every border and padding on hard-wrapped lines', () => {
    const lines = renderTable(commandTable(COMMAND), 32)
    expect(bodyCells(lines)).toHaveLength(2)
    expectNeutralScaffolding(lines)
  })

  test('reopens code color on every nonblank continuation character in both columns', () => {
    const second = '/independent-code'
    const lines = renderTable(commandTable(COMMAND, `\`${second}\``), 39)
    const rows = bodyCells(lines)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(nonBlank(row[0]!).length).toBeGreaterThan(0)
      expect(nonBlank(row[1]!).length).toBeGreaterThan(0)
    }
    expectCode(column(rows, 0), COMMAND)
    expectCode(column(rows, 1), second)
    expectNeutralScaffolding(lines)
  })

  test('keeps independently wrapped code and bold cells from changing each other', () => {
    const bold = 'ABCDEFGHIJKLMNOPQ'
    const lines = renderTable(commandTable(COMMAND, `**${bold}**`), 39)
    const rows = bodyCells(lines)
    expect(rows).toHaveLength(2)
    expectCode(column(rows, 0), COMMAND)
    const boldGlyphs = column(rows, 1)
    expect(textOf(boldGlyphs)).toBe(bold)
    for (const glyph of boldGlyphs) {
      expect(glyph.style).toEqual({ ...defaultStyle(), bold: true })
    }
    expectNeutralScaffolding(lines)
  })

  test('contains wrapped code styles inside values in the vertical fallback', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'
    const lines = renderTable(commandTable(words, 'plain'), 24)
    expect(textOf(lines[0]!)).toStartWith('Cmd: ')
    expect(lines.some(line => textOf(line).startsWith('┌'))).toBe(false)
    const nextLabel = lines.findIndex(line => textOf(line).startsWith('Info: '))
    expect(nextLabel).toBeGreaterThan(1)
    const valueLines = lines.slice(0, nextLabel)
    const codeGlyphs = valueLines.flatMap((line, index) => nonBlank(line.slice(index === 0 ? 5 : 2)))
    expectCode(codeGlyphs, words.replaceAll(' ', ''))
    for (const [index, line] of valueLines.entries()) {
      if (index === 0) continue
      expect(textOf(line.slice(0, 2))).toBe('  ')
      expectPlain(line.slice(0, 2), '  ')
    }
    for (const index of [0, nextLabel]) {
      const line = lines[index]!
      const labelLength = index === 0 ? 4 : 5
      for (const glyph of line.slice(0, labelLength)) {
        expect(glyph.style).toEqual({ ...defaultStyle(), bold: true })
      }
      expectPlain(line.slice(labelLength, labelLength + 1), ' ')
    }
    expectPlain(lines[nextLabel]!.slice(6), 'plain')
  })
})
