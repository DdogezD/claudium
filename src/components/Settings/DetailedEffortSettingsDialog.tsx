import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'

export type DetailedEffortChanges = {
  webSearch?: string | null
  sessionTitle?: string | null
}

type Props = {
  initialWebSearchEffort?: string
  initialTitleEffort?: string
  // undefined means unchanged; null clears the user override. Draft values stay
  // visible when saving fails.
  onComplete: (changes: DetailedEffortChanges) => Error | null
  onCancel: () => void
}

const FIELDS = [
  'WebSearch (summary + rerank)',
  'Title generation',
] as const

export function DetailedEffortSettingsDialog({
  initialWebSearchEffort,
  initialTitleEffort,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const initialValues = [
    initialWebSearchEffort ?? '',
    initialTitleEffort ?? '',
  ]
  const [values, setValues] = useState(initialValues)
  const [changed, setChanged] = useState([false, false])
  const [offsets, setOffsets] = useState(values.map(value => value.length))
  const [focusedField, setFocusedField] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  function advanceOrSubmit() {
    if (focusedField < FIELDS.length - 1) {
      setFocusedField(previous => previous + 1)
      return
    }
    const changes: DetailedEffortChanges = {}
    for (const [index, field] of ['webSearch', 'sessionTitle'].entries()) {
      const value = values[index]!.trim() || null
      if (
        changed[index] &&
        value !==
          (initialValues[index] === '' ? null : initialValues[index] ?? null)
      ) {
        changes[field as keyof DetailedEffortChanges] = value
      }
    }
    const result = onComplete(changes)
    setError(result?.message ?? null)
  }

  // Enter is handled by the active TextInput to avoid duplicate submission.
  const handleNavigationInput = useCallback(
    (_input: string, key: Key) => {
      if (!isTerminalFocused) return
      if (key.upArrow || key.downArrow) {
        setFocusedField(previous =>
          key.upArrow
            ? Math.max(0, previous - 1)
            : Math.min(FIELDS.length - 1, previous + 1),
        )
      }
    },
    [isTerminalFocused],
  )
  useInput(handleNavigationInput)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Detailed effort settings</Text>
      <Text dimColor>
        Configure these independently. Values are passed through unchanged, including provider-specific values.
      </Text>
      <Text dimColor>
        Clearing removes only the user override; project, managed, or environment settings may still apply. Unedited fields are preserved.
      </Text>
      {FIELDS.map((label, index) => {
        const isActive = isTerminalFocused && focusedField === index
        return (
          <Box key={label} flexDirection="row" gap={1}>
            <Text>{isActive ? figures.pointer : ' '}</Text>
            <Box flexDirection="column">
              <Text dimColor={!isActive}>{label}</Text>
              <TextInput
                value={values[index]!}
                onChange={value => {
                  setValues(previous => previous.map((old, i) => i === index ? value : old))
                  setChanged(previous => previous.map((old, i) => i === index ? true : old))
                }}
                onSubmit={advanceOrSubmit}
                focus={isActive}
                showCursor={isActive}
                placeholder="leave blank / low / high / xhigh / none"
                columns={30}
                cursorOffset={offsets[index]!}
                onChangeCursorOffset={offset => {
                  setOffsets(previous => previous.map((old, i) => i === index ? offset : old))
                }}
              />
            </Box>
          </Box>
        )
      })}
      {error && <Text color="error">Save failed: {error}</Text>}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ switch fields · {focusedField < FIELDS.length - 1 ? 'Enter next field' : 'Enter save'} · Esc cancel
        </Text>
      </Box>
    </Box>
  )
}
