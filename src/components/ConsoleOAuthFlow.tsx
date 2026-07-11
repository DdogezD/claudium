import React from 'react';
import { Box, Text } from '../ink.js';

type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
};

export function ConsoleOAuthFlow(props: Props): React.ReactElement {
  React.useEffect(() => {
    // OAuth has been stripped — API-key auth is the only valid path.
    // Only auto-advance if the user already has credentials configured.
    if (process.env.ANTHROPIC_API_KEY) {
      props.onDone()
    }
  }, []);

  if (!process.env.ANTHROPIC_API_KEY) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Login via ANTHROPIC_API_KEY environment variable</Text>
        <Text>Set the environment variable and restart.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text>Login via ANTHROPIC_API_KEY environment variable</Text>
    </Box>
  )
}
