import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'
import { ANTI_LOOP_DEFAULTS } from '../../services/antiLoop/config.js'
import type { AntiLoopConfig } from '../../services/antiLoop/types.js'

export type AntiLoopChanges = Partial<AntiLoopConfig>

type Props = {
  initial?: Partial<AntiLoopConfig>
  onComplete: (changes: AntiLoopChanges) => Error | null
  onCancel: () => void
}

const FIELDS = ['Enabled', 'Thresholds', 'Arguments preview chars'] as const

export function AntiLoopSettingsDialog({ initial, onComplete, onCancel }: Props): React.ReactNode {
  const initialValues = {
    enabled: initial?.enabled ?? ANTI_LOOP_DEFAULTS.enabled,
    thresholds: (initial?.thresholds ?? ANTI_LOOP_DEFAULTS.thresholds).join(','),
    argumentsPreviewChars: String(initial?.argumentsPreviewChars ?? ANTI_LOOP_DEFAULTS.argumentsPreviewChars),
  }
  const [values, setValues] = useState(initialValues)
  const [changed, setChanged] = useState<Record<string, boolean>>({})
  const [focusedField, setFocusedField] = useState(0)
  const [offsets, setOffsets] = useState([initialValues.thresholds.length, initialValues.argumentsPreviewChars.length])
  const [error, setError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const submit = useCallback(() => {
    const changes: AntiLoopChanges = {}
    if (changed.enabled && values.enabled !== initialValues.enabled) changes.enabled = values.enabled
    const thresholds = values.thresholds.split(',').map(value => Number(value.trim())).filter(value => value !== 0 || values.thresholds.trim() === '0')
    if (changed.thresholds && (thresholds.length === 0 || thresholds.some(value => !Number.isInteger(value) || value < 2) || new Set(thresholds).size !== thresholds.length || thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1]!))) {
      setError('Thresholds must be ascending, unique integers of at least 2')
      return
    }
    if (changed.thresholds && thresholds.join(',') !== initialValues.thresholds) changes.thresholds = thresholds
    const preview = Number(values.argumentsPreviewChars.trim())
    if (changed.argumentsPreviewChars && (!Number.isInteger(preview) || preview <= 0)) {
      setError('Arguments preview chars must be a positive integer')
      return
    }
    if (changed.argumentsPreviewChars && String(preview) !== initialValues.argumentsPreviewChars) changes.argumentsPreviewChars = preview
    const result = onComplete(changes)
    setError(result?.message ?? null)
  }, [changed, initialValues, onComplete, values])

  const advanceOrSubmit = useCallback(() => {
    if (focusedField < FIELDS.length - 1) setFocusedField(previous => previous + 1)
    else submit()
  }, [focusedField, submit])

  const handleNavigationInput = useCallback((input: string, key: Key) => {
    if (!isTerminalFocused) return
    if (key.upArrow || key.downArrow) {
      setFocusedField(previous => key.upArrow ? Math.max(0, previous - 1) : Math.min(FIELDS.length - 1, previous + 1))
      return
    }
    if (focusedField === 0 && key.return) {
      setFocusedField(1)
      return
    }
    if (focusedField === 0 && (key.leftArrow || key.rightArrow || input === ' ')) {
      setValues(previous => ({ ...previous, enabled: !previous.enabled }))
      setChanged(previous => ({ ...previous, enabled: true }))
    }
  }, [focusedField, isTerminalFocused])
  useInput(handleNavigationInput)

  return <Box flexDirection="column" gap={1}>
    <Text bold>AntiLoop settings</Text>
    <Text dimColor>Remind the model about exact repeated tool calls without blocking execution.</Text>
    {FIELDS.map((label, index) => {
      const active = isTerminalFocused && focusedField === index
      if (label === 'Enabled') return <Box key={label} flexDirection="row" gap={1}><Text>{active ? figures.pointer : ' '}</Text><Text color={active ? 'suggestion' : undefined}>{label}: {values.enabled ? 'true' : 'false'}</Text></Box>
      const field = label === 'Thresholds' ? 'thresholds' : 'argumentsPreviewChars'
      const offsetIndex = index - 1
      return <Box key={label} flexDirection="row" gap={1}><Text>{active ? figures.pointer : ' '}</Text><Box flexDirection="column"><Text dimColor={!active}>{label}</Text><TextInput value={values[field]} onChange={value => { setValues(previous => ({ ...previous, [field]: value })); setChanged(previous => ({ ...previous, [field]: true })); setError(null) }} onSubmit={advanceOrSubmit} focus={active} showCursor={active} columns={36} cursorOffset={offsets[offsetIndex]} onChangeCursorOffset={offset => setOffsets(previous => previous.map((old, i) => i === offsetIndex ? offset : old))} /></Box></Box>
    })}
    {error && <Text color="error">Save failed: {error}</Text>}
    <Text dimColor>↑/↓ switch fields · Enter next field/save · Esc cancel</Text>
  </Box>
}
