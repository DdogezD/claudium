import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import TextInput from '../TextInput.js'
import { formatProfileSummary, getModelProfile } from '../../utils/model/modelProfiles.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'

interface Props {
  initialModel?: string
  onComplete: (model?: string) => void
  onCancel: () => void
  hideFooter?: boolean
}

export function AgentModelInput({
  initialModel,
  onComplete,
  onCancel,
  hideFooter,
}: Props): React.ReactNode {
  const [model, setModel] = useState(initialModel ?? '')
  const [cursorOffset, setCursorOffset] = useState((initialModel ?? '').length)
  const subagentSummary = formatProfileSummary(getModelProfile('subagent'))

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  function handleSubmit() {
    const trimmed = model.trim()
    onComplete(trimmed || undefined)
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>
          Subagent Model (from /config):{' '}
          <Text color="suggestion">{subagentSummary}</Text>
        </Text>
        <Text dimColor>
          Leave blank to use Subagent Model, or type a model name / 'inherit'.
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text dimColor>Model name</Text>
        <TextInput
          value={model}
          onChange={setModel}
          onSubmit={handleSubmit}
          focus={true}
          showCursor={true}
          placeholder="e.g., inherit, my-model-id"
          columns={50}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
        />
      </Box>

      {!hideFooter && (
        <Box marginTop={1}>
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
            </Byline>
          </Text>
        </Box>
      )}
    </Box>
  )
}
