import { z } from 'zod/v4'

const CONVERSATION_LOG_READ_LIMIT = 20

export const conversationLogIndexSchema = z.strictObject({
  action: z.literal('index').describe('List available messages.'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Number of most recent messages to skip (for paging back). Default 0.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe('Number of messages to show. Default 200, max 500.'),
})

export const conversationLogSearchSchema = z.strictObject({
  action: z.literal('search').describe('Search conversation messages by keyword.'),
  query: z
    .string()
    .min(1)
    .max(2000)
    .describe('Text to search for.'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Number of search results to return. Default 10, max 50.'),
  match_mode: z
    .enum(['or', 'all'])
    .default('or')
    .describe('"or" returns messages matching any term (default). "all" requires every term to match.'),
})

export const conversationLogReadSchema = z.strictObject({
  action: z.literal('read').describe('Fetch full content for specific message IDs.'),
  message_ids: z
    .array(z.number().int().min(0))
    .min(1)
    .max(CONVERSATION_LOG_READ_LIMIT)
    .describe(`Message IDs to read. Maximum ${CONVERSATION_LOG_READ_LIMIT} per call.`),
})

export const conversationLogInputSchema = z.discriminatedUnion('action', [
  conversationLogIndexSchema,
  conversationLogSearchSchema,
  conversationLogReadSchema,
])

export type ConversationLogInput = z.infer<typeof conversationLogInputSchema>

export const inputSchema = z.strictObject({
  question: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .describe(
      'What do you need advice on? Describe the problem, what you are trying to do, ' +
        'what you have already tried, any constraints, and what you specifically ' +
        'want the advisor to answer.',
    ),
})

export type InputSchema = typeof inputSchema

export const outputSchema = z.strictObject({
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
  interrupted: z
    .boolean()
    .default(false)
    .describe('Whether the advisor query was interrupted before completion.'),
  terminationReason: z
    .enum([
      'completed',
      'max_turns',
      'aborted_streaming',
      'aborted_tools',
      'prompt_too_long',
      'hook_stopped',
      'blocking_limit',
      'image_error',
      'stop_hook_prevented',
      'iterator_closed',
    ])
    .describe('How the advisor query ended.'),
  model: z
    .string()
    .optional()
    .describe('The advisor model used for this query.'),
})

export type Output = z.infer<typeof outputSchema>
