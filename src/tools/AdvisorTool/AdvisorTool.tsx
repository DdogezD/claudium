import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
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
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { isAbortError } from '../../utils/errors.js'
import { checkReadOnlyConstraints } from '../BashTool/readOnlyValidation.js'
import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_NAME,
  ADVISOR_TOOL_DESCRIPTION,
  CONVERSATION_LOG_TOOL_NAME,
} from './prompt.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { WebSearchTool } from '../WebSearchTool/WebSearchTool.js'
import { WebFetchTool } from '../WebFetchTool/WebFetchTool.js'
import { ListMcpResourcesTool } from '../ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from '../ReadMcpResourceTool/ReadMcpResourceTool.js'

// Read-only built-in tools the advisor subagent can use.
// Canonical identity check first (Set.has via reference equality) — catches MCP
// tools and plugins even if they share the name. Falls back to name matching
// with structural guards for provider-wrapped tools (e.g. OpenAI compat layer
// rewraps tools into `functions.Read` objects with different references).
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

const READ_ONLY_BUILTIN_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'ListMcpResources',
  'ReadMcpResource',
])

/** Returns true when a tool is a built-in (non-MCP) read-only tool the advisor may use. */
function isAdvisorAllowedBuiltin(tool: Tool): boolean {
  // Canonical identity: exact singleton reference (catches MCP spoofing).
  if (READ_ONLY_BUILTIN_TOOLS.has(tool)) return true
  // Provider-wrapped tools (e.g. OpenAI compat): check name + structural guards.
  if ((tool as any).mcpInfo !== undefined) return false
  if ((tool as any).isMcp === true) return false
  return READ_ONLY_BUILTIN_TOOL_NAMES.has(tool.name)
}

const CONVERSATION_LOG_READ_LIMIT = 20
const CONVERSATION_LOG_TOTAL_CHARS = 80_000
const ADVISOR_MAX_TURNS = 200

const inputSchema = z.strictObject({
  question: z
    .string()
    .describe(
      'What do you need advice on? Describe the problem, what you are trying to do, ' +
        'what you have already tried, any constraints, and what you specifically ' +
        'want the advisor to answer.',
    ),
})

type InputSchema = typeof inputSchema

const outputSchema = z.strictObject({
  advice: z.string().describe('The advice from the advisor model'),
  contextMessagesAvailable: z
    .number()
    .int()
    .min(0)
    .describe('Number of conversation messages available for the advisor to read via ReadConversationLog.'),
  conversationsRead: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of conversation messages the advisor actually read.'),
  filesRead: z
    .number()
    .int()
    .min(0)
    .describe('Number of files the advisor read during its analysis.'),
  toolsCalled: z
    .number()
    .int()
    .min(0)
    .describe('Total number of tool calls the advisor made.'),
  tokens: z
    .number()
    .min(0)
    .default(0)
    .describe('Total tokens consumed.'),
  durationMs: z
    .number()
    .min(0)
    .default(0)
    .describe('Total wall-clock duration in milliseconds.'),
  webSearched: z
    .boolean()
    .default(false)
    .describe('Whether the advisor performed a web search.'),
  blocks: z
    .array(z.object({
      type: z.enum(['tool', 'text']),
      text: z.string(),
    }))
    .default([])
    .describe('The raw content blocks from the advisor query, in order.'),
  toolCallSequence: z
    .array(z.string())
    .optional()
    .describe('Deprecated. Use blocks instead.'),
  interrupted: z
    .boolean()
    .default(false)
    .describe('Whether the advisor query was interrupted before completion.'),
  model: z
    .string()
    .optional()
    .describe('The advisor model used for this query.'),
})
type Output = z.infer<typeof outputSchema>

// ---------------------------------------------------------------------------
// Conversation log — in-memory snapshot + lazy-read tool
// ---------------------------------------------------------------------------

type ConversationEntry = {
  id: number
  role: 'user' | 'assistant'
  text: string
  charLength: number
  tools?: string[]
  truncated: boolean
}

// Serialization cache: fingerprint = all UUIDs joined.
// A middle-message change or reorder changes the UUID sequence.
let _cachedEntries: ConversationEntry[] | null = null
let _cachedFingerprint = ''

function serializeConversationLog(
  messages: readonly Message[],
): ConversationEntry[] {
  const fp = messages.map((m: any) => m.uuid ?? '').join(':')
  if (fp === _cachedFingerprint && _cachedEntries) return _cachedEntries
  const entries = doSerializeConversationLog(messages)
  _cachedEntries = entries
  _cachedFingerprint = fp
  return entries
}

