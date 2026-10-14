import { createUserMessage } from '../../utils/messages.js'
import type { UserMessage } from '../../types/message.js'
import type { RepeatToolReminder } from './types.js'

export const ANTI_LOOP_NOTICE_PREFIX = '[Claudium AntiLoop notice]'

export function createAntiLoopReminderText(reminder: RepeatToolReminder): string {
  if (reminder.thresholdIndex === 0) {
    return `${ANTI_LOOP_NOTICE_PREFIX}\nYou are repeating the exact same tool call with identical arguments. Carefully inspect the previous tool result before calling again. If the task remains incomplete, change your approach or arguments; otherwise finish.`
  }
  return `${ANTI_LOOP_NOTICE_PREFIX}\nRepeated tool call detected:\n- tool: ${reminder.toolName}\n- consecutive_calls: ${reminder.count}\n- arguments: ${reminder.argumentsPreview}\nThe repeated calls are not making progress. Inspect the latest result. Choose a different action or different arguments, or finish if enough evidence exists.`
}

export function createAntiLoopReminder(reminder: RepeatToolReminder): UserMessage {
  return createUserMessage({
    content: createAntiLoopReminderText(reminder),
    isMeta: true,
  })
}
