import React from 'react';
import type { IDEExtensionInstallationStatus } from '../utils/ide.js';

interface Props {
  onDone: () => void;
  installationStatus: IDEExtensionInstallationStatus | null;
}

export function IdeOnboardingDialog({ onDone }: Props): React.ReactNode {
  React.useEffect(() => {
    onDone();
  }, [onDone]);
  return null;
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  return true;
}
