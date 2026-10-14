import { describe, expect, it } from 'bun:test'
import { handleMessageFromStream, createAssistantMessage, type StreamingThinking, type StreamingToolUse } from './messages.js'
import type { StreamResetEvent } from '../query.js'
import { SDKMessageSchema, SDKStreamResetMessageSchema } from '../entrypoints/sdk/coreSchemas.js'
import type { SDKStreamResetMessage } from '../entrypoints/agentSdkTypes.js'
import { createStreamlinedTransformer, shouldIncludeInStreamlined } from './streamlinedTransform.js'

const reset: StreamResetEvent = {
  type: 'stream_reset', requestId: undefined, reason: 'REASONING_LOOP',
  withdrawnMessageIds: ['bad-uuid'], recovering: true,
}
const sdkReset: SDKStreamResetMessage = {
  type: 'system', subtype: 'stream_reset', reason: 'REASONING_LOOP',
  withdrawn_message_ids: ['bad-uuid'], recovering: true,
  session_id: 'session', uuid: 'reset-uuid',
}

describe('stream reset consumers', () => {
  for (const recovering of [true, false]) {
    it(`clears partial display and length without adding history (recovering=${recovering})`, () => {
      let thinking: StreamingThinking | null = { thinking: 'bad', isStreaming: true }
      let text: string | null = 'partial'
      let tools: StreamingToolUse[] = [{ index: 0, contentBlock: {} as any, unparsedToolInput: '{' }]
      let length = 123
      let mode = 'thinking'
      let historyCount = 0
      let metricCount = 0
      handleMessageFromStream({ ...reset, recovering },
        () => historyCount++, () => { throw new Error('reset is not a delta') },
        value => { mode = value }, updater => { tools = updater(tools) },
        () => { throw new Error('reset is not a tombstone') },
        updater => { thinking = updater(thinking) }, () => metricCount++,
        updater => { text = updater(text) }, () => { length = 0 },
      )
      expect(thinking).toBeNull()
      expect(text).toBeNull()
      expect(tools).toEqual([])
      expect(length).toBe(0)
      expect(mode).toBe(recovering ? 'requesting' : 'responding')
      expect(historyCount).toBe(0)
      expect(metricCount).toBe(0)
    })
  }

  it('allows a tombstone consumer to remove a cloned message by UUID', () => {
    const message = createAssistantMessage({ content: 'withdraw' })
    let history = [message]
    handleMessageFromStream({ type: 'tombstone', message: structuredClone(message) },
      () => { throw new Error('tombstone must not append') }, () => {}, () => {}, () => {},
      withdrawn => { history = history.filter(m => m.uuid !== withdrawn.uuid) },
    )
    expect(history).toEqual([])
  })

  it('validates the reasoning reset in the SDK union with optional request correlation', () => {
    expect(SDKMessageSchema().parse(sdkReset)).toEqual(sdkReset)
    expect(SDKStreamResetMessageSchema().parse({ ...sdkReset, request_id: 'request' }).request_id).toBe('request')
    expect(SDKStreamResetMessageSchema().safeParse({ ...sdkReset, reason: 'TEXT_LOOP' }).success).toBe(false)
    expect(SDKStreamResetMessageSchema().safeParse({ ...sdkReset, reason: 'OTHER' }).success).toBe(false)
  })

  it('preserves reset and withdrawal UUIDs in streamlined output', () => {
    const transform = createStreamlinedTransformer()
    expect(shouldIncludeInStreamlined(sdkReset)).toBe(true)
    expect(transform(sdkReset)).toBe(sdkReset)
    expect(transform({ type: 'assistant', session_id: 'session', uuid: 'recovered', message: { content: [{ type: 'text', text: 'good' }] } } as any)).toMatchObject({ type: 'streamlined_text', text: 'good', uuid: 'recovered' })
  })
})
