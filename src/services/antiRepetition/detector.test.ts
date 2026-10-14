import { describe, expect, test } from 'bun:test'
import { resolveAntiRepetitionConfig } from './config.js'
import { StreamRepetitionGuard } from './detector.js'
import type { AntiRepetitionConfig, RepetitionHit, RepetitionSseEvent } from './types.js'

function delta(value: string): RepetitionSseEvent {
  return { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: value } }
}
function run(value: string, sizes: number[] = [value.length], input: Partial<AntiRepetitionConfig> = {}) {
  const guard = new StreamRepetitionGuard(resolveAntiRepetitionConfig({ enabled: true, ...input }))
  let hit: RepetitionHit | undefined
  for (let offset = 0, index = 0; offset < value.length;) {
    const size = sizes[index++ % sizes.length]!
    hit = guard.observeSseEvent(delta(value.slice(offset, offset + size)))
    offset += size
    if (hit) break
  }
  return { guard, hit }
}
function randomSizes() {
  let seed = 29
  return Array.from({ length: 100 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed % 173 + 1
  })
}
function negativeStats(guard: StreamRepetitionGuard) {
  const state = (guard as unknown as { thinking: {
    observed: number; lines: string[]; counts: Map<string, number>
    poolChars: number; repeatedChars: number; line: string
  } }).thinking
  return { observedChars: state.observed, eligibleLines: state.lines.length,
    uniqueLines: state.counts.size, repeatedChars: state.repeatedChars,
    coverage: state.poolChars ? state.repeatedChars / state.poolChars : 0,
    concentration: state.counts.size ? state.lines.length / state.counts.size : 0,
    retainedLineChars: state.line.length }
}

