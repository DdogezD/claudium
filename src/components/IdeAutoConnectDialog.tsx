import React from 'react';

type IdeAutoConnectDialogProps = {
  onComplete: () => void;
};

export function IdeAutoConnectDialog({ onComplete }: IdeAutoConnectDialogProps): React.ReactNode {
  React.useEffect(() => {
    onComplete();
  }, [onComplete]);
  return null;
}

export function shouldShowAutoConnectDialog(): boolean {
  return false;
}

export function IdeDisableAutoConnectDialog({ onComplete }: { onComplete: (disableAutoConnect: boolean) => void }): React.ReactNode {
  return null;
}

export function shouldShowDisableAutoConnectDialog(): boolean {
  return false;
}
