import { describe, expect, it, spyOn } from 'bun:test'
import * as sessionStorage from './utils/sessionStorage.js'
import { QueryEngine, type QueryEngineConfig } from './QueryEngine.js'
import { isSessionPersistenceDisabled, setSessionPersistenceDisabled } from './bootstrap/state.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { createAssistantMessage, createAssistantAPIErrorMessage, createUserMessage } from './utils/messages.js'
import { FileStateCache } from './utils/fileStateCache.js'

async function runFixture(
  events: unknown[],
  includePartialMessages = false,
  options: {
    persistSession?: boolean
    captureError?: boolean
    onQueryEvent?: (event: unknown) => void
    onOutput?: (message: any) => void
  } = {},
) {
  const previousPersistence = isSessionPersistenceDisabled()
  const globals = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
  const previousMacro = globals.MACRO
  globals.MACRO = { VERSION: 'consumer-fixture' }
  setSessionPersistenceDisabled(!options.persistSession)
  let state = getDefaultAppState()
  let queryMessages: unknown[] = []
  const shared: ReturnType<typeof createAssistantMessage>[] = []
  const engine = new QueryEngine({
    cwd: '/home/dogez/Projects/claudium',
    tools: [], commands: [], mcpClients: [], agents: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    getAppState: () => state,
    setAppState: updater => { state = updater(state) },
    initialMessages: shared,
    readFileCache: new FileStateCache(10, 1024),
    customSystemPrompt: 'Consumer fixture',
    userSpecifiedModel: 'claude-sonnet-4-6',
    thinkingConfig: { type: 'disabled' },
    includePartialMessages,
    queryGenerator: (async function* (params) {
      queryMessages = params.messages
      for (const event of events) {
        options.onQueryEvent?.(event)
        yield event
      }
    }) as QueryEngineConfig['queryGenerator'],
  })
  try {
    const output = []
    let error: unknown
    try {
      for await (const message of engine.submitMessage('fixture')) {
        output.push(message)
        options.onOutput?.(message)
      }
    } catch (caught) {
      if (!options.captureError) throw caught
      error = caught
    }
    return { output, shared, queryMessages, messages: engine.getMessages(), error, usage: engine['totalUsage'] }
  } finally {
    setSessionPersistenceDisabled(previousPersistence)
    if (previousMacro === undefined) delete globals.MACRO
    else globals.MACRO = previousMacro
  }
}

function stream(type: string, extra = {}) {
  return { type: 'stream_event', event: { type, ...extra } }
}
function start(input: number) {
  return stream('message_start', { message: { usage: { input_tokens: input, output_tokens: 0 } } })
}
function delta(output: number, stop_reason: string | null = null) {
  return stream('message_delta', { usage: { output_tokens: output }, delta: { stop_reason } })
}
function reset(ids: string[], recovering = true) {
  return { type: 'stream_reset', requestId: 'request-fixture', reason: 'REASONING_LOOP', withdrawnMessageIds: ids, recovering }
}

