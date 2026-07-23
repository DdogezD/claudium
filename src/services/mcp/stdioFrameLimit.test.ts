import { afterEach, expect, test } from 'bun:test'
import { ReadBuffer } from '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js'

function makeChunk(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

// Valid JSON-RPC 2.0 result message for parsing tests
const VALID_MESSAGE = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n'
// Valid JSON-RPC request
const VALID_REQUEST = '{"jsonrpc":"2.0","id":2,"method":"test","params":{}}\n'

afterEach(() => {
  Bun.gc(true)
})

test('parses a complete single-frame message', () => {
  const buf = new ReadBuffer()
  buf.append(makeChunk(VALID_MESSAGE))
  const msg = buf.readMessage()
  expect(msg).not.toBeNull()
  expect(buf.readMessage()).toBeNull()
})

test('returns null when no newline is present yet', () => {
  const buf = new ReadBuffer()
  buf.append(makeChunk('{"jsonrpc":"2.0","id":1,"result":{"partial":'))
  expect(buf.readMessage()).toBeNull()
})

test('assembles a frame across multiple chunks', () => {
  const buf = new ReadBuffer()
  buf.append(makeChunk('{"jsonrpc":"2.0",'))
  expect(buf.readMessage()).toBeNull()
  buf.append(makeChunk('"id":1,"result":{}}\n'))
  const msg = buf.readMessage()
  expect(msg).not.toBeNull()
  expect(buf.readMessage()).toBeNull()
})

test('handles CRLF lines', () => {
  const buf = new ReadBuffer()
  buf.append(makeChunk('{"jsonrpc":"2.0","id":1,"result":{}}\r\n'))
  const msg = buf.readMessage()
  expect(msg).not.toBeNull()
  expect(buf.readMessage()).toBeNull()
})

test('handles multiple messages in a single chunk', () => {
  const buf = new ReadBuffer()
  buf.append(makeChunk(VALID_MESSAGE + VALID_REQUEST))
  const m1 = buf.readMessage()
  const m2 = buf.readMessage()
  expect(m1).not.toBeNull()
  expect(m2).not.toBeNull()
  expect(buf.readMessage()).toBeNull()
})

test('rejects an oversized single frame without newlines', () => {
  const buf = new ReadBuffer()
  const MB64 = 64 * 1024 * 1024
  const filler = Buffer.alloc(MB64 + 1, 'x')
  expect(() => buf.append(filler)).toThrow()
  // Buffer must be cleared after error
  expect(buf.readMessage()).toBeNull()
})

test('accepts a frame exactly at the 64 MiB boundary (append only)', () => {
  // Verify the boundary check passes.  We test append only (no parse)
  // because JSON.parse of a 64 MiB buffer would be prohibitively slow.
  const buf = new ReadBuffer()
  const MB64 = 64 * 1024 * 1024
  const prefix = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"x":"')
  const suffix = Buffer.from('"}}\n')
  const padLen = MB64 - prefix.byteLength - suffix.byteLength
  const padding = Buffer.alloc(padLen, 'y')
  const frame = Buffer.concat([prefix, padding, suffix])
  expect(frame.byteLength).toBe(MB64)
  // Must not throw
  buf.append(frame)
  // Clean up large buffer held by ReadBuffer
  buf.clear()
})

test('rejects an oversized completed frame with trailing newline', () => {
  const buf = new ReadBuffer()
  const MB64 = 64 * 1024 * 1024
  // + 2: one extra byte in payload + one byte for the newline itself
  const payload = Buffer.alloc(MB64 + 1, 'x')
  const chunk = Buffer.concat([payload, makeChunk('\n')])
  expect(() => buf.append(chunk)).toThrow()
  expect(buf.readMessage()).toBeNull()
})

test('clears buffer and does not parse suffix after oversized frame', () => {
  const buf = new ReadBuffer()
  const MB64 = 64 * 1024 * 1024
  const oversized = Buffer.alloc(MB64 + 2, 'x')
  expect(() => buf.append(oversized)).toThrow()
  // After error the buffer is cleared; even a valid subsequent chunk
  // would have lost the oversized prefix
  expect(buf.readMessage()).toBeNull()
  // A fresh valid message can still be appended afterwards
  buf.append(makeChunk(VALID_MESSAGE))
  expect(buf.readMessage()).not.toBeNull()
})

test('rejects an oversized frame that spans multiple chunks', () => {
  const buf = new ReadBuffer()
  const HALF = 32 * 1024 * 1024 + 1
  const first = Buffer.alloc(HALF, 'x')
  const second = Buffer.alloc(HALF, 'x')
  buf.append(first)
  expect(buf.readMessage()).toBeNull()
  expect(() => buf.append(second)).toThrow()
})

test('does not confuse multiple small messages for a single large one', () => {
  const buf = new ReadBuffer()
  // 500 messages, each 2KB with newline — must not be treated as oversized
  const line = Buffer.alloc(2047, 'y')
  const frame = Buffer.concat([makeChunk('{"jsonrpc":"2.0","id":1,"result":{"data":"'), line, makeChunk('"}}\n')])
  for (let i = 0; i < 500; i++) {
    buf.append(frame)
  }
  let count = 0
  while (buf.readMessage() !== null) {
    count++
  }
  expect(count).toBe(500)
})

test('oversized frame error carries FRAME_TOO_LARGE code', () => {
  const buf = new ReadBuffer()
  const MB64 = 64 * 1024 * 1024
  const oversized = Buffer.alloc(MB64 + 2, 'x')
  try {
    buf.append(oversized)
    expect(true).toBe(false)
  } catch (e: any) {
    expect(e.code).toBe('FRAME_TOO_LARGE')
  }
})

test('normal malformed JSON still reports via existing onerror path', () => {
  // The ReadBuffer itself will throw on malformed JSON during readMessage,
  // which is the existing SDK behavior (unchanged by the patch).
  const buf = new ReadBuffer()
  buf.append(makeChunk('not-valid-json\n'))
  expect(() => buf.readMessage()).toThrow()
})
