import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import createReconciler from 'react-reconciler'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import type { ParsedKey } from '../ink/parse-keypress.js'
import type { ModelOption } from '../utils/model/modelOptions.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'

const noop = () => {}
const empty = () => []
const cleanup = () => noop
const stubModule = (path: string, exports: Record<string, unknown>) =>
  mock.module(new URL(path, import.meta.url).pathname, () => exports)

const appState = {
  settings: {},
  mainLoopModelForSession: 'local-beta',
  mainLoopModel: 'local-alpha',
  mcp: { resources: [], clients: [] },
}
const store = { getState: () => appState, setState: noop }
let inputHandler: (input: string, key: unknown, event: {
  keypress: ParsedKey
  stopImmediatePropagation: () => void
}) => void
let keybindings: Record<string, () => void> = {}
let keybindingsActive = false
const listeners = new Set<() => void>()
let remoteOptions: ModelOption[] = []
const option = (value: string): ModelOption => ({ value, label: value, description: value })
const localOptions = [option('local-alpha'), option('local-beta')]
const getModelOptions = mock((sessionModel?: string | null) => {
  expect(sessionModel).toBe(appState.mainLoopModelForSession)
  return [...remoteOptions, ...localOptions]
})
const refreshDiscoveredModels = mock(() => new Promise<void>(() => {}))
const subscribeModelDiscovery = mock((listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
})
const startBackgroundCacheRefresh = mock(noop)

stubModule('../context/notifications.js', { useNotifications: () => ({ addNotification: noop }) })
stubModule('../ink.js', {
  Text: () => null,
  useInput: (handler: typeof inputHandler) => { inputHandler = handler },
})
stubModule('../services/analytics-stub.js', { logEvent: noop })
mock.module('usehooks-ts', () => ({
  useDebounceCallback: (callback: (...args: unknown[]) => unknown) => React.useMemo(
    () => Object.assign(callback, { cancel: noop, flush: noop, isPending: () => false }),
    [callback],
  ),
}))
stubModule('../commands.js', { getCommandName: (command: { name: string }) => command.name })
stubModule('../components/PromptInput/inputModes.js', {
  getModeFromInput: () => 'prompt', getValueFromInput: (value: string) => value,
})
stubModule('../context/overlayContext.js', {
  useIsModalOverlayActive: () => false, useRegisterOverlay: noop,
})
stubModule('../keybindings/KeybindingContext.js', {
  useOptionalKeybindingContext: () => null, useRegisterKeybindingContext: noop,
})
stubModule('../keybindings/useKeybinding.js', {
  useKeybindings: (handlers: typeof keybindings, options: { isActive: boolean }) => {
    keybindings = handlers
    keybindingsActive = options.isActive
  },
})
stubModule('../keybindings/useShortcutDisplay.js', { useShortcutDisplay: () => 'alt+t' })
stubModule('../state/AppState.js', {
  useAppState: (selector: (state: typeof appState) => unknown) => selector(appState),
  useAppStateStore: () => store,
})
stubModule('../utils/agentSwarmsEnabled.js', { isAgentSwarmsEnabled: () => false })
stubModule('../utils/argumentSubstitution.js', {
  generateProgressiveArgumentHint: () => undefined, parseArguments: empty,
})
stubModule('../utils/bash/shellCompletion.js', { getShellCompletions: async () => [] })
stubModule('../utils/format.js', { formatLogMetadata: () => ({}) })
stubModule('../utils/sessionStorage.js', {
  getSessionIdFromLog: noop, searchSessionsByCustomTitle: async () => [],
})
stubModule('../utils/model/modelDiscovery.js', { refreshDiscoveredModels, subscribeModelDiscovery })
stubModule('../utils/model/modelOptions.js', { getModelOptions })
stubModule('../utils/suggestions/commandSuggestions.js', {
  applyCommandSuggestion: noop,
  findMidInputSlashCommand: () => null,
  generateCommandSuggestions: empty,
  getBestCommandMatch: () => null,
  isCommandInput: (input: string) => input.startsWith('/'),
})
stubModule('../utils/suggestions/directoryCompletion.js', {
  getDirectoryCompletions: async () => [], getPathCompletions: async () => [],
  isPathLikeToken: () => false,
})
stubModule('../utils/suggestions/shellHistoryCompletion.js', { getShellHistoryCompletion: async () => null })
stubModule('../utils/suggestions/slackChannelSuggestions.js', {
  getSlackChannelSuggestions: async () => [], hasSlackMcpServer: () => false,
})
stubModule('../utils/swarm/constants.js', { TEAM_LEAD_NAME: 'team-lead' })
stubModule('./fileSuggestions.js', {
  applyFileSuggestion: noop, findLongestCommonPrefix: () => '',
  onIndexBuildComplete: cleanup, startBackgroundCacheRefresh,
})
stubModule('./unifiedSuggestions.js', { generateUnifiedSuggestions: async () => [] })