describe('QueryEngine stream withdrawal consumer', () => {
  for (const failure of ['tombstone', 'reset', 'none'] as const) {
    for (const stopped of [false, true]) {
      it(`delivers persisted withdrawal reset with ${failure} failure (stopped=${stopped})`, async () => {
        const first = createAssistantMessage({ content: 'withdraw first' })
        const second = createAssistantMessage({ content: 'withdraw second' })
        const resetOnly = createAssistantMessage({ content: 'withdraw at reset' })
        const correction = createUserMessage({ content: 'Correct the response.', isMeta: true })
        const nextRequest = { type: 'stream_request_start' }
        const good = createAssistantMessage({ content: 'Recovered.' })
        good.message.stop_reason = null
        const ids = [first.uuid, second.uuid, resetOnly.uuid]
        const writeError = new Error('withdrawal write failed')
        const record = spyOn(sessionStorage, 'recordTranscript').mockResolvedValue(null)
        const revoke = spyOn(sessionStorage, 'revokeTranscriptMessages').mockImplementation(async uuids => {
          if (failure === 'tombstone' || (failure === 'reset' && uuids.length === ids.length)) {
            throw writeError
          }
        })
        const pulled: unknown[] = []
        let resetObserved = false
        try {
          const result = await runFixture([
            start(11), delta(4, 'end_turn'), first, second, resetOnly,
            ...(stopped ? [stream('message_stop')] : []),
            { type: 'tombstone', message: structuredClone(first) },
            { type: 'tombstone', message: structuredClone(second) },
            reset(ids), stream('message_stop'), correction, nextRequest,
            start(20), delta(7, 'end_turn'), good, stream('message_stop'),
          ], false, {
            persistSession: true,
            captureError: true,
            onQueryEvent: event => { pulled.push(event) },
            onOutput: message => {
              if (message.subtype === 'stream_reset') {
                resetObserved = true
                // The error has not escaped before the SDK receives its reset.
                expect(message.recovering).toBe(failure === 'none')
              }
            },
          })
          expect(resetObserved).toBe(true)
          expect(result.output.filter(m => m.subtype === 'stream_reset')).toHaveLength(1)
          expect(result.output.find(m => m.subtype === 'stream_reset')).toMatchObject({
            withdrawn_message_ids: ids, request_id: 'request-fixture',
          })
          for (const store of [result.shared, result.messages, result.queryMessages]) {
            expect(store.some((m: any) => ids.includes(m.uuid))).toBe(false)
            expect(store.some((m: any) => m.uuid === correction.uuid)).toBe(failure === 'none')
            expect(store.some((m: any) => m.uuid === good.uuid)).toBe(failure === 'none')
          }
          expect(pulled.includes(nextRequest)).toBe(failure === 'none')
          expect(pulled.includes(correction)).toBe(failure === 'none')
          expect(result.usage).toMatchObject({
            input_tokens: failure === 'none' ? 31 : 11,
            output_tokens: failure === 'none' ? 11 : 4,
          })
          if (failure === 'none') {
            expect(result.error).toBeUndefined()
            expect(result.output.at(-1)!.type).toBe('result')
            expect(result.output.at(-1)!.stop_reason).toBe('end_turn')
          } else {
            expect(result.error).toBe(writeError)
            expect(result.output.at(-1)!.subtype).toBe('stream_reset')
            expect((pulled.at(-1) as any).type).toBe('stream_reset')
          }
          expect(revoke.mock.calls).toEqual(failure === 'tombstone'
            ? [[[first.uuid]]]
            : [[[first.uuid]], [[second.uuid]], [ids]])
        } finally {
          revoke.mockRestore()
          record.mockRestore()
        }
      })
    }
  }

  for (const ending of ['end', 'unrelated'] as const) {
    it(`propagates a tombstone write failure without reset (${ending})`, async () => {
      const bad = createAssistantMessage({ content: 'withdraw me' })
      const unrelated = createAssistantMessage({ content: 'must not be processed' })
      // Preserve even non-Error rejection values rather than treating them as no error.
      const writeError = undefined
      const record = spyOn(sessionStorage, 'recordTranscript').mockResolvedValue(null)
      const revoke = spyOn(sessionStorage, 'revokeTranscriptMessages').mockRejectedValue(writeError)
      let caught = false
      try {
        await runFixture([
          bad, { type: 'tombstone', message: structuredClone(bad) },
          ...(ending === 'unrelated' ? [unrelated, reset([bad.uuid])] : []),
        ], false, {
          persistSession: true,
          onOutput: message => {
            expect(message.subtype).not.toBe('stream_reset')
            expect(message.type).not.toBe('result')
            expect(message.uuid).not.toBe(unrelated.uuid)
          },
        })
      } catch (error) {
        caught = true
        expect(error).toBe(writeError)
      } finally {
        revoke.mockRestore()
        record.mockRestore()
      }
      expect(caught).toBe(true)
    })
  }

  it('withdraws cloned tombstones from both stores and emits reset without partial subscription', async () => {
    const bad = createAssistantMessage({ content: 'withdraw me' })
    const good = createAssistantMessage({ content: 'recovered' })
    good.message.stop_reason = null
    const result = await runFixture([
      start(10), delta(3, 'end_turn'), bad,
      { type: 'tombstone', message: structuredClone(bad) }, reset([bad.uuid]),
      stream('message_stop'), reset([bad.uuid]),
      start(20), delta(7, 'end_turn'), good, stream('message_stop'), stream('message_stop'),
    ])
    for (const store of [result.shared, result.messages, result.queryMessages]) {
      expect(store.some((m: any) => m.uuid === bad.uuid)).toBe(false)
      expect(store.some((m: any) => m.uuid === good.uuid)).toBe(true)
      expect(store.some((m: any) => m.type === 'stream_reset')).toBe(false)
    }
    expect(result.output.filter(m => m.type === 'stream_event')).toHaveLength(0)
    expect(result.output.filter(m => m.subtype === 'stream_reset')).toHaveLength(2)
    expect(result.output.find(m => m.subtype === 'stream_reset')).toMatchObject({
      type: 'system', request_id: 'request-fixture', reason: 'REASONING_LOOP',
      withdrawn_message_ids: [bad.uuid], recovering: true,
    })
    const final = result.output.at(-1)!
    expect(final.type).toBe('result')
    expect(final.usage).toMatchObject({ input_tokens: 30, output_tokens: 10 })
    expect(final.stop_reason).toBe('end_turn')
  })

  it('does not count an AntiRep meta correction as a new user or tool turn', async () => {
    const correction = createUserMessage({ content: 'Continue the original task.', isMeta: true })
    const result = await runFixture([reset([]), correction, createAssistantMessage({ content: 'Done.' })])
    expect(result.output.at(-1)!.num_turns).toBe(1)
    expect(result.messages.some((m: any) => m.uuid === correction.uuid && m.isMeta)).toBe(true)
  })

  it('removes a cloned tombstone immediately even without a following reset', async () => {
    const bad = createAssistantMessage({ content: 'withdraw me' })
    const good = createAssistantMessage({ content: 'good' })
    const result = await runFixture([bad, { type: 'tombstone', message: structuredClone(bad) }, good])
    for (const store of [result.shared, result.messages, result.queryMessages]) {
      expect(store.some((m: any) => m.uuid === bad.uuid)).toBe(false)
      expect(store.some((m: any) => m.uuid === good.uuid)).toBe(true)
    }
  })

  it('retains only the observed start snapshot when reset precedes message_delta', async () => {
    const good = createAssistantMessage({ content: 'good' })
    const result = await runFixture([start(13), reset([]), reset([]), stream('message_stop'), good])
    expect(result.output.at(-1)!.usage).toMatchObject({ input_tokens: 13, output_tokens: 0 })
    expect(result.output.filter(m => m.subtype === 'stream_reset')).toHaveLength(2)
  })

  for (const reason of ['REASONING_LOOP', 'TEXT_LOOP'] as const) {
    it(`settles a stopped snapshot once and reports exhausted ${reason}`, async () => {
      const bad = createAssistantMessage({ content: 'withdraw me' })
      const error = createAssistantAPIErrorMessage({
        content: `${reason}: recovery exhausted`,
        apiError: reason as any,
        error: 'unknown' as any,
      })
      const result = await runFixture([
        start(11), delta(4, 'end_turn'), bad, stream('message_stop'),
        { ...reset([bad.uuid], false), reason }, stream('message_stop'), error,
      ], true)
      const final = result.output.at(-1)!
      expect(final.is_error).toBe(true)
      expect(final.stop_reason).toBeNull()
      expect(final.usage).toMatchObject({ input_tokens: 11, output_tokens: 4 })
      expect(result.output.some((m: any) => m.type === 'assistant' && JSON.stringify(m.message).includes(reason))).toBe(true)
    })
  }
})
