import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'
import { ANTI_REPETITION_DEFAULTS } from '../../services/antiRepetition/config.js'
import type { AntiRepetitionConfig } from '../../services/antiRepetition/types.js'

export type AntiRepetitionChanges = Partial<Pick<AntiRepetitionConfig, 'enabled' | 'autoResume' | 'maxRecoveries'>>

type Props = {
  initial?: Partial<AntiRepetitionConfig>
  onComplete: (changes: AntiRepetitionChanges) => Error | null
  onCancel: () => void
}

const FIELDS = ['Enabled', 'Auto-resume', 'Max recoveries'] as const
type BooleanField = 'enabled' | 'autoResume'
const BOOLEAN_FIELDS: BooleanField[] = ['enabled', 'autoResume']

export function AntiRepetitionSettingsDialog({ initial, onComplete, onCancel }: Props): React.ReactNode {
  const initialValues = {
    enabled: initial?.enabled ?? ANTI_REPETITION_DEFAULTS.enabled,
    autoResume: initial?.autoResume ?? ANTI_REPETITION_DEFAULTS.autoResume,
    maxRecoveries: initial?.maxRecoveries ?? ANTI_REPETITION_DEFAULTS.maxRecoveries,
  }
  const [values, setValues] = useState(initialValues)
  const [changed, setChanged] = useState<Record<string, boolean>>({})
  const [focusedField, setFocusedField] = useState(0)
  const [maxRecoveriesText, setMaxRecoveriesText] = useState(String(initialValues.maxRecoveries))
  const [maxRecoveriesOffset, setMaxRecoveriesOffset] = useState(maxRecoveriesText.length)
  const [error, setError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const submit = useCallback(() => {
    const trimmed = maxRecoveriesText.trim()
    const parsed = Number(trimmed)
    if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
      setError('Max recoveries must be an integer from 0 to 10')
      return
    }
    const changes: AntiRepetitionChanges = {}
    for (const field of BOOLEAN_FIELDS) {
      if (changed[field] && values[field] !== initialValues[field]) changes[field] = values[field]
    }
    if (changed.maxRecoveries && parsed !== initialValues.maxRecoveries) changes.maxRecoveries = parsed
    const result = onComplete(changes)
    setError(result?.message ?? null)
  }, [changed, initialValues, maxRecoveriesText, onComplete, values])

  const advanceOrSubmit = useCallback(() => {
    if (focusedField < FIELDS.length - 1) {
      setFocusedField(previous => previous + 1)
    } else {
      submit()
    }
  }, [focusedField, submit])

  const handleNavigationInput = useCallback((input: string, key: Key) => {
    if (!isTerminalFocused) return
    if (key.upArrow || key.downArrow) {
      setFocusedField(previous => key.upArrow ? Math.max(0, previous - 1) : Math.min(FIELDS.length - 1, previous + 1))
      return
    }
    if (focusedField < BOOLEAN_FIELDS.length && key.return) {
      advanceOrSubmit()
      return
    }
    if (focusedField < BOOLEAN_FIELDS.length && (key.leftArrow || key.rightArrow || input === ' ')) {
      const field = BOOLEAN_FIELDS[focusedField]!
      setValues(previous => ({ ...previous, [field]: !previous[field] }))
      setChanged(previous => ({ ...previous, [field]: true }))
    }
  }, [advanceOrSubmit, focusedField, isTerminalFocused])
  useInput(handleNavigationInput)

  return <Box flexDirection="column" gap={1}>
    <Text bold>Anti-repetition settings</Text>
    <Text dimColor>Configure the anti-repetition guard independently.</Text>
    <Text dimColor>Auto-resume only belongs to AntiRep. It does not affect max_output_tokens or tokenBudget.</Text>
    {FIELDS.map((label, index) => {
      const isActive = isTerminalFocused && focusedField === index
      const field = BOOLEAN_FIELDS[index]
      return <Box key={label} flexDirection="row" gap={1}>
        <Text>{isActive ? figures.pointer : ' '}</Text>
        <Box flexDirection="column">
          <Text dimColor={!isActive}>{label}</Text>
          {field ? <Text color={isActive ? 'suggestion' : undefined}>{values[field] ? 'true' : 'false'}</Text> : <TextInput
            value={maxRecoveriesText}
            onChange={value => { setMaxRecoveriesText(value); setChanged(previous => ({ ...previous, maxRecoveries: true })); setError(null) }}
            onSubmit={advanceOrSubmit}
            focus={isActive}
            showCursor={isActive}
            columns={10}
            cursorOffset={maxRecoveriesOffset}
            onChangeCursorOffset={setMaxRecoveriesOffset}
          />}
        </Box>
      </Box>
    })}
    {error && <Text color="error">Save failed: {error}</Text>}
    <Text dimColor>↑/↓ switch fields · ←/→/Space toggle · Enter {focusedField < FIELDS.length - 1 ? 'next field' : 'save'} · Esc cancel</Text>
  </Box>
}
