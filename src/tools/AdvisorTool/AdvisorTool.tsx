import { buildTool, type Tool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  getAdvisorModel,
  isAdvisorEnabled,
} from '../../utils/advisor.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  extractTextContent,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { formatNumber } from '../../utils/format.js'
import { isAbortError } from '../../utils/errors.js'
import { checkReadOnlyConstraints } from '../BashTool/readOnlyValidation.js'
import { commandHasAnyCd } from '../BashTool/bashPermissions.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { WebSearchTool } from '../WebSearchTool/WebSearchTool.js'
import { WebFetchTool } from '../WebFetchTool/WebFetchTool.js'
import { ListMcpResourcesTool } from '../ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '../ReadMcpResourceTool/ReadMcpResourceTool.js'

import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_NAME,
  ADVISOR_TOOL_DESCRIPTION,
} from './prompt.js'
import { inputSchema, outputSchema, type InputSchema, type Output } from './schemas.js'
import {
  toolLabel,
  formatToolInput,
  buildAdvisorLiveBox,
  renderAdvisorToolUseMessage,
  renderAdvisorToolErrorMessage,
  renderAdvisorToolResultMessage,
  type AdvisorProgress,
} from './ui.js'
import type { AdvisorRunResult } from './types.js'
import { getConversationSnapshot } from './conversationLog/snapshot.js'
import { createConversationLogTool } from './conversationLog/ConversationLogTool.js'

// Read-only built-in tools the advisor subagent can use.
// Only canonical identity (Set.has via reference equality) is trusted —
// no name-based fallback. Provider-wrapped tools with different references
// are NOT allowed unless registered through a private provenance registry.
const READ_ONLY_BUILTIN_TOOLS = new Set<Tool>([
  BashTool,
  FileReadTool,
  GrepTool,
  GlobTool,
  WebSearchTool,
  WebFetchTool,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
])

const ADVISOR_MAX_TURNS = 200

// ---------------------------------------------------------------------------
// Context history helper
// ---------------------------------------------------------------------------

