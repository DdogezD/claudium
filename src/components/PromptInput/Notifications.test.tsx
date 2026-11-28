import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import chalk from 'chalk'
import { Writable } from 'node:stream'
import Box from '../../ink/components/Box.js'
import { renderSync } from '../../ink/root.js'
import { colorize } from '../../ink/colorize.js'
import { Parser } from '../../ink/termio/parser.js'
import { AppStoreContext, type AppStateStore, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import * as config from '../../utils/config.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getTheme } from '../../utils/theme.js'
import { Notifications } from './Notifications.js'

function glyphs(output: string) {
  return new Parser().feed(output).flatMap(action => action.type === 'text'
    ? action.graphemes.map(glyph => ({ text: glyph.value, color: action.style.fg }))
    : [])
}

function expectColor(frame: string, text: string, color: string) {
  const cells = glyphs(frame)
  const start = cells.map(cell => cell.text).join('').indexOf(text)
  expect(start).toBeGreaterThanOrEqual(0)
  const expected = glyphs(colorize(text, color, 'foreground'))
  expect(cells.slice(start, start + text.length)).toEqual(expected)
}

const NOTICE = '(Auto-compaction will occur soon)'
const overrides = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
  CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS: '20000',
  CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS: '13000',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
  DISABLE_COMPACT: '',
  DISABLE_AUTO_COMPACT: '',
}
const previousEnv = Object.fromEntries([...Object.keys(overrides), 'NODE_ENV'].map(key => [key, process.env[key]]))
const chalkLevel = chalk.level
let configSpy: { mockRestore(): void }

beforeEach(() => {
  config.enableConfigs()
  configSpy = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...config.getGlobalConfig(), autoCompactEnabled: true })
  Object.assign(process.env, overrides)
  chalk.level = 3
})

afterEach(() => {
  configSpy.mockRestore()
  chalk.level = chalkLevel
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function footer(store: AppStateStore, usage: number) {
  const response = createAssistantMessage({ content: 'Response.' })
  response.message.model = 'test-model'
  response.message.stop_reason = 'end_turn'
  response.message.usage.input_tokens = usage
  return <AppStoreContext.Provider value={store}>
    <Notifications apiKeyStatus="valid" autoUpdaterResult={null} isAutoUpdating={false} debug={false} verbose={false}
      messages={[response]} onAutoUpdaterResult={() => {}} onChangeIsUpdating={() => {}} ideSelection={undefined} />
  </AppStoreContext.Provider>
}

function notice(queryGeneration: number) {
  return { queryGeneration, onPainted: mock(() => {}), cancel: () => {} }
}

test('preserves the footer format and colors only the actual automatic compaction notice', async () => {
  const store = createStore(getDefaultAppState())
  let frame = Promise.withResolvers<string>()
  let output = ''
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }) as NodeJS.WriteStream
  const app = renderSync(footer(store, 83_000), {
    stdout, patchConsole: false, exitOnCtrlC: false,
    onFrame() {
      if (output !== '') frame.resolve(output)
      output = ''
    },
  })
  try {
    const theme = getTheme('dark')
    expectColor(await frame.promise, '83K/262K(64% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    app.rerender(footer(store, 210_000))
    expectColor(await frame.promise, '210K/262K(8% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    app.rerender(footer(store, 250_000))
    expectColor(await frame.promise, '250K/262K(0% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    store.setState(prev => ({ ...prev, autoCompactNotice: notice(1) }))
    const active = await frame.promise
    expectColor(active, '250K/262K', theme.inactive)
    expectColor(active, NOTICE, theme.error)

    frame = Promise.withResolvers<string>()
    store.setState(prev => ({ ...prev, autoCompactNotice: undefined }))
    expectColor(await frame.promise, '250K/262K(0% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    process.env.DISABLE_AUTO_COMPACT = '1'
    store.setState(prev => ({ ...prev, autoCompactNotice: notice(2) }))
    app.rerender(footer(store, 251_000))
    expectColor(await frame.promise, '251K/262K(0% available)', theme.inactive)
  } finally {
    app.unmount()
  }
})

test('confirms only a visible notice whose terminal write finishes while it is mounted', async () => {
  // The production renderer measures the frame after React has attached refs.
  process.env.NODE_ENV = 'production'
  const store = createStore(getDefaultAppState())
  const cropped = notice(1)
  store.setState(prev => ({ ...prev, autoCompactNotice: cropped }))
  let frame = Promise.withResolvers<string>()
  let output = ''
  let finishWrite: (() => void) | undefined
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) {
      const text = chunk.toString()
      output += text
      if (text.includes(NOTICE)) finishWrite = done
      else done()
    },
  }), { isTTY: true, columns: 120, rows: 24 }) as NodeJS.WriteStream
  const app = renderSync(<Box width={28} overflow="hidden">{footer(store, 250_000)}</Box>, {
    stdout, patchConsole: false, exitOnCtrlC: false,
    onFrame() {
      frame.resolve(output)
      output = ''
    },
  })
  const commit = (next: ReturnType<typeof notice> | undefined) => {
    frame = Promise.withResolvers<string>()
    store.setState(prev => ({ ...prev, autoCompactNotice: next }))
    return frame.promise
  }
  const flush = async () => {
    const finish = finishWrite
    finishWrite = undefined
    finish?.()
    await new Promise<void>(resolve => stdout.write('', () => resolve()))
  }
  try {
    const clippedFrame = await frame.promise
    expect(clippedFrame).toContain('(Auto-')
    expect(clippedFrame).not.toContain(NOTICE)
    expect(cropped.onPainted).not.toHaveBeenCalled()

    const baseline = commit(undefined)
    app.rerender(footer(store, 250_000))
    await baseline

    const stale = notice(2)
    expectColor(await commit(stale), NOTICE, getTheme('dark').error)
    expect(stale.onPainted).not.toHaveBeenCalled()
    const next = notice(3)
    expect(await commit(next)).toBe('')
    await flush()
    expect(stale.onPainted).not.toHaveBeenCalled()
    expect(next.onPainted).not.toHaveBeenCalled()

    await commit(undefined)
    const visible = notice(4)
    expectColor(await commit(visible), NOTICE, getTheme('dark').error)
    expect(visible.onPainted).not.toHaveBeenCalled()
    await flush()
    expect(visible.onPainted).toHaveBeenCalledTimes(1)
  } finally {
    await flush()
    // This test stream has no real terminal modes to reset on fd 1.
    stdout.isTTY = false
    app.unmount()
  }
})
