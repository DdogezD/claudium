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
    props.onDone();
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Text>Login via ANTHROPIC_API_KEY environment variable</Text>
    </Box>
  );
}
