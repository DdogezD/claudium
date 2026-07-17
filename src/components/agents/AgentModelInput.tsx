import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'
import { formatProfileSummary, getModelProfile } from '../../utils/model/modelProfiles.js'

export interface AgentModelInputResult {
  model?: string
  contextWindowTokens?: number
  reasoningEffort?: string
}

interface Props {
  initialModel?: string
  initialContext?: number
  initialEffort?: string
  onComplete: (result: AgentModelInputResult) => void
  onCancel: () => void
}

const MAIN_FIELDS = ['Model name', 'Context tokens', 'Reasoning effort'] as const

export function AgentModelInput({
  initialModel,
  initialContext,
  initialEffort,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [model, setModel] = useState(initialModel ?? '')
  const [contextStr, setContextStr] = useState(initialContext ? String(initialContext) : '')
  const [effort, setEffort] = useState(initialEffort ?? '')
  // -1 = Subagent Model quick-select, 0/1/2 = custom text fields
  const [focusedField, setFocusedField] = useState(-1)
  const isTerminalFocused = useTerminalFocus()
  const subagentSummary = formatProfileSummary(getModelProfile('subagent'), 'subagent')

  const [modelOffset, setModelOffset] = useState((initialModel ?? '').length)
  const [contextOffset, setContextOffset] = useState(contextStr.length)
  const [effortOffset, setEffortOffset] = useState((initialEffort ?? '').length)

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const lastIndex = 2

  function handleSubmit() {
    const ctxNum = contextStr.trim() ? Number(contextStr.trim()) : undefined
    onComplete({
      model: model.trim() || undefined,
      contextWindowTokens: ctxNum && Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : undefined,
      reasoningEffort: effort.trim().toLowerCase() || undefined,
    })
  }

  function advanceOrSubmit() {
    if (focusedField < lastIndex) {
      setFocusedField(focusedField + 1)
    } else {
      handleSubmit()
    }
  }

  const handleNavigationInput = useCallback(
    (input: string, key: Key) => {
      if (!isTerminalFocused) return

      // Subagent Model row: Enter = quick-select, up/down = navigate
      if (focusedField === -1) {
        if (key.return) {
          onComplete({})
          return
        }
      }

      if (key.upArrow) {
        setFocusedField(prev => (prev > -1 ? prev - 1 : lastIndex))
      } else if (key.downArrow) {
        setFocusedField(prev => (prev < lastIndex ? prev + 1 : -1))
      }
    },
    [isTerminalFocused, focusedField],
  )
  useInput(handleNavigationInput)

  const onSubagentRow = focusedField === -1
  const onLastField = focusedField === lastIndex

  return (
    <Box flexDirection="column" gap={1}>
      {/* Quick-select: Subagent Model */}
      <Box flexDirection="row" gap={1}>
        <Text>{onSubagentRow ? '❯' : ' '}</Text>
        <Box flexDirection="column">
          <Text dimColor={!onSubagentRow}>Subagent Model (from /config)</Text>
          <Text color={onSubagentRow ? 'suggestion' : undefined} dimColor={!onSubagentRow}>
            {subagentSummary}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>─ or customize ─</Text>
      </Box>

      {MAIN_FIELDS.map((label, idx) => {
        const isActive = isTerminalFocused && focusedField === idx
        const dimmed = !isActive

        return (
          <Box key={label} flexDirection="row" gap={1}>
            <Text>{isActive ? '❯' : ' '}</Text>
            <Box flexDirection="column">
              <Text dimColor={dimmed}>{label}</Text>
              {idx === 0 ? (
                <TextInput
                  value={model}
                  onChange={setModel}
                  onSubmit={advanceOrSubmit}
                  focus={isActive}
                  showCursor={isActive}
                  placeholder="e.g., inherit, my-model-id"
                  columns={50}
                  cursorOffset={modelOffset}
                  onChangeCursorOffset={setModelOffset}
                />
              ) : idx === 1 ? (
                <TextInput
                  value={contextStr}
                  onChange={(v: string) => setContextStr(v.replace(/[^0-9]/g, ''))}
                  onSubmit={advanceOrSubmit}
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
                  focus={isActive}
                  showCursor={isActive}
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

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ to navigate{' '}
          {onSubagentRow
            ? '· enter to select'
            : onLastField
              ? '· enter to confirm'
              : '· enter to edit field'}{' '}
          · Esc to cancel
        </Text>
      </Box>
    </Box>
  )
}
