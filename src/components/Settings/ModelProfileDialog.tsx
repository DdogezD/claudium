import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'

type Props = {
  title: string
  initialModel?: string
  initialContext?: number
  initialEffort?: string
  thinkingDisabled?: boolean
  onComplete: (profile: { model?: string; contextWindowTokens?: number; reasoningEffort?: string }) => void
  onCancel: () => void
}

const FIELD_NAMES = ['Model name', 'Context tokens', 'Reasoning effort'] as const

export function ModelProfileDialog({
  initialModel,
  initialContext,
  initialEffort,
  thinkingDisabled,
  onComplete,
  onCancel,
  title,
}: Props): React.ReactNode {
  const [model, setModel] = useState(initialModel ?? '')
  const [contextStr, setContextStr] = useState(initialContext ? String(initialContext) : '')
  const [effort, setEffort] = useState(initialEffort ?? '')
  const [focusedField, setFocusedField] = useState(0)
  const isTerminalFocused = useTerminalFocus()

  const [modelOffset, setModelOffset] = useState((initialModel ?? '').length)
  const [contextOffset, setContextOffset] = useState(contextStr.length)
  const [effortOffset, setEffortOffset] = useState((initialEffort ?? '').length)

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  function handleSubmit() {
    const ctxNum = contextStr.trim() ? Number(contextStr.trim()) : undefined
    onComplete({
      model: model.trim() || undefined,
      contextWindowTokens: ctxNum && Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : undefined,
      reasoningEffort: effort.trim().toLowerCase() || undefined,
    })
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>Leave blank to use defaults</Text>
      {thinkingDisabled && (
        <Text color="warning">Reasoning effort temporarily disabled (/thinking is off)</Text>
      )}

      {FIELD_NAMES.map((label, idx) => {
        const isActive = isTerminalFocused && focusedField === idx
        const handleFieldSubmit = focusedField < 2
          ? () => setFocusedField(focusedField + 1)
          : handleSubmit

        return (
          <Box key={label} flexDirection="row" gap={1}>
            <Text>{isActive ? figures.pointer : ' '}</Text>
            <Box flexDirection="column">
              <Text dimColor={!isActive}>{label}</Text>
              {idx === 0 ? (
                <TextInput
                  value={model}
                  onChange={setModel}
                  onSubmit={handleFieldSubmit}
                  focus={isActive}
                  showCursor={isActive}
                  placeholder="e.g., claude-sonnet-4-6"
                  columns={50}
                  cursorOffset={modelOffset}
                  onChangeCursorOffset={setModelOffset}
                />
              ) : idx === 1 ? (
                <TextInput
                  value={contextStr}
                  onChange={(v: string) => setContextStr(v.replace(/[^0-9]/g, ''))}
                  onSubmit={handleFieldSubmit}
                  focus={isActive}
                  showCursor={isActive}
                  placeholder="e.g., 200000"
                  columns={20}
                  cursorOffset={contextOffset}
                  onChangeCursorOffset={setContextOffset}
                />
              ) : (
                <TextInput
                  value={effort}
                  onChange={setEffort}
                  onSubmit={handleSubmit}
                  focus={isActive && !thinkingDisabled}
                  showCursor={isActive && !thinkingDisabled}
                  placeholder="e.g., high, max, low"
                  columns={20}
                  cursorOffset={effortOffset}
                  onChangeCursorOffset={setEffortOffset}
                />
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
