import { expect, spyOn, test } from 'bun:test'
import chalk from 'chalk'
import { Writable } from 'node:stream'
import { renderSync } from '../../ink/root.js'
import { colorize } from '../../ink/colorize.js'
import { Parser } from '../../ink/termio/parser.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
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

test('preserves the footer format and colors only the actual automatic compaction notice', async () => {
  const overrides = {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
    CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS: '20000',
    CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS: '13000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
    DISABLE_COMPACT: '',
    DISABLE_AUTO_COMPACT: '',
  }
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  const chalkLevel = chalk.level
  config.enableConfigs()
  const configSpy = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...config.getGlobalConfig(), autoCompactEnabled: true })
  Object.assign(process.env, overrides)
  chalk.level = 3

  let app: ReturnType<typeof renderSync> | undefined
  try {
    const store = createStore(getDefaultAppState())
    const tree = (usage: number) => {
      const response = createAssistantMessage({ content: 'Response.' })
      response.message.model = 'test-model'
      response.message.stop_reason = 'end_turn'
      response.message.usage.input_tokens = usage
      return <AppStoreContext.Provider value={store}>
        <Notifications apiKeyStatus="valid" autoUpdaterResult={null} isAutoUpdating={false} debug={false} verbose={false}
          messages={[response]} onAutoUpdaterResult={() => {}} onChangeIsUpdating={() => {}} ideSelection={undefined} />
      </AppStoreContext.Provider>
    }
    let frame = Promise.withResolvers<string>()
    let output = ''
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }) as NodeJS.WriteStream
    app = renderSync(tree(83_000), {
      stdout, patchConsole: false, exitOnCtrlC: false,
      onFrame() {
        if (output !== '') frame.resolve(output)
        output = ''
      },
    })
    const theme = getTheme('dark')
    expectColor(await frame.promise, '83K/262K(64% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    app.rerender(tree(210_000))
    expectColor(await frame.promise, '210K/262K(8% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    app.rerender(tree(250_000))
    expectColor(await frame.promise, '250K/262K(0% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    store.setState(prev => ({ ...prev, autoCompactQueryGeneration: 1 }))
    const active = await frame.promise
    expectColor(active, '250K/262K', theme.inactive)
    expectColor(active, '(Auto-compaction will occur soon)', theme.error)

    frame = Promise.withResolvers<string>()
    store.setState(prev => ({ ...prev, autoCompactQueryGeneration: undefined }))
    expectColor(await frame.promise, '250K/262K(0% available)', theme.inactive)

    frame = Promise.withResolvers<string>()
    process.env.DISABLE_AUTO_COMPACT = '1'
    store.setState(prev => ({ ...prev, autoCompactQueryGeneration: 2 }))
    app.rerender(tree(251_000))
    expectColor(await frame.promise, '251K/262K(0% available)', theme.inactive)
  } finally {
    app?.unmount()
    configSpy.mockRestore()
    chalk.level = chalkLevel
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