describe('StreamRepetitionGuard', () => {
  for (const phrase of ['需要重新确认当前条件，然后推进下一步。', 'We must reconsider this assumption before proceeding. ', 'hmm, ', '好。执行。', 'a']) {
    test(`detects a cycle independently of chunk boundaries (period ${phrase.length})`, () => {
      const value = phrase.repeat(1000)
      const reference = run(value).hit
      expect(reference?.rule).toBe('trailing-cycle')
      expect(reference?.observedChars).toBe(Math.max(512, phrase.length * 3))
      expect(reference?.stats?.period).toBe(phrase.length)
      for (const sizes of [[1], [17], randomSizes()]) expect(run(value, sizes).hit).toEqual(reference)
      console.info('antiRepetition cycle', reference)
    })
  }

  test('requires at least three repetitions and matches only at the threshold', () => {
    const phrase = 'This sentence reviews the next useful step. '
    const config = { cycleMinChars: phrase.length * 3 }
    expect(run(phrase.repeat(3).slice(0, -1), [1], config).hit).toBeUndefined()
    expect(run(phrase.repeat(3), [1], config).hit?.observedChars).toBe(phrase.length * 3)
    expect(run(phrase.repeat(2), [1], { cycleMinChars: 3 }).hit).toBeUndefined()
  })

  test('does not match periods above the maximum', () => {
    expect(run('abcdefghijklmnop'.repeat(100), [1], { maxCyclePeriod: 15 }).hit).toBeUndefined()
    expect(run('abcdefghijklmnop'.repeat(100), [1], { maxCyclePeriod: 16 }).hit?.stats?.period).toBe(16)
  })

  test('handles the maximum 512-character period across the ring buffer', () => {
    const phrase = Array.from({ length: 512 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')
    expect(run(phrase.repeat(3), [1]).hit).toMatchObject({ observedChars: 1536, stats: { period: 512 } })
  })

  test('detects reordered English and Chinese line pools without adjacent cycles', () => {
    for (const chinese of [false, true]) {
      const phrases = Array.from({ length: 13 }, (_, i) => chinese
        ? `当前检查点${i}需要结合先前已经验证的条件重新评估下一项决策，并且继续推进尚未完成的任务。`
        : `Checkpoint ${i} requires careful comparison of previous evidence before we decide how to proceed with the remaining task.`)
      let seed = 51
      const lines: string[] = []
      for (let round = 0; round < 9; round++) {
        const order = [...phrases]
        for (let i = order.length - 1; i > 0; i--) {
          seed = (seed * 1664525 + 1013904223) >>> 0
          const j = seed % (i + 1)
          ;[order[i], order[j]] = [order[j]!, order[i]!]
        }
        lines.push(...order)
      }
      const value = lines.join('\n') + '\n'
      const reference = run(value).hit
      expect(reference?.rule).toBe('phrase-pool')
      expect(reference?.stats?.eligibleLines).toBeGreaterThanOrEqual(8)
      expect(reference?.stats?.coverage).toBeGreaterThanOrEqual(0.6)
      expect(reference?.stats?.concentration).toBeGreaterThanOrEqual(4)
      expect(reference?.stats?.uniqueRatio).toBe(reference!.stats!.uniqueLines! / reference!.stats!.eligibleLines!)
      expect(reference?.repeatedChars).toBeGreaterThanOrEqual(2048)
      for (const sizes of [[1], [47], randomSizes()]) expect(run(value, sizes).hit).toEqual(reference)
      console.info('antiRepetition pool', reference)
    }
  })

  test('uses only complete lines and requires at least eight lines', () => {
    const phrase = 'The current evidence supports checking another hypothesis.'
    const config = { maxCyclePeriod: 1, lineRepeatedMinChars: 1, lineConcentrationMin: 1, lineCoverageMin: 0 }
    expect(run((phrase + '\n').repeat(7) + phrase, [1], config).hit).toBeUndefined()
    expect(run((phrase + '\n').repeat(8), [1], config).hit?.rule).toBe('phrase-pool')
  })

  test('uses one switch for reasoning and ignores text deltas', () => {
    expect(run('a'.repeat(600), [1], { enabled: false }).hit).toBeUndefined()
    expect(run('a'.repeat(600), [1]).hit).toMatchObject({
      code: 'REASONING_LOOP', observedChars: 512,
    })
    const guard = run('a'.repeat(300)).guard
    expect(guard.observeSseEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a'.repeat(1000) } })).toBeUndefined()
    expect(guard.observeSseEvent(delta('a'.repeat(212)))?.observedChars).toBe(512)
  })

  test('message_start and explicit reset clear request state', () => {
    const guard = run('a'.repeat(600)).guard
    guard.resetForRequest()
    expect(guard.observeSseEvent(delta('a'.repeat(511)))).toBeUndefined()
    guard.observeSseEvent({ type: 'message_start' })
    expect(guard.observeSseEvent(delta('a'.repeat(511)))).toBeUndefined()
    expect(guard.observeSseEvent(delta('a'))?.observedChars).toBe(512)
  })

  test('disables a request after tool signals and ignores other SSE output', () => {
    for (const event of [
      { type: 'content_block_start', content_block: { type: 'tool_use' } },
      { type: 'content_block_start', content_block: { type: 'server_tool_use' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
    ]) {
      const guard = run('a'.repeat(400)).guard
      guard.observeSseEvent(event)
      expect(guard.observeSseEvent(delta('a'.repeat(1000)))).toBeUndefined()
      guard.resetForRequest()
      expect(guard.observeSseEvent(delta('a'.repeat(512)))?.code).toBe('REASONING_LOOP')
    }
    const guard = run('a'.repeat(400)).guard
    guard.observeSseEvent({ type: 'content_block_delta', delta: { type: 'signature_delta', text: 'a'.repeat(1000) } })
    expect(guard.observeSseEvent(delta('a'.repeat(112)))?.observedChars).toBe(512)
  })

  const prose = 'This quoted passage explains the existing evidence and describes a useful next step.'
  const negatives: Record<string, string> = {
    punctuation: '.!?，。 '.repeat(3000),
    whitespace: ' \t\n'.repeat(3000),
    code: '```ts\n' + ('const value = 42;\n' + prose + '\n').repeat(100) + '```\n',
    tildeCode: '~~~\n' + prose.repeat(100) + '\n~~~\n',
    indentedCode: ('    ' + prose + '\n').repeat(100),
    json: '[\n' + ('{ "message": "' + prose + '" },\n').repeat(100) + ']\n',
    table: ('| row | ' + prose + ' |\n').repeat(100),
    twoColumnTable: ('row | ' + prose + '\n').repeat(100),
    nestedFence: '````md\n```ts\n' + (prose + '\n').repeat(100) + '```\n````\n',
    xml: '<root>\n' + (prose + '\n').repeat(100) + '</root>\n',
    log: ('2026-10-14T12:00:00 INFO ' + prose + '\n').repeat(100),
    diff: ('+ ' + prose + '\n- ' + prose + '\n').repeat(100),
    diffContext: 'diff --git a/file b/file\n@@ -1,100 +1,100 @@\n' + (' ' + prose + '\n').repeat(100),
    symbols: '\u{1F600}\u26A0\uFE0F'.repeat(3000),
    list: ('- ' + prose + '\n').repeat(100),
    numberedList: ('1. ' + prose + '\n').repeat(100),
    twoQuotes: ('```\n' + (prose + '\n').repeat(20) + '```\n').repeat(2),
    twoProsePasses: Array.from({ length: 13 }, (_, i) => `Finding ${i} explains a distinct condition in the input and proposes the next useful verification step.`).join('\n').repeat(2),
    longReasoning: Array.from({ length: 500 }, (_, i) => `Finding ${i} examines the unique case ${i * 37} and establishes new evidence for item ${i * 91}.`).join('\n'),
  }
  for (const [name, value] of Object.entries(negatives)) {
    test(`does not flag ${name}, including split structural prefixes`, () => {
      for (const sizes of [[1], randomSizes(), [value.length]]) {
        const result = run(value, sizes)
        expect(result.hit).toBeUndefined()
        const stats = negativeStats(result.guard)
        expect(stats.eligibleLines).toBeLessThanOrEqual(256)
        expect(stats.retainedLineChars).toBeLessThanOrEqual(4096)
        if (sizes.length === 1 && sizes[0] === value.length) console.info('antiRepetition negative', name, stats)
      }
    })
  }

  test('counts supplementary-plane letters as UTF-16 units regardless of chunking', () => {
    const value = '𐐀'.repeat(300)
    expect(run(value, [1]).hit).toEqual(run(value).hit)
    expect(run(value).hit).toMatchObject({ observedChars: 512, stats: { period: 2 } })
  })

  test('bounds line-pool character capacity and maintains duplicate counts on eviction', () => {
    const value = Array.from({ length: 100 }, (_, i) =>
      `Record ${i % 50} ` + Array.from({ length: 2000 }, (_, j) =>
        String.fromCharCode(0x4e00 + (j * 97 + i % 50) % 2000)).join('') + '\n').join('')
    const { guard, hit } = run(value, randomSizes(), { maxCyclePeriod: 1 })
    expect(hit).toBeUndefined()
    const state = (guard as unknown as { thinking: { poolChars: number } }).thinking
    expect(state.poolChars).toBeLessThanOrEqual(65536)
    expect(negativeStats(guard)).toMatchObject({ eligibleLines: 32, uniqueLines: 32, repeatedChars: 0 })
  })

  test('requires coverage and concentration to meet their thresholds independently', () => {
    const phrase = 'The available evidence suggests checking another distinct hypothesis.'
    const unique = 'A'.repeat(phrase.length)
    const value = (phrase + '\n').repeat(8) + unique + '\n'
    const base = { maxCyclePeriod: 1, cycleMinChars: 65536, lineRepeatedMinChars: 1, lineConcentrationMin: 8, lineCoverageMin: 1 }
    expect(run(value, [1], base).hit?.rule).toBe('phrase-pool')
    const mixed = unique + '\n' + (phrase + '\n').repeat(8)
    expect(run(mixed, [1], { ...base, lineConcentrationMin: 4.5, lineCoverageMin: 8 / 9 }).hit?.rule).toBe('phrase-pool')
    expect(run(mixed, [1], { ...base, lineConcentrationMin: 4.5, lineCoverageMin: 0.89 }).hit).toBeUndefined()
    expect(run(value, [1], { ...base, lineConcentrationMin: 8.1 }).hit).toBeUndefined()
    expect(run(value, [1], { ...base, lineRepeatedMinChars: phrase.length * 8 + 1 }).hit).toBeUndefined()
  })

  test('counts all occurrences of repeated lines and admits eight-character phrases', () => {
    const guard = run('Checking\nExecuting\nChecking\n', [1], { maxCyclePeriod: 1 }).guard
    expect(negativeStats(guard)).toMatchObject({ eligibleLines: 3, uniqueLines: 2, repeatedChars: 16, coverage: 16 / 25 })
  })

  test('bounds an oversized non-cyclic line and still detects a later normal line', () => {
    let seed = 31
    const value = Array.from({ length: 100000 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return String.fromCharCode(0x4e00 + seed % 2000)
    }).join('')
    const { guard, hit } = run(value, randomSizes())
    expect(hit).toBeUndefined()
    expect(negativeStats(guard)).toMatchObject({ eligibleLines: 0, retainedLineChars: 4096 })
    expect(guard.observeSseEvent(delta('\n' + 'a'.repeat(512)))?.observedChars).toBe(100513)
  })

  test('resumes normal reasoning detection after structures and isolates instances', () => {
    for (const prefix of ['```\nquoted\n```\n', '[\n"quoted"\n]\n', '<root>\nquoted\n</root>\n']) {
      const result = run(prefix + 'a'.repeat(512), [1])
      expect(result.hit?.observedChars).toBe(prefix.length + 512)
    }
    const first = run('a'.repeat(400)).guard
    const second = run('a'.repeat(400)).guard
    expect(first.observeSseEvent(delta('a'.repeat(112)))?.observedChars).toBe(512)
    expect(second.observeSseEvent(delta('b'.repeat(112)))).toBeUndefined()
  })
})