function doSerializeConversationLog(
  messages: readonly Message[],
): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.type !== 'user' && msg.type !== 'assistant') continue

    const rawContent = (msg.message as any)?.content
    // Handle string content (from createUserMessage with string arg)
    if (typeof rawContent === 'string') {
      const charLength = rawContent.length
      let text = rawContent
      let truncated = false
      if (charLength > 16000) {
        text = rawContent.slice(0, 16000) + '\n\n[...truncated]'
        truncated = true
      }
      entries.push({
        id: i,
        role: msg.type,
        text,
        charLength,
        truncated,
      })
      continue
    }

    if (!rawContent || !Array.isArray(rawContent)) continue

    const content = rawContent as any[]
    const textParts: string[] = []
    const tools: string[] = []
    let truncated = false

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        tools.push(block.name || 'unknown')
      } else if (block.type === 'tool_result') {
        // tool_result.content can be string | ContentBlockParam[]
        const tc = block.content
        let resultText = ''
        if (typeof tc === 'string') {
          resultText = tc
        } else if (Array.isArray(tc)) {
          resultText = extractTextContent(tc, ' ')
        }
        if (resultText) {
          const label = block.is_error ? 'tool_result_error' : 'tool_result'
          textParts.push(`[${label}: ${resultText.slice(0, 500)}]`)
        } else if (block.is_error) {
          textParts.push(`[tool_result_error]`)
        }
      } else if (block.type === 'image' || block.type === 'image_url') {
        // Emit a compact marker — actual base64 data is too large for the log
        textParts.push(`[${block.type}]`)
      }
    }

    let text = textParts.join('\n')
    const charLength = text.length
    if (charLength > 16000) {
      text = text.slice(0, 16000) + '\n\n[...truncated]'
      truncated = true
    }

    entries.push({
      id: i,
      role: msg.type,
      text,
      charLength,
      tools: tools.length > 0 ? tools : undefined,
      truncated,
    })
  }
  return entries
}

function formatConversationIndex(entries: ConversationEntry[]): string {
  if (entries.length === 0) return 'No conversation history available.'
  const lines = entries.map(e => {
    const role = e.role === 'user' ? 'USER' : 'ASSISTANT'
    const toolInfo = e.tools ? ` [tools: ${e.tools.join(', ')}]` : ''
    const trunc = e.truncated ? ' (truncated)' : ''
    return `[${e.id}] ${role} (${e.charLength} chars)${toolInfo}${trunc}`
  })
  return `# Conversation log manifest (${entries.length} messages available)\n\n${lines.join('\n')}`
}

function createConversationLogTool(entries: ConversationEntry[]) {
  const entryMap = new Map(entries.map(e => [e.id, e]))
  // Track which unique IDs were successfully read (for conversationsRead stats)
  const uniqueReadIds = new Set<number>()

  const tool = buildTool({
    name: CONVERSATION_LOG_TOOL_NAME,

    async description() {
      return `Read the main agent's recent conversation history. Use action="index" first, then action="read" with message IDs.`
    },

    async prompt() {
      return `Read conversation history of the main agent. The log contains the most recent messages. Use action: "index" to list them, then action: "read" with message_ids to fetch full details for the ones you need.`
    },

    inputSchema: z.strictObject({
      action: z.enum(['index', 'read']).describe(
        '"index" lists available messages with roles, lengths and tools. "read" fetches full content for specific message IDs.',
      ),
      message_ids: z
        .array(z.number().int().min(0))
        .max(CONVERSATION_LOG_READ_LIMIT)
        .optional()
        .describe(`Message IDs to read. Maximum ${CONVERSATION_LOG_READ_LIMIT} per call.`),
    }),

    maxResultSizeChars: CONVERSATION_LOG_TOTAL_CHARS,

    isEnabled() { return true },
    isConcurrencySafe() { return true },
    isReadOnly() { return true },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: typeof output === 'string' ? output : JSON.stringify(output),
      }
    },

    renderToolUseMessage(input) {
      const inp = input as Partial<{ action: string; message_ids?: number[] }>
      if (inp.action === 'index') return <Text>Reading conversation index</Text>
      const count = inp.message_ids?.length ?? 0
      return <Text>{`Reading ${count} ${count === 1 ? 'message' : 'messages'} from log`}</Text>
    },

    async call(input: { action: 'index' | 'read'; message_ids?: number[] }) {
      if (input.action === 'index') {
        return { data: formatConversationIndex(entries) }
      }
      if (input.action === 'read') {
        const ids = input.message_ids ?? []
        if (ids.length === 0) return { data: 'No message IDs specified.' }
        const seen = new Set<number>()
        // De-duplicate while preserving order; count unique valid IDs
        let totalChars = 0
        const results: string[] = []
        for (const id of ids) {
          if (seen.has(id)) continue
          seen.add(id)
          const entry = entryMap.get(id)
          if (!entry) {
            results.push(`[${id}] NOT FOUND — ID out of range`)
            continue
          }
          uniqueReadIds.add(id)
          const truncTag = entry.truncated ? ' [truncated]' : ''
          const line = `[${id}] ${entry.role} (${entry.charLength} chars)${truncTag}:\n\n${entry.text}`
          totalChars += line.length
          if (totalChars > CONVERSATION_LOG_TOTAL_CHARS) {
            results.push(line.slice(0, CONVERSATION_LOG_TOTAL_CHARS - totalChars + line.length) + '\n\n[...output truncated]')
            break
          }
          results.push(line)
        }
        return { data: results.join('\n\n---\n\n') }
      }
      return { data: 'Unknown action. Use "index" or "read".' }
    },

    userFacingName() { return CONVERSATION_LOG_TOOL_NAME },
  })

  // Attach stats tracking for runAdvisorQuery to read
  ;(tool as any).__uniqueReadIds = uniqueReadIds
  return tool
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolLabel(name: string): string {
  if (name === 'Read') return 'Reading'
  if (name === 'Grep') return 'Searching'
  if (name === 'Glob') return 'Finding files'
  if (name === 'WebSearch') return 'Searching web'
  if (name === 'WebFetch') return 'Fetching URL'
  if (name === 'Bash') return 'Running'
  if (name === CONVERSATION_LOG_TOOL_NAME) return 'Reading log'
  return name
}

