import { extractTextContent } from '../../utils/messages.js'

export type AdvisorSummaryBlock = {
  type: string
  text?: string
  name?: string
  input?: unknown
  id?: string
  tool_use_id?: string
  is_error?: boolean
}

type AdvisorUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type AdvisorEnvelope = {
  type: 'assistant' | 'user'
  message: {
    id?: string
    content?: AdvisorSummaryBlock[]
    usage?: AdvisorUsage
  }
  isApiErrorMessage?: boolean
}

export type AdvisorRuntimeSummary = {
  advice: string
  sawApiError: boolean
  toolsCalled: number
  filesRead: number
  webSearched: boolean
  tokens: number
}

export type AdvisorResultBlock = { type: 'tool' | 'text'; text: string }

const BLOCKS_TOTAL_CHARS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asSummaryBlock(value: unknown): AdvisorSummaryBlock | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  return {
    type: value.type,
    text: typeof value.text === 'string' ? value.text : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    input: value.input,
    id: typeof value.id === 'string' ? value.id : undefined,
    tool_use_id: typeof value.tool_use_id === 'string' ? value.tool_use_id : undefined,
    is_error: typeof value.is_error === 'boolean' ? value.is_error : undefined,
  }
}

function asEnvelope(value: unknown): AdvisorEnvelope | null {
  if (!isRecord(value) || (value.type !== 'assistant' && value.type !== 'user')) return null
  if (!isRecord(value.message)) return null

  const content = Array.isArray(value.message.content)
    ? value.message.content
      .map(asSummaryBlock)
      .filter((block): block is AdvisorSummaryBlock => block !== null)
    : undefined
  const usage = isRecord(value.message.usage)
    ? value.message.usage as AdvisorUsage
    : undefined

  return {
    type: value.type,
    message: {
      id: typeof value.message.id === 'string' ? value.message.id : undefined,
      content,
      usage,
    },
    isApiErrorMessage: value.isApiErrorMessage === true,
  }
}

function usageTotal(usage: AdvisorUsage): number {
  return (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
}

function aggregateTokenUsage(messages: readonly AdvisorEnvelope[]): number {
  const assistantMessages = messages.filter(message => message.type === 'assistant')
  const usageByResponse = new Map<string, AdvisorUsage>()
  const seenResponseIds = new Set<string>()

  for (const message of assistantMessages) {
    const responseId = message.message.id
    const usage = message.message.usage
    if (!responseId || !usage) continue
    const previous = usageByResponse.get(responseId)
    usageByResponse.set(responseId, {
      input_tokens: Math.max(previous?.input_tokens ?? 0, usage.input_tokens ?? 0),
      output_tokens: Math.max(previous?.output_tokens ?? 0, usage.output_tokens ?? 0),
      cache_creation_input_tokens: Math.max(
        previous?.cache_creation_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      ),
      cache_read_input_tokens: Math.max(
        previous?.cache_read_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
      ),
    })
    seenResponseIds.add(responseId)
  }

  let tokens = 0
  for (const usage of usageByResponse.values()) tokens += usageTotal(usage)

  const noIdGroups: AdvisorEnvelope[][] = []
  let currentGroup: AdvisorEnvelope[] = []
  for (const message of messages) {
    if (message.type === 'assistant' && !seenResponseIds.has(message.message.id ?? '')) {
      currentGroup.push(message)
    } else if (currentGroup.length > 0) {
      noIdGroups.push(currentGroup)
      currentGroup = []
    }
  }
  if (currentGroup.length > 0) noIdGroups.push(currentGroup)

  for (const group of noIdGroups) {
    const maxUsage: AdvisorUsage = {}
    for (const message of group) {
      const usage = message.message.usage
      if (!usage) continue
      maxUsage.input_tokens = Math.max(maxUsage.input_tokens ?? 0, usage.input_tokens ?? 0)
      maxUsage.output_tokens = Math.max(maxUsage.output_tokens ?? 0, usage.output_tokens ?? 0)
      maxUsage.cache_creation_input_tokens = Math.max(
        maxUsage.cache_creation_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      )
      maxUsage.cache_read_input_tokens = Math.max(
        maxUsage.cache_read_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
      )
    }
    tokens += usageTotal(maxUsage)
  }

  return tokens
}

function extractFinalAdvice(messages: readonly AdvisorEnvelope[]): string {
  const groups = new Map<string | undefined, AdvisorEnvelope[]>()
  let lastResponseId: string | undefined

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const responseId = message.message.id
    if (responseId) {
      lastResponseId = responseId
      const group = groups.get(responseId)
      if (group) group.push(message)
      else groups.set(responseId, [message])
      continue
    }

    const lastGroup = lastResponseId ? groups.get(lastResponseId) : undefined
    if (lastGroup) {
      lastGroup.push(message)
    } else {
      const unkeyedGroup = groups.get(undefined)
      if (unkeyedGroup) unkeyedGroup.push(message)
      else groups.set(undefined, [message])
    }
  }

  const finalMessages = groups.get(lastResponseId) ??
    (groups.size > 0 ? [...groups.values()].at(-1) : undefined) ??
    []
  const finalBlocks = finalMessages.flatMap(message => message.message.content ?? [])
  return extractTextContent(finalBlocks, '\n\n').trim()
}

