import type { AntiLoopConfig } from './types.js'
import type { RepeatToolCall, RepeatToolReminder } from './types.js'

function sortJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
      throw new TypeError('Tool arguments are not JSON-serializable')
    }
    return value
  }
  if (seen.has(value)) throw new TypeError('Circular tool arguments')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => sortJsonValue(item, seen))
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key], seen)
    }
    return sorted
  } finally {
    seen.delete(value)
  }
}

export function canonicalizeToolArguments(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(sortJsonValue(value, new Set()))
    return json === undefined ? undefined : json
  } catch {
    return undefined
  }
}

export function createAntiLoopToolKey(toolName: string, input: unknown): string | undefined {
  const canonicalArguments = canonicalizeToolArguments(input)
  return canonicalArguments === undefined ? undefined : `${toolName}\u0000${canonicalArguments}`
}

export class RepeatToolReminderTracker {
  private previousKey: string | undefined
  private previousCall: RepeatToolCall | undefined
  private count = 0

  constructor(private readonly config: AntiLoopConfig) {}

  observe(call: RepeatToolCall): RepeatToolReminder | undefined {
    const key = createAntiLoopToolKey(call.toolName, call.input)
    if (key === undefined) {
      this.previousKey = undefined
      this.previousCall = undefined
      this.count = 0
      return undefined
    }

    if (key === this.previousKey) this.count++
    else {
      this.previousKey = key
      this.previousCall = call
      this.count = 1
    }

    const thresholdIndex = this.config.thresholds.indexOf(this.count)
    if (thresholdIndex === -1) return undefined

    const argumentsPreview = key.slice(key.indexOf('\u0000') + 1, key.indexOf('\u0000') + 1 + this.config.argumentsPreviewChars)
    return {
      toolName: call.toolName,
      count: this.count,
      argumentsPreview,
      thresholdIndex,
    }
  }

  reset(): void {
    this.previousKey = undefined
    this.previousCall = undefined
    this.count = 0
  }
}
