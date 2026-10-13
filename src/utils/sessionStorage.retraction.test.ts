import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import type { SessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getAgentTranscriptPath,
  getTranscriptPath,
  loadTranscriptFile,
  recordTranscript,
  resetProjectFlushStateForTesting,
  resetProjectForTesting,
  revokeTranscriptMessages,
  setSessionFileForTesting,
} from './sessionStorage.js'

const originalSession = getSessionId()
const originalProjectDir = getSessionProjectDir()
const originalDisabled = isSessionPersistenceDisabled()
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
let dir: string
let path: string

function message(type: 'user' | 'assistant', text: string): Message {
  return {
    type,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: type,
      content: type === 'assistant'
        ? [{ type: 'thinking', thinking: text, signature: 'test-signature' }]
        : text,
    },
  } as Message
}

function entry(m: Message, parentUuid: string | null) {
  return { parentUuid, isSidechain: false, ...m, sessionId: getSessionId() }
}

async function writeEntries(entries: unknown[]) {
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claudium-retraction-'))
  switchSession(randomUUID() as SessionId, dir)
  setSessionPersistenceDisabled(false)
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  resetProjectForTesting()
  clearSessionMessagesCache()
  path = getTranscriptPath()
  setSessionFileForTesting(path)
})

afterEach(async () => {
  await flushSessionStorage()
  resetProjectFlushStateForTesting()
  resetProjectForTesting()
  clearSessionMessagesCache()
  switchSession(originalSession, originalProjectDir)
  setSessionPersistenceDisabled(originalDisabled)
  if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  await rm(dir, { recursive: true, force: true })
})

