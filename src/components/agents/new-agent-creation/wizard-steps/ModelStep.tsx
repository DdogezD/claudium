import React, { type ReactNode } from 'react'
import { useWizard } from '../../../wizard/index.js'
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js'
import { AgentModelInput } from '../../AgentModelInput.js'
import type { AgentWizardData } from '../types.js'

export function ModelStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } =
    useWizard<AgentWizardData>()

  const handleComplete = (result: { model?: string; contextWindowTokens?: number; reasoningEffort?: string }): void => {
    updateWizardData({
      selectedModel: result.model,
      selectedModelContext: result.contextWindowTokens,
      selectedModelEffort: result.reasoningEffort,
    })
    goNext()
  }

  return (
    <WizardDialogLayout subtitle="Select model" footerText={null}>
      <AgentModelInput
        initialModel={wizardData.selectedModel}
        initialContext={wizardData.selectedModelContext}
        initialEffort={wizardData.selectedModelEffort}
        onComplete={handleComplete}
        onCancel={goBack}
      />
    </WizardDialogLayout>
  )
}
