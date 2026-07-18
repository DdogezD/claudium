import { buildTool, type Tool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  getAdvisorModel,
  isAdvisorEnabled,
} from '../../utils/advisor.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { formatNumber } from '../../utils/format.js'
import { errorMessage, isAbortError } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
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
import { buildAdvisorBlocks, summarizeAdvisorMessages } from './runtimeSummary.js'
import { validateAdvisorBashInput } from './toolPolicy.js'

// Read-only built-in tools the advisor subagent can use.
// Both the identity Set and name→canonical Map are built lazily on
// first use, so module initialization order can't leave undefined
// entries from unresolved circular imports.
let _readOnlyBuiltinTools: Set<Tool> | null = null
let _canonicalByName: Map<string, Tool> | null = null

function getReadOnlyBuiltinTools(): Set<Tool> {
  if (_readOnlyBuiltinTools) return _readOnlyBuiltinTools
  _readOnlyBuiltinTools = new Set([
    BashTool,
    FileReadTool,
    GrepTool,
    GlobTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
  ])
  _canonicalByName = new Map()
  for (const tool of _readOnlyBuiltinTools) {
    _canonicalByName.set(tool.name, tool)
  }
  return _readOnlyBuiltinTools
}

const ADVISOR_MAX_TURNS = 50

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
    const advice = output.advice || ''
    const isInterrupted = output.interrupted && output.terminationReason !== 'completed'

    let content = advice
    if (isInterrupted && output.terminationReason) {
      const banner = `[Advisor interrupted — reason: ${output.terminationReason.replace(/_/g, ' ')}]\n\n`
      content = banner + (advice || 'No partial advice was produced.')
    } else if (isInterrupted) {
      content = `[Advisor interrupted]\n\n${advice || 'No partial advice was produced.'}`
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
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
  // Identity check first (canonical singletons), then name-based fallback
  // for provider-wrapped instances.  canUseTool still enforces identity
  // against the returned canonical tools.
  const allowedAdvisorTools = new Set<Tool>()
  allowedAdvisorTools.add(conversationLog.tool)

  function resolveAllowedTool(tool: Tool): Tool | null {
    // Fast path: canonical singletons match by reference
    if (getReadOnlyBuiltinTools().has(tool)) return tool
    // Provider-wrapped instances lose identity; resolve by name
    return _canonicalByName!.get(tool.name) ?? null
  }

  function selectAdvisorTools(allTools: readonly Tool[]): Tool[] {
    const selected: Tool[] = []
    for (const tool of allTools) {
      if (tool.name === ADVISOR_TOOL_NAME) continue
      const canonical = resolveAllowedTool(tool)
      if (!canonical) continue
      selected.push(canonical)
    }
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
        const bashPolicy = validateAdvisorBashInput(input)
        if (!bashPolicy.allowed) {
          const malformed = bashPolicy.command === null
          return {
            behavior: 'deny' as const,
            updatedInput: bashPolicy.input,
            message: malformed
              ? 'The advisor received malformed Bash input.'
              : `The advisor can only run read-only Bash commands. ` +
                `"${bashPolicy.command.slice(0, 100)}" was denied.`,
            decisionReason: {
              type: 'other' as const,
              reason: malformed
                ? 'Advisor Bash input must satisfy the Bash tool schema.'
                : 'Advisor is restricted to read-only Bash commands.',
            },
          }
        }
        return { behavior: 'allow' as const, updatedInput: bashPolicy.input }
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
        logForDebugging(`Advisor iterator cleanup failed: ${errorMessage(err)}`)
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

  const summary = summarizeAdvisorMessages(messages)
  const {
    advice,
    sawApiError,
    toolsCalled,
    filesRead,
    webSearched,
    tokens,
  } = summary

  // sawApiError is calculated from the final post-tombstone message set.
  // Only throw on unexpected API errors: no known terminal reason, or
  // completed with an API error (shouldn't happen).  Known non-completed
  // reasons (blocking_limit, image_error, prompt_too_long, etc.) may
  // legitimately carry API error messages and must reach the structured
  // return path so the interruption banner is attached.
  if (sawApiError && (terminationReason === 'completed' || terminationReason === 'iterator_closed')) {
    throw new Error(
      `Advisor model returned an API error (messages received: ${messages.length}).`,
    )
  }
  const interrupted = terminationReason !== 'completed'

  const blocks = buildAdvisorBlocks(messages, (name, input) => {
    const formattedInput = formatToolInput(name, input)
    return formattedInput ? `${toolLabel(name)} ${formattedInput}` : toolLabel(name)
  })

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
      // All other interrupted/non-completed reasons: return a structured
      // result so mapToolResultToToolResultBlockParam can attach the
      // interruption banner.  model_error and unexpected sawApiError throw
      // before reaching here.
      if (terminationReason === 'completed') {
        throw new Error(
          `Advisor returned no response ` +
          `(termination reason: completed, ` +
          `messages: ${messages.length}, ` +
          `tool uses: ${toolNames || 'none'}).`,
        )
      }
      const reasonLabel = (terminalResult?.reason ?? 'unknown').replace(/_/g, ' ')
      return {
        advice:
          `Advisor was interrupted (reason: ${reasonLabel}). ` +
          `It made ${toolsCalled} tool ${toolsCalled === 1 ? 'call' : 'calls'} ` +
          `(${toolNames || 'none'}), read ${filesRead} ${filesRead === 1 ? 'file' : 'files'}, ` +
          `and consumed ${formatNumber(tokens)} tokens.`,
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
      advice: partial,
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