function selectAdvisorHistory(
  messages: readonly Message[],
): { messages: readonly Message[]; actualCount: number } {
  if (messages.length === 0) {
    return { messages: [], actualCount: 0 }
  }
  const afterBoundary = getMessagesAfterCompactBoundary(messages)
  const filtered = afterBoundary.filter(
    m => m.type === 'user' || m.type === 'assistant',
  )
  return { messages: filtered, actualCount: filtered.length }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const AdvisorTool = buildTool({
  name: ADVISOR_TOOL_NAME,

  get inputSchema(): InputSchema {
    return inputSchema
  },

  get outputSchema() {
    return outputSchema
  },

  isEnabled() {
    return isAdvisorEnabled()
  },

  isConcurrencySafe() {
    return false
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.question
  },

  async description() {
    const model = getAdvisorModel() || 'advisor'
    return `Consult a stronger advisor model (${model}) for strategic guidance. Use when facing architectural choices, debugging dead-ends, high-stakes changes, or security reviews.`
  },

  async prompt() {
    return ADVISOR_TOOL_DESCRIPTION
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.advice,
    }
  },

  renderToolUseErrorMessage(content, options) {
    return renderAdvisorToolErrorMessage(content, options)
  },

  renderToolUseMessage(
    input: Partial<InputSchema>,
    options?: { verbose?: boolean },
  ) {
    return renderAdvisorToolUseMessage(input, options)
  },

  renderToolResultMessage(
    content: Output,
    _progressMessages?: unknown,
    options?: { verbose?: boolean; input?: Record<string, unknown>; isTranscriptMode?: boolean },
  ) {
    return renderAdvisorToolResultMessage(content, options)
  },

  async call({ question }, context) {
    const model = getAdvisorModel()
    if (!model) {
      throw new Error('Advisor is not configured. Set CLAUDE_CODE_ADVISOR_MODEL.')
    }

    const history = selectAdvisorHistory(context.messages)

    try {
      const result = await runAdvisorQuery(question, history, model, context)
      return {
        data: {
          ...result,
          contextMessagesAvailable: history.actualCount,
        },
      }
    } finally {
      if (context.setToolJSX) context.setToolJSX(null)
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// ---------------------------------------------------------------------------
// Advisor as lightweight subagent — multi-turn, tool-enabled query
// ---------------------------------------------------------------------------

async function runAdvisorQuery(
  question: string,
  history: { messages: readonly Message[]; actualCount: number },
  advisorModel: string,
  context: ToolUseContext,
): Promise<AdvisorRunResult> {
  const { query } = await import('../../query.js')
  const { getUserContext, getSystemContext } = await import('../../context.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')

  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])

  const { getCwd } = await import('../../utils/cwd.js')
  const cwd = getCwd()

  const systemPrompt = asSystemPrompt([
    `# Environment\nYou are running in the following environment:\nWorking directory: ${cwd}`,
    ADVISOR_SYSTEM_PROMPT,
  ])

  // Build conversation log snapshot + lazy-read tool
  const { entries: conversationEntries, index: conversationIndex } = getConversationSnapshot(history.messages)
  const conversationLog = createConversationLogTool(conversationEntries, conversationIndex)

  // Build identity-based allowlist from the current tool set.
  // Only canonical singletons (Set.has reference equality) are trusted.
  const allowedAdvisorTools = new Set<Tool>()
  allowedAdvisorTools.add(conversationLog.tool)

  function selectAdvisorTools(allTools: readonly Tool[]): Tool[] {
    const selected = allTools.filter(
      tool =>
        tool.name !== ADVISOR_TOOL_NAME &&
        READ_ONLY_BUILTIN_TOOLS.has(tool),
    )
    allowedAdvisorTools.clear()
    for (const tool of selected) allowedAdvisorTools.add(tool)
    allowedAdvisorTools.add(conversationLog.tool)
    return [...selected, conversationLog.tool]
  }

  const advisorTools = selectAdvisorTools(context.options.tools)

  const subagentCtx = createSubagentContext(context, {
    options: {
      ...context.options,
      mainLoopModel: advisorModel,
      tools: advisorTools,
      refreshTools: context.options.refreshTools
        ? () => selectAdvisorTools(context.options.refreshTools!())
        : undefined,
    },
    requireCanUseTool: true,
  })

  // Only send the question — history is available via ReadConversationLog
  const queryMessages = [createUserMessage({ content: question })]

  const messages: any[] = []
  const info: AdvisorProgress = {
    model: advisorModel,
    toolUseCount: 0,
    lastTool: '',
    lastInput: {} as Record<string, unknown>,
    startTime: Date.now(),
  }

  // Push live box once per second to keep the elapsed timer ticking
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const iterator = query({
    messages: queryMessages,
    systemPrompt,
    userContext,
    systemContext,
    maxTurns: ADVISOR_MAX_TURNS,
    canUseTool: async (tool, input) => {
      // Allowed only if the tool object is in the identity-based set
      // (canonical built-in singletons or the conversationTool instance).
      if (!allowedAdvisorTools.has(tool as Tool)) {
        return {
          behavior: 'deny' as const,
          updatedInput: input,
          message: `The advisor cannot use ${(tool as any).name ?? 'unknown tool'}.`,
          decisionReason: {
            type: 'other' as const,
            reason: 'Advisor tools are restricted to a read-only allowlist.',
          },
        }
      }
      // Enforce read-only for Bash — prompt-level instructions are not a
      // security boundary. Uses the same read-only classifier as BashTool.
      if ((tool as Tool).name === 'Bash') {
        const cmd =
          typeof input === 'object' && input !== null && 'command' in input
            ? (input as any).command
            : ''
        const roCheck = checkReadOnlyConstraints(
          input as any,
          commandHasAnyCd(typeof cmd === 'string' ? cmd : ''),
        )
        if (roCheck.behavior !== 'allow') {
          return {
            behavior: 'deny' as const,
            updatedInput: input,
            message: `The advisor can only run read-only Bash commands. ` +
              `"${typeof cmd === 'string' ? cmd.slice(0, 100) : 'this command'}" was denied.`,
            decisionReason: {
              type: 'other' as const,
              reason: 'Advisor is restricted to read-only Bash commands.',
            },
          }
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },
    toolUseContext: subagentCtx,
    querySource: 'advisor' as any,
    skipCacheWrite: true,
  })

  let terminalResult: { reason: string } | undefined

  // Start tick timer after iterator creation
  tickTimer = context.setToolJSX
    ? setInterval(() => { context.setToolJSX!(buildAdvisorLiveBox(info)) }, 1000)
    : null

  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        terminalResult = next.value as { reason: string } | undefined
        break
      }
      const msg = next.value
      if (msg.type === 'tombstone') {
        const idx = messages.indexOf(msg.message)
        if (idx !== -1) messages.splice(idx, 1)
        continue
      }
      if (msg.type === 'assistant' || msg.type === 'user') {
        messages.push(msg)
      }
      // Push live UI update
      if (msg.type === 'assistant') {
        const blocks_ = (msg.message as any)?.content as any[]
        if (blocks_) {
          let updated = false
          for (const b of blocks_) {
            if (b.type === 'tool_use') {
              info.toolUseCount++
              info.lastTool = b.name
              info.lastInput = (b.input as Record<string, unknown>) ?? {}
              updated = true
            }
          }
          if (updated && context.setToolJSX) {
            context.setToolJSX(buildAdvisorLiveBox(info))
          }
        }
      }
    }
  } catch (err) {
    if (isAbortError(err) || context.abortController.signal.aborted) {
      terminalResult = { reason: 'aborted_streaming' }
    } else {
      throw err
    }
  } finally {
    if (tickTimer) clearInterval(tickTimer)
    // Ensure iterator is closed with a bounded cleanup timeout.
    if (iterator.return) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          iterator.return(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('cleanup timeout')), 5000)
          }),
        ])
      } catch (err) {
        // Cleanup failure must not mask the primary error; log for diagnostics.
        if (typeof (console as any)?.debug === 'function') (console as any).debug('Advisor iterator cleanup:', err)
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
    }
  }

  if (terminalResult?.reason === 'model_error') {
    throw new Error(
      `Advisor model returned an error (reason: ${terminalResult?.reason}, ` +
      `messages received: ${messages.length}).`,
    )
  }
  // Recompute API error status from the final post-tombstone messages.
  // Tombstones may have removed the errored message.
  const sawApiError = messages.some(
    (m: any) => m.type === 'assistant' && m.isApiErrorMessage,
  )
  if (sawApiError) {
    throw new Error(
      `Advisor model returned an API error (messages received: ${messages.length}).`,
    )
  }

  // Map terminal reason; model_error is re-thrown before reaching here.
  const terminationReason: Output['terminationReason'] =
    terminalResult === undefined ? 'iterator_closed'
      : terminalResult.reason === 'completed' ? 'completed'
      : terminalResult.reason === 'max_turns' ? 'max_turns'
      : terminalResult.reason === 'aborted_streaming' ? 'aborted_streaming'
      : terminalResult.reason === 'aborted_tools' ? 'aborted_tools'
      : terminalResult.reason === 'prompt_too_long' ? 'prompt_too_long'
      : terminalResult.reason === 'hook_stopped' ? 'hook_stopped'
      : terminalResult.reason === 'blocking_limit' ? 'blocking_limit'
      : terminalResult.reason === 'image_error' ? 'image_error'
      : terminalResult.reason === 'stop_hook_prevented' ? 'stop_hook_prevented'
      : 'iterator_closed'
  const interrupted = terminationReason !== 'completed'

  // Build blocks from final (post-tombstone) messages
  const BLOCKS_TOTAL_CHARS = 20_000
  const blocks: Array<{ type: 'tool' | 'text'; text: string }> = []
  let blocksChars = 0
  outer: for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = (m.message as any)?.content as any[]
    if (!content) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        const s = formatToolInput(b.name, b.input)
        const text = s ? `${toolLabel(b.name)} ${s}` : toolLabel(b.name)
        if (blocksChars + text.length > BLOCKS_TOTAL_CHARS) {
          blocks.push({ type: 'tool', text: '[...blocks truncated]' })
          break outer
        }
        blocksChars += text.length
        blocks.push({ type: 'tool', text })
      } else if (b.type === 'text' && b.text) {
        const remaining = BLOCKS_TOTAL_CHARS - blocksChars
        if (remaining <= 0) { blocks.push({ type: 'tool', text: '[...blocks truncated]' }); break outer }
        if (b.text.length > remaining) {
          blocks.push({ type: 'text', text: b.text.slice(0, remaining) })
          blocks.push({ type: 'tool', text: '[...blocks truncated]' })
          break outer
        }
        blocksChars += b.text.length
        blocks.push({ type: 'text', text: b.text })
      }
    }
  }

  const assistantMessages = messages.filter(
    (m: any) => m.type === 'assistant',
  )
  const assistantBlocks = assistantMessages.flatMap(
    (m: any) => m.message.content,
  )
  const toolUses = assistantBlocks.filter((b: any) => b.type === 'tool_use')
  const toolsCalled = toolUses.length

  // filesRead: unique Read file paths with a successful (non-error) tool_result
  const successfulToolUseIds = new Set(
    messages
      .filter((m: any) => m.type === 'user')
      .flatMap((m: any) => m.message?.content ?? [])
      .filter((b: any) => b.type === 'tool_result' && !b.is_error)
      .map((b: any) => b.tool_use_id)
      .filter(Boolean),
  )
  const filesRead = new Set(
    toolUses
      .filter((t: any) => t.name === 'Read' && successfulToolUseIds.has(t.id))
      .map((t: any) => t.input?.file_path)
      .filter((p: unknown): p is string => typeof p === 'string'),
  ).size
  const webSearched = toolUses.some(
    (t: any) => t.name === 'WebSearch' && successfulToolUseIds.has(t.id),
  )

  // Aggregate token usage deduplicated by API response ID.
  // Response-ID-based grouping handles providers that interleave
  // assistant blocks with tool_result messages under the same ID.
  const seenResponseIds = new Set<string | undefined>()
  let tokens = 0

  // First pass: collect all groups with known response IDs
  const usageByResponse = new Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number }>()
  for (const m of assistantMessages) {
    const usage = (m as any).message?.usage
    if (!usage) continue
    const responseId = (m as any).message?.id as string | undefined
    if (responseId) {
      const prev = usageByResponse.get(responseId)
      usageByResponse.set(responseId, {
        input: Math.max(prev?.input ?? 0, usage.input_tokens ?? 0),
        output: Math.max(prev?.output ?? 0, usage.output_tokens ?? 0),
        cacheCreation: Math.max(prev?.cacheCreation ?? 0, usage.cache_creation_input_tokens ?? 0),
        cacheRead: Math.max(prev?.cacheRead ?? 0, usage.cache_read_input_tokens ?? 0),
      })
      seenResponseIds.add(responseId)
    }
  }

  // Deduplicated known responses
  for (const u of usageByResponse.values()) {
    tokens += u.input + u.output + u.cacheCreation + u.cacheRead
  }

  // For messages without a response ID, aggregate by contiguous assistant
  // groups (split on non-assistant boundaries) as a best-effort fallback.
  const noIdGroups: any[][] = []
  let currentGroup: any[] = []
  for (const m of messages) {
    if (m.type === 'assistant') {
      if (!seenResponseIds.has((m as any).message?.id)) {
        currentGroup.push(m)
      } else if (currentGroup.length > 0) {
        noIdGroups.push(currentGroup)
        currentGroup = []
      }
    } else if (currentGroup.length > 0) {
      noIdGroups.push(currentGroup)
      currentGroup = []
    }
  }
  if (currentGroup.length > 0) noIdGroups.push(currentGroup)

  for (const group of noIdGroups) {
    const maxUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
    for (const m of group) {
      const usage = (m as any).message?.usage
      if (!usage) continue
      maxUsage.input = Math.max(maxUsage.input, usage.input_tokens ?? 0)
      maxUsage.output = Math.max(maxUsage.output, usage.output_tokens ?? 0)
      maxUsage.cacheCreation = Math.max(maxUsage.cacheCreation, usage.cache_creation_input_tokens ?? 0)
      maxUsage.cacheRead = Math.max(maxUsage.cacheRead, usage.cache_read_input_tokens ?? 0)
    }
    tokens += maxUsage.input + maxUsage.output + maxUsage.cacheCreation + maxUsage.cacheRead
  }

  // Extract advice from the final logical API response.
  // Group by response ID: the final response is the one with the last
  // response ID seen.  If there's a mix of keyed and unkeyed messages,
  // prefer the last keyed group; otherwise fall back to the last
  // contiguous unkeyed assistant run.
  const groupedByResponse = new Map<string | undefined, any[]>()
  let lastResponseId: string | undefined
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const id = (m as any).message?.id as string | undefined
    if (id) {
      lastResponseId = id
      const group = groupedByResponse.get(id)
      if (group) group.push(m)
      else groupedByResponse.set(id, [m])
    } else {
      const last = lastResponseId ? groupedByResponse.get(lastResponseId) : undefined
      if (last) last.push(m)
      else {
        const noId = groupedByResponse.get(undefined)
        if (noId) noId.push(m)
        else groupedByResponse.set(undefined, [m])
      }
    }
  }

  const finalGroupKey = lastResponseId ?? undefined
  const finalMessages = groupedByResponse.get(finalGroupKey) ??
    (groupedByResponse.size > 0 ? [...groupedByResponse.values()].at(-1) : undefined) ??
    []
  const finalBlocks = finalMessages.flatMap(
    (m: any) => m.message?.content ?? [],
  )
  const advice = extractTextContent(finalBlocks, '\n\n').trim()
  const durationMs = Date.now() - info.startTime
  const conversationsRead = conversationLog.getUniqueReadCount()

  if (!advice) {
    const partial = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n').trim()
    if (!partial) {
      const toolBlocks = blocks.filter(b => b.type === 'tool')
      const toolNames = toolBlocks.map(b => b.text).join(', ')
      if (terminalResult?.reason === 'max_turns') {
        return {
          advice:
            `Advisor ran out of turns (${ADVISOR_MAX_TURNS} max) while researching this question. ` +
            `It made ${toolsCalled} tool ${toolsCalled === 1 ? 'call' : 'calls'} ` +
            `(${toolNames || 'none'}), read ${filesRead} ${filesRead === 1 ? 'file' : 'files'}, ` +
            `and consumed ${formatNumber(tokens)} tokens. ` +
            `\n\nTry re-asking with a narrower question.`,
          filesRead,
          toolsCalled,
          tokens,
          durationMs,
          webSearched,
          blocks,
          interrupted: true,
          terminationReason,
          model: advisorModel,
          conversationsRead,
        }
      }
      if (terminalResult?.reason === 'aborted_tools') {
        return {
          advice:
            `Advisor was interrupted while running tools. ` +
            `It made ${toolsCalled} tool ${toolsCalled === 1 ? 'call' : 'calls'} ` +
            `(${toolNames || 'none'}) and read ${filesRead} ${filesRead === 1 ? 'file' : 'files'} ` +
            `before being stopped. ` +
            `\n\nTry re-asking or narrow the scope.`,
          filesRead,
          toolsCalled,
          tokens,
          durationMs,
          webSearched,
          blocks,
          interrupted: true,
          terminationReason,
          model: advisorModel,
          conversationsRead,
        }
      }
      throw new Error(
        `Advisor returned no response ` +
        `(terminal reason: ${terminalResult?.reason ?? 'none'}, ` +
        `messages: ${messages.length}, ` +
        `tool uses: ${toolNames || 'none'}, ` +
        `sawApiError: ${sawApiError}).`,
      )
    }
    return {
      advice: partial,
      filesRead,
      toolsCalled,
      tokens,
      durationMs,
      webSearched,
      blocks,
      interrupted: true,
      terminationReason,
      model: advisorModel,
      conversationsRead,
    }
  }

  return {
    advice,
    filesRead,
    toolsCalled,
    tokens,
    durationMs,
    webSearched,
    blocks,
    interrupted,
    terminationReason,
    model: advisorModel,
    conversationsRead,
  }
}