const { useTypeahead } = await import('./useTypeahead.js')
type Result = ReturnType<typeof useTypeahead>
type SuggestionsState = { suggestions: SuggestionItem[]; selectedSuggestion: number; commandArgumentHint?: string }

let priority = 2
const renderer = createReconciler({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  getRootHostContext: () => ({}),
  getChildHostContext: () => ({}),
  getPublicInstance: (instance: unknown) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  clearContainer: noop,
  shouldSetTextContent: () => false,
  createInstance: () => { throw new Error('The hook harness must not render host elements') },
  createTextInstance: () => { throw new Error('The hook harness must not render text') },
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  finalizeInitialChildren: () => false,
  commitUpdate: noop,
  commitTextUpdate: noop,
  resetTextContent: noop,
  detachDeletedInstance: noop,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  getCurrentUpdatePriority: () => priority,
  setCurrentUpdatePriority: (value: number) => { priority = value },
  resolveUpdatePriority: () => priority,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  resetFormInstance: noop,
  requestPostPaintCallback: noop,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
} as any)

let root: ReturnType<typeof renderer.createContainer> | undefined
let result: Result
let currentInput: string
let currentCursor: number
let changeInput: React.Dispatch<React.SetStateAction<string>>
let changeCursor: React.Dispatch<React.SetStateAction<number>>
const submit = mock((_value: string) => {})
const inputBoxSubmit = mock((_value: string) => {})
const commands: never[] = []
const agents: never[] = []

