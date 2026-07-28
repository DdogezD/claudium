import React, { useCallback, useState } from 'react'
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../services/analytics-stub.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Link, Newline, Text, useInput, useTerminalFocus } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { WelcomeV2 } from './LogoV2/WelcomeV2.js'
import { PressEnterToContinue } from './PressEnterToContinue.js'
import { ThemePicker } from './ThemePicker.js'
import TextInput from './TextInput.js'
import { OrderedList } from './ui/OrderedList.js'

type OnboardingStep = 'theme' | 'model' | 'security'

type Props = {
  onDone(): void
}

const MODEL_FIELDS = ['Model name', 'Context tokens', 'Reasoning effort'] as const

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [step, setStep] = useState<OnboardingStep>('theme')

  const [model, setModel] = useState('')
  const [contextStr, setContextStr] = useState('')
  const [effort, setEffort] = useState('')
  const [focusedField, setFocusedField] = useState(0)
  const isTerminalFocused = useTerminalFocus()

  const [modelOffset, setModelOffset] = useState(0)
  const [contextOffset, setContextOffset] = useState(0)
  const [effortOffset, setEffortOffset] = useState(0)

  const lastIndex = 2

  const handleThemeSelection = useCallback(() => {
    logEvent('tengu_onboarding_step', {
      stepId: 'model' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    setStep('model')
  }, [])

  const saveAndContinue = useCallback(() => {
    const trimmed = model.trim()
    const ctxNum = contextStr.trim() ? Number(contextStr.trim()) : undefined
    const effortVal = effort.trim().toLowerCase() || undefined

    if (trimmed || ctxNum || effortVal) {
      const main: Record<string, unknown> = {}
      if (trimmed) main.model = trimmed
      if (ctxNum && Number.isFinite(ctxNum) && ctxNum > 0) main.contextWindowTokens = ctxNum
      if (effortVal) main.reasoningEffort = effortVal

      if (Object.keys(main).length > 0) {
        updateSettingsForSource('userSettings', {
          modelProfiles: { main },
        })
      }
    }

    logEvent('tengu_onboarding_step', {
      stepId: 'security' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    setStep('security')
  }, [model, contextStr, effort])

  const skipModel = useCallback(() => {
    logEvent('tengu_onboarding_step', {
      stepId: 'security' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    setStep('security')
  }, [])

  const handleNavigationInput = useCallback(
    (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
      if (!isTerminalFocused) return
      if (key.upArrow) {
        setFocusedField(prev => (prev > 0 ? prev - 1 : lastIndex))
      } else if (key.downArrow) {
        setFocusedField(prev => (prev < lastIndex ? prev + 1 : 0))
      }
    },
    [isTerminalFocused],
  )
  useInput(handleNavigationInput, { isActive: step === 'model' })

  const advanceOrSubmit = useCallback(() => {
    if (focusedField < lastIndex) {
      setFocusedField(focusedField + 1)
    } else {
      saveAndContinue()
    }
  }, [focusedField, saveAndContinue])

  const exitState = useExitOnCtrlCDWithKeybindings()

  useKeybindings(
    { 'confirm:yes': onDone },
    { context: 'Confirmation', isActive: step === 'security' },
  )

  useKeybindings(
    { 'confirm:no': skipModel },
    { context: 'Settings', isActive: step === 'model' },
  )

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {step === 'theme' ? (
          <Box marginX={1}>
            <ThemePicker
              onThemeSelect={handleThemeSelection}
              showIntroText={true}
              helpText="To change this later, run /theme"
              hideEscToCancel={true}
              skipExitHandling={true}
            />
          </Box>
        ) : step === 'model' ? (
          <Box flexDirection="column" marginX={1} gap={1}>
            <Text bold>Configure your model</Text>
            <Text dimColor wrap="wrap">
              Leave blank to skip. You can change these later with{' '}
              <Text bold>/model</Text>.
            </Text>
            <Box flexDirection="column" gap={1}>
              {MODEL_FIELDS.map((label, idx) => {
                const isActive = isTerminalFocused && focusedField === idx && step === 'model'
                const dimmed = !isActive

                return (
                  <Box key={label} flexDirection="row" gap={1}>
                    <Text>{isActive ? '❯' : ' '}</Text>
                    <Box flexDirection="column">
                      <Text dimColor={dimmed}>{label}</Text>
                      {idx === 0 ? (
                        <TextInput
                          value={model}
                          onChange={setModel}
                          onSubmit={advanceOrSubmit}
                          focus={isActive}
                          showCursor={isActive}
                          placeholder="e.g., my-model-id"
                          columns={50}
                          cursorOffset={modelOffset}
                          onChangeCursorOffset={setModelOffset}
                        />
                      ) : idx === 1 ? (
                        <TextInput
                          value={contextStr}
                          onChange={(v: string) => setContextStr(v.replace(/[^0-9]/g, ''))}
                          onSubmit={advanceOrSubmit}
                          focus={isActive}
                          showCursor={isActive}
                          placeholder="e.g., 200000"
                          columns={20}
                          cursorOffset={contextOffset}
                          onChangeCursorOffset={setContextOffset}
                        />
                      ) : (
                        <TextInput
                          value={effort}
                          onChange={setEffort}
                          onSubmit={advanceOrSubmit}
                          focus={isActive}
                          showCursor={isActive}
                          placeholder="e.g., low, medium, high, max"
                          columns={20}
                          cursorOffset={effortOffset}
                          onChangeCursorOffset={setEffortOffset}
                        />
                      )}
                    </Box>
                  </Box>
                )
              })}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                {'↑↓ to navigate · enter to edit · Esc to skip'}
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1} paddingLeft={1}>
            <Text bold>Security notes:</Text>
            <Box flexDirection="column" width={70}>
              <OrderedList>
                <OrderedList.Item>
                  <Text>AI can make mistakes</Text>
                  <Text dimColor wrap="wrap">
                    You should always review AI&apos;s responses, especially when
                    <Newline />
                    running code.
                    <Newline />
                  </Text>
                </OrderedList.Item>
                <OrderedList.Item>
                  <Text>
                    Due to prompt injection risks, only use it with code you trust
                  </Text>
                  <Text dimColor wrap="wrap">
                    For more details see:
                    <Newline />
                    <Link url="https://code.claude.com/docs/en/security" />
                  </Text>
                </OrderedList.Item>
              </OrderedList>
            </Box>
            <PressEnterToContinue />
          </Box>
        )}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
