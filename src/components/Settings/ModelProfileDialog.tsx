import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'

type Props = {
  title: string
  initialModel?: string
  initialContext?: number
  initialEffort?: string
  thinkingDisabled?: boolean
  /** When true, show an Enabled toggle (for advisor). */
  showEnabled?: boolean
  initialEnabled?: boolean
  initialEnabledValue?: boolean
  onComplete: (profile: { model?: string | null; contextWindowTokens?: number | null; reasoningEffort?: string | null; enabled?: boolean }) => void
  onCancel: () => void
}

const MAIN_FIELDS = ['Model name', 'Context tokens', 'Reasoning effort'] as const

export function ModelProfileDialog({
  initialModel,
  initialContext,
  initialEffort,
  thinkingDisabled,
  showEnabled,
  initialEnabled,
  initialEnabledValue,
  onComplete,
  onCancel,
  title,
}: Props): React.ReactNode {
  const [model, setModel] = useState(initialModel ?? '')
  const [contextStr, setContextStr] = useState(initialContext ? String(initialContext) : '')
  const [effort, setEffort] = useState(initialEffort ?? '')
  const [enabled, setEnabled] = useState(initialEnabled ?? false)
  const [modelChanged, setModelChanged] = useState(false)
  const [contextChanged, setContextChanged] = useState(false)
  const [effortChanged, setEffortChanged] = useState(false)
  const [enabledChanged, setEnabledChanged] = useState(false)
  // -1 = enabled toggle, 0/1/2 = text fields
  const [focusedField, setFocusedField] = useState(showEnabled ? -1 : 0)
  const isTerminalFocused = useTerminalFocus()

  const [modelOffset, setModelOffset] = useState((initialModel ?? '').length)
  const [contextOffset, setContextOffset] = useState(contextStr.length)
  const [effortOffset, setEffortOffset] = useState((initialEffort ?? '').length)

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const showFields = !showEnabled || enabled
  const lastField = showFields
    ? thinkingDisabled
      ? 1
      : 2
    : showEnabled
      ? -1
      : 2

  function handleSubmit() {
    const ctxNum = contextStr.trim() ? Number(contextStr.trim()) : undefined
    const profile: {
      model?: string | null
      contextWindowTokens?: number | null
      reasoningEffort?: string | null
      enabled?: boolean
    } = {}
    if (modelChanged) profile.model = model.trim() || null
    if (contextChanged) {
      profile.contextWindowTokens =
        ctxNum && Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : null
    }
    if (effortChanged) profile.reasoningEffort = effort.trim().toLowerCase() || null
    if (showEnabled && enabledChanged) profile.enabled = enabled
    onComplete(profile)
  }

  // Enter on a text field: advance to next, or submit on last.
  function advanceOrSubmit() {
    if (focusedField < lastField) {
      setFocusedField(focusedField + 1)
    } else {
      handleSubmit()
    }
  }

  const handleNavigationInput = useCallback(
    (input: string, key: Key) => {
      if (!isTerminalFocused) return
      const lo = showEnabled ? -1 : 0

      // Enable toggle row: space to toggle, enter to advance.
      if (focusedField === -1) {
        if (input === ' ') {
          setEnabled(e => !e)
          setEnabledChanged(true)
          return
        }
        if (key.return) {
          if (showFields) setFocusedField(0)
          else handleSubmit()
          return
        }
      }
      if (key.upArrow) {
        setFocusedField(prev => {
          const n = prev - 1
          return n < lo ? lastField : n
        })
      } else if (key.downArrow) {
        setFocusedField(prev => {
          const n = prev + 1
          return n > lastField ? lo : n
        })
      }
    },
    [focusedField, enabled, showEnabled, showFields, lastField, isTerminalFocused],
  )
  useInput(handleNavigationInput)

  const enabledFocused = showEnabled && focusedField === -1
  const onLastField = focusedField === lastField

  let footerHint: string
  if (lastField === -1) {
    // Only the toggle is visible (disabled)
    footerHint = 'space to toggle · enter to confirm'
  } else if (enabledFocused) {
    footerHint = 'space to toggle · enter to next'
  } else if (onLastField) {
    footerHint = 'enter to confirm'
  } else {
    footerHint = 'enter to edit field'
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      {!showEnabled && <Text dimColor>Leave blank to use defaults</Text>}
      {showEnabled && initialEnabledValue === undefined && (
        <Text dimColor>Leave unchanged to preserve the current setting</Text>
      )}
      {thinkingDisabled && (
        <Text color="warning">Reasoning effort temporarily disabled (/thinking is off)</Text>
      )}

      {showEnabled && (
        <Box flexDirection="row" gap={1}>
          <Text>{enabledFocused ? figures.pointer : ' '}</Text>
          <Text color={enabled ? 'success' : 'subtle'}>{enabled ? 'Enabled' : 'Disabled'}</Text>
        </Box>
      )}

      {showFields && MAIN_FIELDS.slice(0, thinkingDisabled ? 2 : 3).map((label, idx) => {
        const isActive = isTerminalFocused && focusedField === idx
        const dimmed = !isActive

        return (
          <Box key={label} flexDirection="row" gap={1}>
            <Text>{isActive ? figures.pointer : ' '}</Text>
            <Box flexDirection="column">
              <Text dimColor={dimmed}>{label}</Text>
              {idx === 0 ? (
                <TextInput
                  value={model}
                  onChange={value => {
                    setModel(value)
                    setModelChanged(true)
                  }}
                  onSubmit={advanceOrSubmit}
                  focus={isActive}
                  showCursor={isActive}
                  placeholder="e.g., my-model-id"
                  columns={50}
                  cursorOffset={modelOffset}
                  onChangeCursorOffset={setModelOffset}
                />
              ) : idx === 1 ? (
                <TextInput
                  value={contextStr}
                  onChange={(v: string) => {
                    setContextStr(v.replace(/[^0-9]/g, ''))
                    setContextChanged(true)
                  }}
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
                  onChange={value => {
                    setEffort(value)
                    setEffortChanged(true)
                  }}
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

      <Box marginTop={1}>
        <Text dimColor>{footerHint} · Esc to cancel</Text>
      </Box>
    </Box>
  )
}
