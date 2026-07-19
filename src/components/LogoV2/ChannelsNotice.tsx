import { feature } from 'bun:bundle'
import * as React from 'react'
import { getAllowedChannels, getHasDevChannels } from '../../bootstrap/state.js'
import { Box, Text } from '../../ink.js'

export function ChannelsNotice(): React.ReactNode {
  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) {
    return null
  }

  const channels = getAllowedChannels()
  if (channels.length === 0) {
    return null
  }

  const names = channels
    .map(channel =>
      channel.kind === 'plugin'
        ? `plugin:${channel.name}@${channel.marketplace}`
        : channel.name,
    )
    .join(', ')
  const suffix = getHasDevChannels() ? ' (development)' : ''

  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        Channels active{suffix} · {names}
      </Text>
    </Box>
  )
}

export const CHANNELS_NOTICE_COMPONENT = ChannelsNotice
