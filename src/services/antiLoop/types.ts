export type AntiLoopConfig = {
  enabled: boolean
  thresholds: number[]
  argumentsPreviewChars: number
}

export type RepeatToolCall = {
  toolName: string
  input: unknown
}

export type RepeatToolReminder = {
  toolName: string
  count: number
  argumentsPreview: string
  thresholdIndex: number
}
