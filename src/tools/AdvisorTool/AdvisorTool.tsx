import { z } from 'zod/v4'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import {
  getAdvisorModel,
  isAdvisorEnabled,
} from '../../utils/advisor.js'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_TOOL_NAME,
  ADVISOR_TOOL_DESCRIPTION,
} from './prompt.js'

// Read-only tools the advisor subagent can use — statically defined to avoid
// calling isReadOnly() on Tool objects inside the subagent context (which
// crashes with _.command / _.includes errors in createSubagentContext).
const READ_ONLY_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'TaskOutput',
  'TaskGet',
  'TaskList',
  'ListMcpResources',
  'ReadMcpResource',
])

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
})
type Output = z.infer<typeof outputSchema>

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
    return true
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
    options?: { verbose?: boolean },
  ) {
    const advice = content.advice || ''
    const model = getAdvisorModel() || 'advisor'
    if (!advice) {
      return <Text dimColor>No response received</Text>
    }
    if (options?.verbose) {
      return (
        <Box flexDirection="column" borderStyle="round" padding={1}>
          <Text bold>Advisor ({model})</Text>
          <Text>{advice}</Text>
        </Box>
      )
    }
    const firstLine = advice.split('\n')[0].slice(0, 200)
    const needsExpand = advice.length > 200
    return (
      <Box flexDirection="column" borderStyle="round" padding={1}>
        <Text bold>Advisor ({model})</Text>
        <Text dimColor>{firstLine}{needsExpand ? '…' : ''} {needsExpand && <CtrlOToExpand />}</Text>
      </Box>
    )
  },

  async call({ question }, context) {
    const model = getAdvisorModel()
    if (!model) {
      throw new Error('Advisor is not configured. Set CLAUDE_CODE_ADVISOR_MODEL.')
    }

    const advice = await runAdvisorQuery(question, model, context)
    return { data: { advice } }
  },
} satisfies ToolDef<InputSchema, Output>)

// ---------------------------------------------------------------------------
// Advisor as lightweight subagent — direct query() call, one turn, no tools
// ---------------------------------------------------------------------------

async function runAdvisorQuery(
  question: string,
  advisorModel: string,
  context: ToolUseContext,
): Promise<string> {
  const { query } = await import('../../query.js')
  const { getUserContext, getSystemContext } = await import('../../context.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')

  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])

  const systemPrompt = asSystemPrompt([ADVISOR_SYSTEM_PROMPT])

  const subagentCtx = createSubagentContext(context, {
    options: {
      ...context.options,
      mainLoopModel: advisorModel,
      tools: context.options.tools.filter(t => {
        if (t.name === ADVISOR_TOOL_NAME) return false
        return READ_ONLY_TOOL_NAMES.has(t.name)
      }),
    },
  })

  const messages: any[] = []
  for await (const msg of query({
    messages: [createUserMessage({ content: question })],
    systemPrompt,
    userContext,
    systemContext,
    canUseTool: async (_toolName, _input) => ({
      behavior: 'allow' as const,
      updatedInput: _input,
    }),
    toolUseContext: subagentCtx,
    querySource: 'advisor' as any,
    skipCacheWrite: true,
  })) {
    if (msg.type === 'assistant' || msg.type === 'user') {
      messages.push(msg)
    }
  }

  const assistantBlocks = messages.flatMap((m: any) =>
    m.type === 'assistant' ? m.message.content : [],
  )
  const advice = extractTextContent(assistantBlocks, '\n\n').trim()
  if (!advice) throw new Error('Advisor returned no response.')
  return advice
}
