import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, type Key, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'

type Props = {
  initialEffort?: string
  /** null clears the setting (thinking blocks off, no effort sent). */
  onComplete: (effort: string | null) => void
  onCancel: () => void
}

/**
 * Single-field dialog for webSearch.effort — the thinking switch and
 * reasoning effort of the WebSearch subquery (result summary + rerank).
 * Blank = thinking off, no effort sent.
 */
export function WebSearchEffortDialog({
  initialEffort,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [effort, setEffort] = useState(initialEffort ?? '')
  const [offset, setOffset] = useState((initialEffort ?? '').length)
  const isTerminalFocused = useTerminalFocus()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  function handleSubmit() {
    onComplete(effort.trim() || null)
  }

  const handleInput = useCallback(
    (_input: string, key: Key) => {
      if (!isTerminalFocused) return
      if (key.return) handleSubmit()
    },
    [isTerminalFocused, effort],
  )
  useInput(handleInput)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Web search effort</Text>
      <Text dimColor>
        Thinking effort for the WebSearch subquery (summary + rerank). Leave
        blank to keep thinking off.
      </Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <Box flexDirection="column">
          <Text dimColor>Reasoning effort</Text>
          <TextInput
            value={effort}
            onChange={setEffort}
            onSubmit={handleSubmit}
            focus={isTerminalFocused}
            showCursor={isTerminalFocused}
            placeholder="e.g., low, high, xhigh"
            columns={20}
            cursorOffset={offset}
            onChangeCursorOffset={setOffset}
          />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter to confirm · Esc to cancel</Text>
      </Box>
    </Box>
  )
}
