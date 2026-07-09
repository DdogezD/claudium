import React from 'react';

type Props = {
  onDone(): void;
};

export function ClaudeInChromeOnboarding({ onDone }: Props): React.ReactNode {
  React.useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}