function truncateInput(input: unknown, maxLen: number): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

function formatToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return truncateInput(input, 60)
  const obj = input as Record<string, unknown>
  if (toolName === 'Read' && typeof obj.file_path === 'string') return obj.file_path
  if (toolName === 'Grep' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'WebSearch' && typeof obj.query === 'string') return truncateInput(obj.query, 80)
  if (toolName === 'WebFetch' && typeof obj.url === 'string') return obj.url
  if (toolName === 'Glob' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'Bash' && typeof obj.command === 'string') return truncateInput(obj.command, 80)
  if (toolName === CONVERSATION_LOG_TOOL_NAME) {
    if (obj.action === 'index') return '(index)'
    if (obj.action === 'read' && Array.isArray(obj.message_ids)) return `[${(obj.message_ids as number[]).join(', ')}]`
    return '(log)'
  }
  return truncateInput(input, 60)
}

type LiveAdvisorInfo = {
  model: string
  conversationMessagesRead: number
  toolUseCount: number
  fileReadCount: number
  webSearched: boolean
  lastTool: string
  lastInput: Record<string, unknown>
  startTime: number
}

function buildLiveBox(info: LiveAdvisorInfo): { jsx: JSX.Element; shouldHidePromptInput: false; shouldContinueAnimation: true; showSpinner: true } {
  const parts: string[] = []
  if (info.webSearched) parts.push('web searched')
  if (info.conversationMessagesRead > 0) parts.push(`${info.conversationMessagesRead} ${info.conversationMessagesRead === 1 ? 'message read' : 'messages read'}`)
  if (info.toolUseCount > 0) parts.push(`${info.toolUseCount} ${info.toolUseCount === 1 ? 'tool use' : 'tool uses'}`)
  if (info.fileReadCount > 0) parts.push(`${info.fileReadCount} ${info.fileReadCount === 1 ? 'file read' : 'files read'}`)
  const elapsed = Date.now() - info.startTime
  if (elapsed > 1000) parts.push(formatDuration(elapsed))
  const header = parts.length > 0 ? `${info.model} (${parts.join(' · ')})` : info.model
  const body = info.toolUseCount > 0
    ? `${toolLabel(info.lastTool)} ${formatToolInput(info.lastTool, info.lastInput)}`
    : 'Thinking…'
  return {
    jsx: (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{`${header}\n`}</Text>
        <Text dimColor>{body}</Text>
      </Box>
    ),
    shouldHidePromptInput: false,
    shouldContinueAnimation: true,
    showSpinner: true,
  }
}

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

  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
    options?: { verbose?: boolean },
  ) {
    const q = input.question || ''
    if (options?.verbose) return <Text>{q}</Text>
    const firstLine = q.split('\n')[0]
    const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine
    const needsTruncation = q.length > 100
    return <Text>{truncated}{needsTruncation ? '…' : ''}</Text>
  },

  renderToolResultMessage(
    content: Output,
    _progressMessages?: unknown,
    options?: { verbose?: boolean; input?: Record<string, unknown>; isTranscriptMode?: boolean },
  ) {
    const advice = content.advice || ''
    const model = content.model ?? getAdvisorModel() ?? 'advisor'
    const conversationsRead = content.conversationsRead ?? 0
    const filesRead = content.filesRead ?? 0
    const toolsCalled = content.toolsCalled ?? 0
    const tokens = content.tokens ?? 0
    const durationMs = content.durationMs ?? 0
    const webSearched = content.webSearched ?? false
    const interrupted = content.interrupted ?? false
    const stats = []
    if (interrupted) stats.push('interrupted')
    if (webSearched) stats.push('web searched')
    if (conversationsRead > 0) stats.push(`${conversationsRead} ${conversationsRead === 1 ? 'message read' : 'messages read'}`)
    if (toolsCalled > 0) stats.push(`${toolsCalled} ${toolsCalled === 1 ? 'tool use' : 'tool uses'}`)
    if (filesRead > 0) stats.push(`${filesRead} ${filesRead === 1 ? 'file read' : 'files read'}`)
    if (tokens > 0) stats.push(`${formatNumber(tokens)} tokens`)
    if (durationMs > 0) stats.push(formatDuration(durationMs))
    const header = stats.length > 0 ? `${model} (${stats.join(' · ')})` : model
    if (!advice) {
      return <Text dimColor>No response received</Text>
    }
    const children: React.ReactNode[] = []
    children.push(<Text bold>{`${header}\n`}</Text>)

    if (options?.verbose || options?.isTranscriptMode) {
      const blocks = content.blocks ?? []
      if (blocks.length > 0) {
        for (const block of blocks) {
          if (block.type === 'text') {
            children.push(<Text>{block.text + '\n'}</Text>)
          } else {
            children.push(<Text dimColor>{block.text + '\n'}</Text>)
          }
        }
      } else {
        children.push(<Text>{advice}</Text>)
      }
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {children}
        </Box>
      )
    }
    const previewLines = advice.split('\n').slice(0, 5)
    const preview = previewLines.join('\n').slice(0, 200)
    const adviceTruncated = advice.length > preview.length
    const hasToolBlocks = (content.blocks ?? []).some(b => b.type === 'tool')
    const needsExpand = adviceTruncated || hasToolBlocks
    children.push(
      <Text dimColor>{preview}{adviceTruncated ? '…' : ''}{needsExpand && <CtrlOToExpand />}</Text>,
    )
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        {children}
      </Box>
    )
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
): Promise<{ advice: string; filesRead: number; toolsCalled: number; tokens: number; durationMs: number; webSearched: boolean; blocks: Array<{ type: 'tool' | 'text'; text: string }>; interrupted: boolean; model: string; conversationsRead: number }> {
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
  const conversationEntries = serializeConversationLog(history.messages)
  const conversationTool = createConversationLogTool(conversationEntries)

  // Build identity-based allowlist from the current tool set.
  // Only built-in (non-MCP) tools are allowed — MCP tools with colliding
  // names must NOT be given built-in-tool privileges.
  const filteredTools = context.options.tools.filter(
    t => t.name !== ADVISOR_TOOL_NAME && isAdvisorAllowedBuiltin(t),
  )
  const advisorTools = [...filteredTools, conversationTool]

  const subagentCtx = createSubagentContext(context, {
    options: {
      ...context.options,
      mainLoopModel: advisorModel,
      tools: advisorTools,
      refreshTools: context.options.refreshTools
        ? () => {
            const allTools = context.options.refreshTools!()
            return [
              ...allTools.filter(
                t => t.name !== ADVISOR_TOOL_NAME && isAdvisorAllowedBuiltin(t),
              ),
              conversationTool,
            ]
          }
        : undefined,
    },
    requireCanUseTool: true,
  })

  // Only send the question — history is available via ReadConversationLog
  const queryMessages = [createUserMessage({ content: question })]

  const messages: any[] = []
  const info: LiveAdvisorInfo = {
    model: advisorModel,
    conversationMessagesRead: 0,
    toolUseCount: 0,
    fileReadCount: 0,
    webSearched: false,
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
      // Identity check: the conversation log tool is the exact object we created.
      if (tool === conversationTool) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      // Identity check: only built-in (non-MCP) tools from the allowlist.
      // Rejects MCP tools that happen to share a name with a built-in.
      if (isAdvisorAllowedBuiltin(tool as Tool)) {
        // Enforce read-only for Bash — prompt-level instructions are not a
        // security boundary. Uses the same read-only classifier as BashTool.
        if ((tool as Tool).name === 'Bash') {
          const roCheck = checkReadOnlyConstraints(input as any, false)
          if (roCheck.behavior !== 'allow') {
            const cmd =
              typeof input === 'object' && input !== null && 'command' in input
                ? (input as any).command
                : undefined
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
      }
      return {
        behavior: 'deny' as const,
        updatedInput: input,
        message: `The advisor cannot use ${(tool as any).name ?? 'unknown tool'}.`,
        decisionReason: {
          type: 'other' as const,
          reason: 'Advisor tools are restricted to a read-only allowlist.',
        },
      }
    },
    toolUseContext: subagentCtx,
    querySource: 'advisor' as any,
    skipCacheWrite: true,
  })

  let terminalResult: { reason: string } | undefined
  let sawApiError = false

  // Start tick timer after iterator creation
  tickTimer = context.setToolJSX
    ? setInterval(() => { context.setToolJSX!(buildLiveBox(info)) }, 1000)
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
      if (msg.type === 'assistant' && (msg as any).isApiErrorMessage) {
        sawApiError = true
      }
      // Push live UI update
      if (msg.type === 'assistant') {
        const blocks_ = (msg.message as any)?.content as any[]
        if (blocks_) {
          let updated = false
          for (const b of blocks_) {
            if (b.type === 'tool_use') {
              info.toolUseCount++
              if (b.name === 'Read') info.fileReadCount++
              if (b.name === 'WebSearch') info.webSearched = true
              if (b.name === CONVERSATION_LOG_TOOL_NAME && b.input?.action === 'read') {
                info.conversationMessagesRead += (b.input?.message_ids as any[])?.length ?? 0
              }
              info.lastTool = b.name
              info.lastInput = (b.input as Record<string, unknown>) ?? {}
              updated = true
            }
          }
          if (updated && context.setToolJSX) {
            context.setToolJSX(buildLiveBox(info))
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
    // Ensure iterator is closed on all paths
    try { await iterator.return?.() } catch {}
  }

  if (terminalResult?.reason === 'model_error') {
    throw new Error(
      `Advisor model returned an error (reason: ${terminalResult?.reason}, ` +
      `messages received: ${messages.length}).`,
    )
  }
  if (sawApiError) {
    throw new Error(
      `Advisor model returned an API error (messages received: ${messages.length}).`,
    )
  }

  const interrupted =
    terminalResult?.reason === 'aborted_streaming' ||
    terminalResult?.reason === 'aborted_tools'

  // Build blocks from final (post-tombstone) messages
  const blocks: Array<{ type: 'tool' | 'text'; text: string }> = []
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = (m.message as any)?.content as any[]
    if (!content) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        const s = formatToolInput(b.name, b.input)
        blocks.push({ type: 'tool', text: s ? `${toolLabel(b.name)} ${s}` : toolLabel(b.name) })
      } else if (b.type === 'text' && b.text) {
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
  const filesRead = toolUses.filter((t: any) => t.name === 'Read').length
  const toolsCalled = toolUses.length
  const webSearched = toolUses.some((t: any) => t.name === 'WebSearch')

  // Aggregate token usage deduplicated by API response ID (message.message.id).
  // Multi-block API responses produce multiple assistant messages per round;
  // usage is per-response, not per-block.
  let tokens = 0
  const seenResponseIds = new Set<string>()
  for (const m of assistantMessages) {
    const usage = (m as any).message?.usage
    if (!usage) continue
    const responseId = (m as any).message?.id as string | undefined
    if (responseId && seenResponseIds.has(responseId)) continue
    if (responseId) seenResponseIds.add(responseId)
    tokens +=
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0)
  }

  // Extract advice from the final logical API response only.
  // Multi-block responses produce several assistant messages sharing one
  // message.id — grouping by response ID gives the complete final answer.
  const lastAssistant = assistantMessages.at(-1)
  const finalResponseId = lastAssistant?.message?.id
  const finalMessages =
    finalResponseId !== undefined
      ? assistantMessages.filter(
          (m: any) => m.message?.id === finalResponseId,
        )
      : lastAssistant
        ? [lastAssistant]
        : []
  const finalBlocks = finalMessages.flatMap(
    (m: any) => m.message?.content ?? [],
  )
  const advice = extractTextContent(finalBlocks, '\n\n').trim()
  const durationMs = Date.now() - info.startTime
  const conversationsRead = (conversationTool as any).__uniqueReadIds instanceof Set
    ? (conversationTool as any).__uniqueReadIds.size
    : 0

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
    model: advisorModel,
    conversationsRead,
  }
}