describe('persisted transcript retraction', () => {
  it('pending write → revoke → late stale write → reload excludes bad thinking and repairs parent', async () => {
    const user = message('user', 'task')
    const bad = message('assistant', 'bad thinking repetition')
    const good = message('assistant', 'normal thinking')
    await recordTranscript([user, bad])
    await revokeTranscriptMessages([bad.uuid])
    expect(await recordTranscript([user, bad, good])).toBe(good.uuid)
    await flushSessionStorage()
    const raw = await readFile(path, 'utf8')
    const lines = raw.trim().split('\n').map(line => JSON.parse(line))
    expect(lines.findIndex(e => e.uuid === bad.uuid)).toBeLessThan(
      lines.findIndex(e => e.type === 'message_retraction'),
    )
    expect(lines.filter(e => e.uuid === bad.uuid)).toHaveLength(1)
    resetProjectForTesting()
    clearSessionMessagesCache()
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid, good.uuid])
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBe(user.uuid)
    expect(JSON.stringify([...loaded.messages.values()])).not.toContain('bad thinking')
    expect([...loaded.leafUuids]).toEqual([good.uuid])
  })

  it('retraction before recordTranscript completes prevents stale asynchronous snapshots from being queued', async () => {
    const user = message('user', 'task')
    const bad = message('assistant', 'unqueued bad thinking')
    const pending = recordTranscript([user, bad])
    const retraction = revokeTranscriptMessages([bad.uuid])
    expect(await pending).toBe(user.uuid)
    await retraction
    await flushSessionStorage()
    expect(await readFile(path, 'utf8')).not.toContain('unqueued bad thinking')
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid])
  })

  it('filters duplicate UUIDs before and after retraction and bridges consecutive retracted nodes to a valid ancestor', async () => {
    const user = message('user', 'task')
    const bad1 = message('assistant', 'bad1')
    const bad2 = message('assistant', 'bad2')
    const good = message('assistant', 'normal')
    await writeEntries([
      entry(user, null), entry(bad1, user.uuid), entry(bad2, bad1.uuid),
      { type: 'message_retraction', uuids: [bad1.uuid, bad2.uuid] },
      entry(bad1, user.uuid), entry(bad2, bad1.uuid), entry(good, bad2.uuid),
    ])
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid, good.uuid])
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBe(user.uuid)
    await recordTranscript([user, bad1, bad2, good])
    await flushSessionStorage()
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(7)
  })

  it('repeated and concurrent retractions are idempotent and stale incremental parent hints do not truncate the new chain', async () => {
    const user = message('user', 'task')
    const bad = message('assistant', 'bad')
    const good = message('assistant', 'normal')
    await recordTranscript([user, bad])
    await Promise.all([
      revokeTranscriptMessages([bad.uuid, bad.uuid]),
      revokeTranscriptMessages([bad.uuid]),
      flushSessionStorage(),
    ])
    await revokeTranscriptMessages([bad.uuid])
    await recordTranscript([good], undefined, bad.uuid as UUID)
    await flushSessionStorage()
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid, good.uuid])
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBe(user.uuid)
  })

  it('remains compatible with legacy transcripts without retractions and progress bridging', async () => {
    const user = message('user', 'old task')
    const good = message('assistant', 'old thinking')
    const progress = randomUUID()
    await writeEntries([
      entry(user, null),
      { type: 'progress', uuid: progress, parentUuid: user.uuid },
      entry(good, progress),
      { type: 'custom-title', sessionId: getSessionId(), customTitle: 'old title' },
    ])
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid, good.uuid])
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBe(user.uuid)
    expect(loaded.customTitles.get(getSessionId() as UUID)).toBe('old title')
  })

  it('preserves other valid branches after retracting the latest leaf in a large file', async () => {
    const user = message('user', 'task')
    const good = message('assistant', 'normal')
    const bad = message('assistant', 'bad'.repeat(3 * 1024 * 1024))
    await writeEntries([
      entry(user, null), entry(good, user.uuid), entry(bad, user.uuid),
      { type: 'message_retraction', uuids: [bad.uuid] },
    ])
    const loaded = await loadTranscriptFile(path)
    expect([...loaded.messages.keys()]).toEqual([user.uuid, good.uuid])
    expect([...loaded.leafUuids]).toEqual([good.uuid])
  })

  it('pre-compaction retractions remain effective during metadata scanning in large files', async () => {
    const bad = message('assistant', 'old bad thinking')
    const good = message('assistant', 'normal')
    const boundary = {
      type: 'system', subtype: 'compact_boundary', uuid: randomUUID(),
      timestamp: new Date().toISOString(), parentUuid: null,
    }
    await writeEntries([
      { type: 'message_retraction', uuids: [bad.uuid] },
      entry(message('user', 'padding'.repeat(2 * 1024 * 1024)), null),
      boundary, entry(bad, boundary.uuid), entry(good, bad.uuid),
    ])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.messages.has(bad.uuid as UUID)).toBe(false)
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBe(boundary.uuid)
  })

  it('rejects persistence failures and allows retries after repairing the path without losing in-memory retractions', async () => {
    const bad = message('assistant', 'must not reappear')
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'block')
    setSessionFileForTesting(join(blocker, 'session.jsonl'))
    await expect(revokeTranscriptMessages([bad.uuid])).rejects.toBeDefined()
    setSessionFileForTesting(path)
    await recordTranscript([bad])
    await revokeTranscriptMessages([bad.uuid])
    expect(await readFile(path, 'utf8')).not.toContain('must not reappear')
    expect((await loadTranscriptFile(path)).messages.size).toBe(0)
  })

  it('writes sidechain retractions to the agent transcript, not the main transcript', async () => {
    const bad = message('assistant', 'sidechain bad')
    await recordTranscript([bad])
    await revokeTranscriptMessages([bad.uuid], 'agent-test')
    await flushSessionStorage()
    const sidechainPath = getAgentTranscriptPath('agent-test' as any)
    expect((await readFile(sidechainPath, 'utf8')).toString()).toContain('message_retraction')
    expect((await readFile(path, 'utf8')).toString()).not.toContain('message_retraction')
  })

  it('empty retractions do not create files and disabled persistence keeps retractions only in memory', async () => {
    await revokeTranscriptMessages([])
    await expect(readFile(path)).rejects.toBeDefined()
    setSessionPersistenceDisabled(true)
    const bad = message('assistant', 'bad')
    await revokeTranscriptMessages([bad.uuid])
    expect(await recordTranscript([bad])).toBeNull()
    await expect(readFile(path)).rejects.toBeDefined()
  })

  it('cycles or missing retracted ancestors do not hang the loader', async () => {
    const bad = message('assistant', 'cycle')
    const good = message('assistant', 'normal')
    await writeEntries([
      entry(bad, bad.uuid), entry(good, bad.uuid),
      { type: 'message_retraction', uuids: [bad.uuid] },
    ])
    const loaded = await loadTranscriptFile(path)
    expect(loaded.messages.get(good.uuid as UUID)?.parentUuid).toBeNull()
    await appendFile(path, JSON.stringify({ type: 'message_retraction', uuids: [good.uuid] }) + '\n')
    expect((await loadTranscriptFile(path)).messages.size).toBe(0)
  })
})
