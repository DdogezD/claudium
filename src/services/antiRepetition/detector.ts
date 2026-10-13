import { resolveAntiRepetitionConfig } from './config.js'
import type { AntiRepetitionConfig, RepetitionHit, RepetitionSseEvent } from './types.js'

const MAX_LINE_CHARS = 4096
const MAX_POOL_CHARS = 65536
const MAX_LINES = 256
const meaningful = /[\p{L}\p{N}]/u

class ChannelState {
  observed = 0
  line = ''
  overflow = false
  excluded = false
  fence = ''
  jsonDepth = 0
  xmlRoot = ''
  diffBlock = false
  lines: string[] = []
  counts = new Map<string, number>()
  poolChars = 0
  repeatedChars = 0
  position = 0
  lastMeaningful = -1
  ring: string[]
  runs: Uint32Array

  constructor(readonly periodLimit: number) {
    this.ring = new Array(periodLimit)
    this.runs = new Uint32Array(periodLimit + 1)
  }

  resetCycle(): void {
    this.position = 0
    this.lastMeaningful = -1
    this.runs.fill(0)
  }

  structuredPrefix(): boolean {
    const prefix = this.line.slice(0, 128)
    return this.fence !== '' || this.jsonDepth > 0 || this.xmlRoot !== '' || this.diffBlock ||
      /^(?:\s{4}|\t)/.test(prefix) ||
      /^\s*(?:[`~]{3}|[\[{<]|[|#>]|[-+*]\s|\d+[.)]\s|@@|diff\s|---|\+\+\+)/.test(prefix) ||
      /^\s*(?:\d{4}-\d{2}-\d{2}|\[?(?:TRACE|DEBUG|INFO|WARN|ERROR)\b|\d{2}:\d{2}:\d{2})/.test(prefix) ||
      /^\s*(?:const|let|var|function|class|import|export|return|def|if|for|while|public|private)\b.*[=({;:]|[{};]|=>|\|/.test(prefix) ||
      /^\s*["'][^"']+["']\s*:/.test(prefix)
  }

  finishLine(): void {
    const line = this.line
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (/^(?:diff --git|@@|--- |\+\+\+ )/.test(line)) this.diffBlock = true
    else if (!line.trim()) this.diffBlock = false
    if (fence) {
      if (!this.fence) this.fence = fence[1]!
      else if (fence[1]![0] === this.fence[0] && fence[1]!.length >= this.fence.length &&
        !line.slice(fence[0].length).trim()) this.fence = ''
    } else if (!this.fence && !this.overflow) {
      if (this.jsonDepth > 0 || /^\s*[\[{]/.test(line)) {
        const syntax = line.replace(/"(?:\\.|[^"\\])*"/g, '')
        for (const char of syntax) {
          if (char === '{' || char === '[') this.jsonDepth++
          if (char === '}' || char === ']') this.jsonDepth = Math.max(0, this.jsonDepth - 1)
        }
      }
      const root = /^\s*<([\w:-]+)(?:\s|>)/.exec(line)
      if (!this.xmlRoot && root && !/\/\s*>/.test(line)) this.xmlRoot = root[1]!
      if (this.xmlRoot && line.includes(`</${this.xmlRoot}>`)) this.xmlRoot = ''
    }
    if (!this.excluded && !this.overflow) {
      const normalized = line.trim().replace(/\s+/g, ' ')
      if (normalized.length >= 8 && meaningful.test(normalized)) this.addLine(normalized)
    }
    this.line = ''
    this.overflow = false
    this.excluded = false
  }

  addLine(line: string): void {
    const count = this.counts.get(line) ?? 0
    this.counts.set(line, count + 1)
    this.lines.push(line)
    this.poolChars += line.length
    if (count > 0) this.repeatedChars += line.length * (count === 1 ? 2 : 1)
    while (this.lines.length > MAX_LINES || this.poolChars > MAX_POOL_CHARS) {
      const old = this.lines.shift()!
      const oldCount = this.counts.get(old)!
      if (oldCount === 1) this.counts.delete(old)
      else {
        this.counts.set(old, oldCount - 1)
        this.repeatedChars -= old.length * (oldCount === 2 ? 2 : 1)
      }
      this.poolChars -= old.length
    }
  }
}

export class StreamRepetitionGuard {
  private readonly config: AntiRepetitionConfig
  private thinking: ChannelState
  private text: ChannelState
  private toolTouched = false
  private hit: RepetitionHit | undefined

  constructor(config: AntiRepetitionConfig) {
    this.config = resolveAntiRepetitionConfig(config)
    this.thinking = new ChannelState(this.config.maxCyclePeriod)
    this.text = new ChannelState(this.config.maxCyclePeriod)
  }

  resetForRequest(): void {
    this.thinking = new ChannelState(this.config.maxCyclePeriod)
    this.text = new ChannelState(this.config.maxCyclePeriod)
    this.toolTouched = false
    this.hit = undefined
  }

  observeSseEvent(event: RepetitionSseEvent): RepetitionHit | undefined {
    if (event.type === 'message_start') {
      this.resetForRequest()
      return undefined
    }
    if (event.content_block?.type === 'tool_use' ||
        event.content_block?.type === 'server_tool_use' ||
        event.delta?.type === 'input_json_delta') this.toolTouched = true
    if (!this.config.enabled || this.toolTouched) return undefined
    if (this.hit) return this.hit
    if (event.type !== 'content_block_delta') return undefined
    const delta = event.delta
    const channel = delta?.type === 'thinking_delta' ? 'thinking' :
      delta?.type === 'text_delta' ? 'text' : undefined
    if (!channel || !(channel === 'thinking' ? this.config.reasoning : this.config.text)) return undefined
    const value = channel === 'thinking' ? delta?.thinking : delta?.text
    if (typeof value !== 'string') return undefined
    const state = channel === 'thinking' ? this.thinking : this.text
    const minChars = channel === 'thinking' ? this.config.reasoningCycleMinChars : this.config.textCycleMinChars
    for (let i = 0; i < value.length; i++) {
      const char = value[i]!
      state.observed++
      if (char !== '\n') {
        if (state.line.length < MAX_LINE_CHARS) state.line += char
        else state.overflow = true
        if (!state.excluded && state.line.length <= 128 && state.structuredPrefix()) {
          state.excluded = true
          state.resetCycle()
        }
      }
      if (!state.excluded) {
        const previous = state.position > 0
          ? state.ring[(state.position - 1) % state.periodLimit] ?? '' : ''
        if (meaningful.test(char) ||
          (char >= '\uDC00' && char <= '\uDFFF' && meaningful.test(previous + char))) {
          state.lastMeaningful = state.position
        }
        for (let period = 1; period <= this.config.maxCyclePeriod; period++) {
          const match = state.position >= period &&
            state.ring[(state.position - period) % state.periodLimit] === char
          state.runs[period] = match ? Math.min(65536, state.runs[period]! + 1) : 0
          const span = state.runs[period]! + period
          if (span >= minChars && state.runs[period]! >= 2 * period &&
              state.lastMeaningful >= state.position - period + 1) {
            this.hit = this.makeHit(channel, state, 'trailing-cycle', span, { period })
            return this.hit
          }
        }
        state.ring[state.position % state.periodLimit] = char
        state.position++
      }
      if (char === '\n') {
        const excluded = state.excluded
        state.finishLine()
        if (excluded) state.resetCycle()
        const coverage = state.poolChars ? state.repeatedChars / state.poolChars : 0
        const concentration = state.counts.size ? state.lines.length / state.counts.size : 0
        if (state.lines.length >= 8 && state.repeatedChars >= this.config.lineRepeatedMinChars &&
            coverage >= this.config.lineCoverageMin && concentration >= this.config.lineConcentrationMin) {
          this.hit = this.makeHit(channel, state, 'phrase-pool', state.repeatedChars, {
            eligibleLines: state.lines.length, uniqueLines: state.counts.size, coverage, concentration,
            uniqueRatio: state.counts.size / state.lines.length,
          })
          return this.hit
        }
      }
    }
    return undefined
  }

  private makeHit(channel: RepetitionHit['channel'], state: ChannelState,
    rule: RepetitionHit['rule'], repeatedChars: number, stats: RepetitionHit['stats']): RepetitionHit {
    return { code: channel === 'thinking' ? 'REASONING_LOOP' : 'TEXT_LOOP',
      channel, rule, observedChars: state.observed, repeatedChars, stats }
  }
}