function Harness({ initialInput, initialCursor }: { initialInput: string; initialCursor: number }) {
  const [input, setInput] = React.useState(initialInput)
  const [cursor, setCursor] = React.useState(initialCursor)
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>({
    suggestions: [], selectedSuggestion: -1,
  })
  currentInput = input
  currentCursor = cursor
  changeInput = setInput
  changeCursor = setCursor
  result = useTypeahead({
    input, cursorOffset: cursor, onInputChange: setInput, setCursorOffset: setCursor,
    onSubmit: submit, mode: 'prompt', commands, agents,
    suggestionsState, setSuggestionsState,
  })
  return null
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function flush(action: () => void = noop) {
  await React.act(async () => {
    renderer.flushSyncFromReconciler(action)
    renderer.flushPassiveEffects()
  })
}

async function mount(input: string, cursor = input.length) {
  const fail = (error: unknown) => { throw error }
  root = renderer.createContainer({}, 0, null, false, null, '', fail, fail, fail, noop)
  await flush(() => renderer.updateContainerSync(
    React.createElement(Harness, { initialInput: input, initialCursor: cursor }), root!, null, noop,
  ))
}

async function discover(values: string[], callbacks = [...listeners]) {
  await flush(() => {
    remoteOptions = values.map(option)
    callbacks.forEach(listener => listener())
  })
}

async function binding(action: string) {
  expect(keybindingsActive).toBe(true)
  await flush(() => keybindings[action]!())
}

function parsedKey(name: string, modifiers: Partial<ParsedKey> = {}): ParsedKey {
  return {
    name, sequence: name === 'return' ? '\r' : name === 'tab' ? '\t' : '',
    ctrl: false, shift: false, meta: false, option: false, super: false, fn: false,
    ...modifiers,
  } as ParsedKey
}

async function pressEnter(modifiers: Partial<ParsedKey> = {}) {
  const event = new KeyboardEvent(parsedKey('return', modifiers))
  await flush(() => {
    result.handleKeyDown(event)
    if (!event.defaultPrevented && !event.didStopImmediatePropagation()) inputBoxSubmit(currentInput)
  })
  return event
}

const ids = () => result.suggestions.map(item => item.id)

beforeEach(() => {
  remoteOptions = []
  listeners.clear()
  getModelOptions.mockClear()
  refreshDiscoveredModels.mockClear()
  subscribeModelDiscovery.mockClear()
  startBackgroundCacheRefresh.mockClear()
  submit.mockClear()
  inputBoxSubmit.mockClear()
  keybindings = {}
  keybindingsActive = false
})

afterEach(async () => {
  if (root) await flush(() => renderer.updateContainerSync(null, root!, null, noop))
  root = undefined
  expect(listeners.size).toBe(0)
})

describe('useTypeahead model completion with an offline source', () => {
  test('shows local options before discovery resolves and updates when the remote catalog arrives', async () => {
    await mount('/model ')
    expect(result.suggestionType).toBe('model')
    expect(ids()).toEqual(['local-alpha', 'local-beta'])
    expect(refreshDiscoveredModels).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(1)
    await discover(['remote-gamma'])
    expect(ids()).toEqual(['remote-gamma', 'local-alpha', 'local-beta'])
    expect(result.suggestionType).toBe('model')
    expect(getModelOptions).toHaveBeenCalledWith('local-beta')
  })

  test.each([
    ['/model local', true],
    ['/model local-alpha ', false],
    ['/model local-alpha 200k', false],
    ['/model local-alpha 200k high', false],
    ['/model', false],
    ['Explain /model local', false],
  ])('only completes the first model argument in %s', async (input, expected) => {
    await mount(input)
    expect(ids().length > 0).toBe(expected)
    expect(result.suggestionType).toBe(expected ? 'model' : 'none')
    expect(listeners.size).toBe(expected ? 1 : 0)
  })

  test('preserves the selected model id when discovery inserts options before it', async () => {
    await mount('/model ')
    await binding('autocomplete:next')
    expect(result.suggestions[result.selectedSuggestion]?.id).toBe('local-beta')
    expect(result.selectedSuggestion).toBe(1)
    await discover(['remote-gamma', 'remote-delta'])
    expect(result.selectedSuggestion).toBe(3)
    expect(result.suggestions[result.selectedSuggestion]?.id).toBe('local-beta')
  })

  test('resets the selection when the model query changes', async () => {
    await mount('/model local')
    await binding('autocomplete:next')
    expect(result.suggestions[result.selectedSuggestion]?.id).toBe('local-beta')
    await flush(() => {
      changeInput('/model local-a')
      changeCursor('/model local-a'.length)
    })
    expect(result.selectedSuggestion).toBe(0)
    expect(result.suggestions[result.selectedSuggestion]?.id).toBe('local-alpha')
  })

  test('accepts Tab through the active keybinding without submitting', async () => {
    await mount('/model local-a')
    const tab = new KeyboardEvent(parsedKey('tab'))
    await flush(() => result.handleKeyDown(tab))
    expect(currentInput).toBe('/model local-a')
    await binding('autocomplete:accept')
    expect(currentInput).toBe('/model local-alpha ')
    expect(currentCursor).toBe(currentInput.length)
    expect(ids()).toEqual([])
    expect(submit).not.toHaveBeenCalled()
    expect(inputBoxSubmit).not.toHaveBeenCalled()
  })

  test('consumes the first Enter to accept and lets the second Enter reach input submission', async () => {
    await mount('/model local-a')
    const first = await pressEnter()
    expect(first.defaultPrevented).toBe(true)
    expect(first.didStopImmediatePropagation()).toBe(true)
    expect(currentInput).toBe('/model local-alpha ')
    expect(ids()).toEqual([])
    expect(submit).not.toHaveBeenCalled()
    expect(inputBoxSubmit).not.toHaveBeenCalled()
    const second = await pressEnter()
    expect(second.defaultPrevented).toBe(false)
    expect(second.didStopImmediatePropagation()).toBe(false)
    expect(inputBoxSubmit).toHaveBeenCalledTimes(1)
    expect(inputBoxSubmit).toHaveBeenCalledWith('/model local-alpha ')
    expect(submit).not.toHaveBeenCalled()
  })

  test('forwards immediate propagation cancellation through the captured useInput bridge', async () => {
    await mount('/model local-b')
    const stopImmediatePropagation = mock(noop)
    await flush(() => inputHandler('', {}, { keypress: parsedKey('return'), stopImmediatePropagation }))
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(currentInput).toBe('/model local-beta ')
    expect(submit).not.toHaveBeenCalled()
    await flush(() => inputHandler('', {}, { keypress: parsedKey('return'), stopImmediatePropagation }))
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
  })

  test('does not reopen after Escape when a previously subscribed discovery callback fires', async () => {
    await mount('/model ')
    const pending = [...listeners]
    expect(pending).toHaveLength(1)
    await binding('autocomplete:dismiss')
    expect(ids()).toEqual([])
    await discover(['remote-gamma'], pending)
    expect(currentInput).toBe('/model ')
    expect(ids()).toEqual([])
    expect(result.suggestionType).toBe('none')
    expect(keybindingsActive).toBe(false)
  })

  test.each(['Tab', 'Enter'])('does not reopen after accepting with %s when a stale discovery callback fires', async method => {
    await mount('/model local-a')
    const pending = [...listeners]
    if (method === 'Tab') await binding('autocomplete:accept')
    else await pressEnter()
    expect(currentInput).toBe('/model local-alpha ')
    await discover(['local-alpha-remote'], pending)
    expect(ids()).toEqual([])
    expect(result.suggestionType).toBe('none')
    expect(submit).not.toHaveBeenCalled()
    expect(inputBoxSubmit).not.toHaveBeenCalled()
  })

  test('clears completion on cursor-only movement into context and restores it on return', async () => {
    const input = '/model local-alpha 200k high'
    await mount(input, '/model local'.length)
    expect(ids()).toEqual(['local-alpha', 'local-beta'])
    await flush(() => changeCursor('/model local-alpha 20'.length))
    expect(currentInput).toBe(input)
    expect(ids()).toEqual([])
    expect(result.suggestionType).toBe('none')
    expect(listeners.size).toBe(0)
    await flush(() => changeCursor('/model local'.length))
    expect(currentInput).toBe(input)
    expect(ids()).toEqual(['local-alpha', 'local-beta'])
    expect(result.suggestionType).toBe('model')
    expect(listeners.size).toBe(1)
  })

  test('replaces the whole model token from its middle while preserving context and effort', async () => {
    await mount('/model local-obsolete 200k high', '/model local'.length)
    await binding('autocomplete:next')
    await binding('autocomplete:accept')
    expect(currentInput).toBe('/model local-beta 200k high')
    expect(currentCursor).toBe('/model local-beta'.length)
    expect(ids()).toEqual([])
    expect(submit).not.toHaveBeenCalled()
  })

  test.each([{ shift: true }, { meta: true }])('does not accept modified Enter with %j', async modifiers => {
    await mount('/model local-a')
    const event = new KeyboardEvent(parsedKey('return', modifiers))
    await flush(() => result.handleKeyDown(event))
    expect(currentInput).toBe('/model local-a')
    expect(ids()).toEqual(['local-alpha'])
    expect(event.defaultPrevented).toBe(false)
    expect(event.didStopImmediatePropagation()).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  test('allows an unknown manual model id to submit without candidates or event interception', async () => {
    await mount('/model vendor/manual-id')
    expect(ids()).toEqual([])
    expect(result.suggestionType).toBe('none')
    const event = await pressEnter()
    expect(event.defaultPrevented).toBe(false)
    expect(event.didStopImmediatePropagation()).toBe(false)
    expect(currentInput).toBe('/model vendor/manual-id')
    expect(inputBoxSubmit).toHaveBeenCalledTimes(1)
    expect(inputBoxSubmit).toHaveBeenCalledWith('/model vendor/manual-id')
    expect(submit).not.toHaveBeenCalled()
  })
})
