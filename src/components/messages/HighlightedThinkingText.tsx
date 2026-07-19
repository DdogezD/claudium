import figures from 'figures'
import * as React from 'react'
import { useContext } from 'react'
import { useQueuedMessage } from '../../context/QueuedMessageContext.js'
import { Box, Text } from '../../ink.js'
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js'
import { MessageActionsSelectedContext } from '../messageActions.js'

type Props = {
  text: string
  useBriefLayout?: boolean
  timestamp?: string
}

export function HighlightedThinkingText({
  text,
  useBriefLayout,
  timestamp,
}: Props): React.ReactNode {
  const isQueued = useQueuedMessage()?.isQueued ?? false
  const isSelected = useContext(MessageActionsSelectedContext)
  const pointerColor = isSelected ? 'suggestion' : 'subtle'

  if (useBriefLayout) {
    const ts = timestamp ? formatBriefTimestamp(timestamp) : ''
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color={isQueued ? 'subtle' : 'briefLabelYou'}>You</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        <Text color={isQueued ? 'subtle' : 'text'}>{text}</Text>
      </Box>
    )
  }

  return (
    <Text>
      <Text color={pointerColor}>{figures.pointer} </Text>
      <Text color="text">{text}</Text>
    </Text>
  )
}