/**
 * Convert the final, already tombstone-pruned assistant stream into the
 * bounded transcript blocks shown by the Advisor result renderer.
 */
export function buildAdvisorBlocks(
  messages: readonly unknown[],
  formatToolUse: (name: string, input: unknown) => string,
): AdvisorResultBlock[] {
  const blocks: AdvisorResultBlock[] = []
  let blocksChars = 0

  outer: for (const rawMessage of messages) {
    const message = asEnvelope(rawMessage)
    if (!message || message.type !== 'assistant') continue
    for (const block of message.message.content ?? []) {
      if (block.type === 'tool_use') {
        const text = formatToolUse(block.name ?? 'unknown', block.input)
        if (blocksChars + text.length > BLOCKS_TOTAL_CHARS) {
          blocks.push({ type: 'tool', text: '[...blocks truncated]' })
          break outer
        }
        blocksChars += text.length
        blocks.push({ type: 'tool', text })
      } else if (block.type === 'text' && block.text) {
        const remaining = BLOCKS_TOTAL_CHARS - blocksChars
        if (remaining <= 0) {
          blocks.push({ type: 'tool', text: '[...blocks truncated]' })
          break outer
        }
        if (block.text.length > remaining) {
          blocks.push({ type: 'text', text: block.text.slice(0, remaining) })
          blocks.push({ type: 'tool', text: '[...blocks truncated]' })
          break outer
        }
        blocksChars += block.text.length
        blocks.push({ type: 'text', text: block.text })
      }
    }
  }

  return blocks
}

/**
 * Summarize the final, already tombstone-pruned advisor message set.
 * Stream consumption, tombstone mutation, terminal mapping, and fallback copy
 * remain in AdvisorTool.tsx; this function has no runtime side effects.
 */
export function summarizeAdvisorMessages(messages: readonly unknown[]): AdvisorRuntimeSummary {
  const envelopes = messages.map(asEnvelope).filter((message): message is AdvisorEnvelope => message !== null)
  const assistantMessages = envelopes.filter(message => message.type === 'assistant')
  const toolUses = assistantMessages
    .flatMap(message => message.message.content ?? [])
    .filter(block => block.type === 'tool_use')

  const successfulToolUseIds = new Set(
    envelopes
      .filter(message => message.type === 'user')
      .flatMap(message => message.message.content ?? [])
      .filter(block => block.type === 'tool_result' && !block.is_error)
      .map(block => block.tool_use_id)
      .filter((id): id is string => typeof id === 'string'),
  )

  const filesRead = new Set(
    toolUses
      .filter(block => block.name === 'Read' && successfulToolUseIds.has(block.id ?? ''))
      .map(block => isRecord(block.input) ? block.input.file_path : undefined)
      .filter((path): path is string => typeof path === 'string'),
  ).size

  return {
    advice: extractFinalAdvice(envelopes),
    sawApiError: assistantMessages.some(message => message.isApiErrorMessage),
    toolsCalled: toolUses.length,
    filesRead,
    webSearched: toolUses.some(block => block.name === 'WebSearch' && successfulToolUseIds.has(block.id ?? '')),
    tokens: aggregateTokenUsage(envelopes),
  }
}
