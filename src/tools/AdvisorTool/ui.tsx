import { Box, Text } from '../../ink.js'
import type { Output } from './schemas.js'
import { getAdvisorModel } from '../../utils/advisor.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { extractTag } from '../../utils/messages.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { CONVERSATION_LOG_TOOL_NAME } from './prompt.js'

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function toolLabel(name: string): string {
  if (name === 'Read') return 'Reading'
  if (name === 'Grep') return 'Searching'
  if (name === 'Glob') return 'Finding files'
  if (name === 'WebSearch') return 'Searching web'
  if (name === 'WebFetch') return 'Fetching URL'
  if (name === 'Bash') return 'Running'
  if (name === CONVERSATION_LOG_TOOL_NAME) {
    return 'Reading log'
  }
  return name
}

export function truncateInput(input: unknown, maxLen: number): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

export function formatToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return truncateInput(input, 60)
  const obj = input as Record<string, unknown>
  if (toolName === 'Read' && typeof obj.file_path === 'string') return obj.file_path
  if (toolName === 'Grep' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'WebSearch' && typeof obj.query === 'string') return truncateInput(obj.query, 80)
  if (toolName === 'WebFetch' && typeof obj.url === 'string') return obj.url
  if (toolName === 'Glob' && typeof obj.pattern === 'string') return obj.pattern
  if (toolName === 'Bash' && typeof obj.command === 'string') return truncateInput(obj.command, 80)
  if (toolName === CONVERSATION_LOG_TOOL_NAME) {
    if (obj.action === 'search') return `"${truncateInput(obj.query, 60)}"`
    if (obj.action === 'index') return '(index)'
    if (obj.action === 'read' && Array.isArray(obj.message_ids)) return `[${(obj.message_ids as number[]).join(', ')}]`
    return '(log)'
  }
  return truncateInput(input, 60)
}

// ---------------------------------------------------------------------------
// Live progress box
// ---------------------------------------------------------------------------

export interface AdvisorProgress {
  model: string
  toolUseCount: number
  lastTool: string
  lastInput: Record<string, unknown>
  startTime: number
}

export function buildAdvisorLiveBox(info: AdvisorProgress): {
  jsx: JSX.Element
  shouldHidePromptInput: false
  shouldContinueAnimation: true
  showSpinner: true
} {
  const parts: string[] = []
  if (info.toolUseCount > 0) parts.push(`${info.toolUseCount} ${info.toolUseCount === 1 ? 'tool use' : 'tool uses'}`)
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
// Advisor result rendering
// ---------------------------------------------------------------------------

export function renderAdvisorToolUseMessage(
  input: { question?: string },
  options?: { verbose?: boolean },
): string | JSX.Element {
  const q = input.question || ''
  if (options?.verbose) return <Text>{q}</Text>
  if (!q) return ''
  const firstLine = q.split('\n')[0]
  const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine
  const needsTruncation = q.length > 100
  return <Text>{truncated}{needsTruncation ? '…' : ''}</Text>
}

export function renderAdvisorToolErrorMessage(
  content: unknown,
  options?: { verbose?: boolean },
): JSX.Element {
  if (!options?.verbose && typeof content === 'string' && extractTag(content, 'tool_use_error')) {
    return <MessageResponse><Text color="error">Error calling advisor</Text></MessageResponse>
  }
  return <FallbackToolUseErrorMessage result={content} verbose={options?.verbose ?? false} />
}

export function renderAdvisorToolResultMessage(
  content: Output,
  options?: { verbose?: boolean; input?: Record<string, unknown>; isTranscriptMode?: boolean },
): JSX.Element {
  const advice = content.advice || ''
  const model = content.model ?? getAdvisorModel() ?? 'advisor'
  const conversationsRead = content.conversationsRead ?? 0
  const filesRead = content.filesRead ?? 0
  const toolsCalled = content.toolsCalled ?? 0
  const tokens = content.tokens ?? 0
  const durationMs = content.durationMs ?? 0
  const webSearched = content.webSearched ?? false
  const interrupted = content.interrupted ?? false
  const terminationReason = content.terminationReason
  const stats = []
  if (terminationReason && terminationReason !== 'completed') {
    stats.push(terminationReason.replace(/_/g, ' '))
  } else if (interrupted) {
    stats.push('interrupted')
  }
  if (webSearched) stats.push('web searched')
  if (conversationsRead > 0) stats.push(`${conversationsRead} ${conversationsRead === 1 ? 'message read' : 'messages read'}`)
  if (toolsCalled > 0) stats.push(`${toolsCalled} ${toolsCalled === 1 ? 'tool use' : 'tool uses'}`)
  if (filesRead > 0) stats.push(`${filesRead} ${filesRead === 1 ? 'file read' : 'files read'}`)
  if (tokens > 0) {
    stats.push(`${formatNumber(tokens)} tokens`)
  } else if (toolsCalled > 0) {
    stats.push('tokens unavailable')
  }
  if (durationMs > 0) stats.push(formatDuration(durationMs))
  const header = stats.length > 0 ? `${model} (${stats.join(' · ')})` : model
  if (!advice) {
    return <Text dimColor>No response received</Text>
  }
  const children: React.ReactNode[] = []
  children.push(<Text key="header" bold>{`${header}\n`}</Text>)

  if (options?.verbose || options?.isTranscriptMode) {
    const blocks = content.blocks ?? []
    if (blocks.length > 0) {
      blocks.forEach((block, i) => {
        if (block.type === 'text') {
          children.push(<Text key={`b-${i}`}>{block.text + '\n'}</Text>)
        } else {
          children.push(<Text key={`b-${i}`} dimColor>{block.text + '\n'}</Text>)
        }
      })
    } else {
      children.push(<Text key="advice">{advice}</Text>)
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
    <Text key="preview" dimColor>{preview}{adviceTruncated ? '…' : ''}{needsExpand && <CtrlOToExpand />}</Text>,
  )
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {children}
    </Box>
  )
}
