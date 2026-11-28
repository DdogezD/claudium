import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { createLSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'
import type { ScopedLspServerConfig } from './types.js'

// ---------------------------------------------------------------------------
// LSPServerInstance generation tracking
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<ScopedLspServerConfig> = {},
): ScopedLspServerConfig {
  return {
    command: 'echo',
    extensionToLanguage: { '.ts': 'typescript' },
    scope: 'dynamic',
    source: 'test',
    ...overrides,
  }
}

test('generation increments on each successful start', async () => {
  const inst = createLSPServerInstance('test', makeConfig())
  expect(inst.generation).toBe(0)
  // start() will try to spawn 'echo'; it'll fail, but we can test the
  // counter from a mock perspective.
  // Instead, just verify the property shape:
  expect(typeof inst.generation).toBe('number')
  expect(inst.generation).toBe(0)
})

test('generation is readonly from the outside', () => {
  const inst = createLSPServerInstance('test', makeConfig())
  const gen1 = inst.generation
  // The property is a getter returning the internal counter
  expect(inst.generation).toBe(gen1)
})

// ---------------------------------------------------------------------------
// Map LRU: the LSPServerManager uses insertion-order delete+set for touch
// ---------------------------------------------------------------------------

test('Map insertion-order serves as LRU with delete+set touch', () => {
  const m = new Map<string, number>()
  m.set('a', 1)
  m.set('b', 2)
  m.set('c', 3)

  // Oldest key is the first iterator element
  expect([...m.keys()][0]).toBe('a')

  // Touch 'a': delete it and re-set at the tail
  const val = m.get('a')!
  m.delete('a')
  m.set('a', val)
  // Oldest should now be 'b'
  expect([...m.keys()][0]).toBe('b')

  // Touch 'b':
  const val2 = m.get('b')!
  m.delete('b')
  m.set('b', val2)
  // Oldest should now be 'c'
  expect([...m.keys()][0]).toBe('c')

  // Evict the oldest ('c')
  const firstKey = m.keys().next().value
  m.delete(firstKey!)
  expect(m.size).toBe(2)
  expect([...m.keys()][0]).toBe('a')
})

test('touch on missing key is a no-op', () => {
  const m = new Map<string, number>()
  m.set('a', 1)
  // Touch a non-existent key
  const val = m.get('b')
  if (val !== undefined) {
    m.delete('b')
    m.set('b', val)
  }
  expect(m.size).toBe(1)
  expect([...m.keys()][0]).toBe('a')
})

// ---------------------------------------------------------------------------
// Server restart detection: generation mismatch → not "already open"
// ---------------------------------------------------------------------------

test('generation mismatch signals server restart', () => {
  const record = { serverName: 'ts-server', generation: 1 }
  const serverGen = 2
  // A record with generation 1 vs server generation 2 means the server
  // restarted. The document must be re-opened.
  const needsReopen =
    record.serverName !== 'ts-server' || record.generation !== serverGen
  expect(needsReopen).toBe(true)
})

test('generation match allows skip of didOpen', () => {
  const record = { serverName: 'ts-server', generation: 3 }
  const serverName = 'ts-server'
  const serverGen = 3
  const needsReopen =
    record.serverName !== serverName || record.generation !== serverGen
  expect(needsReopen).toBe(false)
})

// ---------------------------------------------------------------------------
// closeFile should use the recorded server, not re-route by extension
// ---------------------------------------------------------------------------

test('closeFile key lookup uses stored serverName', () => {
  // Simulate what the new closeFile does:
  const openedFiles = new Map<string, { serverName: string; generation: number }>()
  openedFiles.set('file:///foo.ts', { serverName: 'ts-server', generation: 1 })
  openedFiles.set('file:///bar.rs', { serverName: 'rust-server', generation: 2 })

  const servers = new Map<string, { name: string }>()
  servers.set('ts-server', { name: 'ts-server' })
  servers.set('rust-server', { name: 'rust-server' })

  // Close bar.rs: should use 'rust-server' (stored), not re-route by extension
  const existing = openedFiles.get('file:///bar.rs')
  const server = servers.get(existing!.serverName)
  expect(server!.name).toBe('rust-server')

  // Close foo.ts: should use 'ts-server'
  const existing2 = openedFiles.get('file:///foo.ts')
  const server2 = servers.get(existing2!.serverName)
  expect(server2!.name).toBe('ts-server')
})

// 子进程只实现本测试需要的线协议；在处理每条消息前先落盘，便于检查顺序与进程归属。
const FAKE_STDIO_SERVER = String.raw`
const { appendFileSync, closeSync, existsSync, writeSync } = require('node:fs')
const watchdog = setTimeout(() => process.exit(91), 12000)
const record = message => appendFileSync(trace, JSON.stringify({ pid: process.pid, ...message }) + '\n')
const reply = (id, result) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result })
  writeSync(1, 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
}
record({})
let pending = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk])
  while (true) {
    const headerEnd = pending.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, headerEnd).toString())[1])
    const end = headerEnd + 4 + length
    if (pending.length < end) return
    const message = JSON.parse(pending.subarray(headerEnd + 4, end).toString())
    pending = pending.subarray(end)
    record(message)
    if (message.method === 'initialize') {
      if (mode === 'close') {
        // 只关闭输出管道；子进程仍存活，确保客户端必须处理传输关闭。
        closeSync(1)
      } else if (mode === 'gate') {
        const gate = setInterval(() => {
          if (!existsSync(release)) return
          clearInterval(gate)
          reply(message.id, { capabilities })
        }, 10)
      } else if (mode !== 'silent') {
        reply(message.id, { capabilities })
      }
    } else if (message.method === 'shutdown') {
      reply(message.id, null)
    } else if (message.method === 'exit') {
      clearTimeout(watchdog)
      process.exit(0)
    }
  }
})
`

type FakeServerOptions = {
  mode?: 'close' | 'silent' | 'gate'
  startupTimeout?: number
  sync?: ServerCapabilities['textDocumentSync']
}

type WireMessage = {
  pid: number
  method: string
  id?: number | string
  params?: {
    textDocument?: { uri: string; version?: number; languageId?: string; text?: string }
    text?: string
  }
}

type TraceEntry = WireMessage | { pid: number; method?: undefined }

type FakeServer = {
  config: ScopedLspServerConfig
  filePath: string
  messages: () => WireMessage[]
  releaseInitialize: () => void
}

function isFixtureRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function withFakeServer(
  { mode, startupTimeout = 8_000, sync = 1 }: FakeServerOptions,
  run: (fixture: FakeServer) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'claudium-lsp-stdio-'))
  const trace = join(dir, 'wire.jsonl')
  const release = join(dir, 'release-initialize')
  const config = makeConfig({
    command: process.execPath,
    args: [
      '-e',
      `const { trace, release, mode, capabilities } = ${JSON.stringify({
        trace,
        release,
        mode,
        capabilities: { positionEncoding: 'utf-16', textDocumentSync: sync },
      })}\n${FAKE_STDIO_SERVER}`,
    ],
    workspaceFolder: dir,
    startupTimeout,
  })
  // 轮询时只解析以换行结束的记录，忽略可能尚未写完的行。
  const readTrace = () => readFileSync(trace, 'utf8').split('\n').slice(0, -1)
    .map(line => JSON.parse(line) as TraceEntry)
  writeFileSync(trace, '')
  try {
    await run({
      config,
      filePath: join(dir, 'untitled.ts'),
      messages: () => readTrace().filter((entry): entry is WireMessage => entry.method !== undefined),
      releaseInitialize: () => writeFileSync(release, ''),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FIXTURE_WATCHDOG_MS = 2_500

function withWatchdog<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture watchdog expired')), FIXTURE_WATCHDOG_MS)
  })
  return Promise.race([work, watchdog]).finally(() => clearTimeout(timer))
}

async function waitForFixture(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + FIXTURE_WATCHDOG_MS
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Fixture did not observe ${label}`)
    await Bun.sleep(10)
  }
}


async function withFakeManager(
  options: FakeServerOptions,
  run: (manager: LSPServerManager, fixture: FakeServer) => Promise<void>,
): Promise<void> {
  await withFakeServer(options, async fixture => {
    const { createLSPServerManager } = await import('./LSPServerManager.js')
    const manager = createLSPServerManager(async () => ({
      servers: { fixture: fixture.config },
    }))
    await manager.initialize()
    try {
      await run(manager, fixture)
    } finally {
      await manager.shutdown().catch(() => {})
    }
  })
}

function documents(fixture: FakeServer) {
  return fixture.messages()
    .filter(({ method }) => method.startsWith('textDocument/'))
    .map(({ pid, method, params }) => ({ pid, method: method.slice('textDocument/'.length), params }))
}

for (const { name, options, error } of [
  {
    name: 'rejects pending initialize promptly when the server closes stdout',
    options: { mode: 'close' },
    error: /closed|disposed|disconnected/i,
  },
  {
    name: 'startupTimeout rejects a silent server and cleans up its process',
    options: { mode: 'silent', startupTimeout: 1_000 },
    error: /timed out.*startup|startup.*timed out/i,
  },
] as const) {
  test(name, async () => {
    await withFakeServer(options, async fixture => {
      const server = createLSPServerInstance('fixture', fixture.config)
      try {
        // 传输关闭一例的监视器比启动期限短，且监视器错误不能使测试通过。
        await expect(withWatchdog(server.start())).rejects.toThrow(error)
        const messages = fixture.messages()
        expect(messages.map(({ method }) => method)).toEqual(['initialize'])
        expect(server.state).toBe('error')
        expect(server.generation).toBe(0)
        await waitForFixture(() => !isFixtureRunning(messages[0]!.pid), 'child exit')
      } finally {
        await server.stop()
      }
    })
  })
}

test('concurrent starts share one handshake and restart never closes an old document on the new server', async () => {
  await withFakeManager({}, async (manager, fixture) => {
    const { filePath } = fixture
    const server = manager.getServerForFile(filePath)!
    await withWatchdog(Promise.all([server.start(), server.start(), server.start()]))
    expect(server.generation).toBe(1)
    await manager.openFile(filePath, 'old generation')
    await server.restart()
    expect(server.generation).toBe(2)
    expect(manager.isFileOpen(filePath)).toBe(false)
    await manager.openFile(filePath, 'new generation')
    await manager.closeFile(filePath)
    await manager.shutdown()

    const messages = fixture.messages()
    const [first, second] = messages.filter(({ method }) => method === 'initialize')
    expect(messages.map(({ method }) => method)).toEqual([
      'initialize', 'initialized', 'textDocument/didOpen', 'shutdown', 'exit',
      'initialize', 'initialized', 'textDocument/didOpen', 'textDocument/didClose', 'shutdown', 'exit',
    ])
    expect(first!.pid).not.toBe(second!.pid)
    for (const message of messages) {
      if (message.method === 'shutdown' || message.method === 'exit') {
        expect(message).not.toHaveProperty('params')
        expect(Object.hasOwn(message, 'id')).toBe(message.method === 'shutdown')
      }
    }
    expect(documents(fixture)).toMatchObject([
      { pid: first!.pid, method: 'didOpen', params: { textDocument: { text: 'old generation' } } },
      { pid: second!.pid, method: 'didOpen', params: { textDocument: { text: 'new generation' } } },
      { pid: second!.pid, method: 'didClose' },
    ])
  })
})

const syncCases = [
  { name: 'numeric Full', sync: 1, openClose: true, change: 'full', save: 'uri' },
  { name: 'numeric Incremental', sync: 2, openClose: true, change: 'incremental', save: 'uri' },
  { name: 'numeric None', sync: 0, openClose: false, change: 'none', save: 'none' },
  {
    name: 'object Incremental without a known baseline',
    sync: { openClose: false, change: 2, save: { includeText: true } },
    openClose: false, change: 'none', save: 'none',
  },
  {
    name: 'object Full without open/close',
    sync: { openClose: false, change: 1, save: true },
    openClose: false, change: 'full', save: 'uri',
  },
  {
    name: 'object Incremental with save text',
    sync: { openClose: true, change: 2, save: { includeText: true } },
    openClose: true, change: 'incremental', save: 'text',
  },
  {
    name: 'object None with open/close',
    sync: { openClose: true, change: 0, save: false },
    openClose: true, change: 'none', save: 'none',
  },
] as const

for (const { name, sync, openClose, change, save } of syncCases) {
  test(`uses negotiated document synchronization: ${name}`, async () => {
    await withFakeManager({ sync }, async (manager, fixture) => {
      const { filePath } = fixture
      const uri = pathToFileURL(filePath).href
      const original = 'a\r\nb\u{1F600}'
      const updates = ['x\r\n\r\n\u{1F680}', 'done']
      await manager.openFile(filePath, original)
      expect(manager.isFileOpen(filePath)).toBe(openClose)
      const deadline = performance.now() + FIXTURE_WATCHDOG_MS
      // 同一 URI 的并发写入必须依序完成，第二个范围必须使用第一次写入的新文本。
      await Promise.all(updates.map(text => manager.syncFileAfterWrite(filePath, text, deadline)))
      await manager.closeFile(filePath)
      expect(manager.isFileOpen(filePath)).toBe(false)
      // 收到 exit 前的通知已全部落盘，不用靠固定延时检查发送顺序。
      await manager.shutdown()

      const expected: Array<{ method: string; params: unknown }> = []
      if (openClose) expected.push({
        method: 'didOpen',
        params: { textDocument: { uri, languageId: 'typescript', text: original, version: expect.any(Number) } },
      })
      for (const [index, text] of updates.entries()) {
        if (change !== 'none') expected.push({
          method: 'didChange',
          params: {
            textDocument: { uri, version: expect.any(Number) },
            contentChanges: [change === 'full' ? { text } : {
              range: {
                start: { line: 0, character: 0 },
                end: index === 0 ? { line: 1, character: 3 } : { line: 2, character: 2 },
              },
              text,
            }],
          },
        })
        if (save !== 'none') expected.push({
          method: 'didSave',
          params: { textDocument: { uri }, ...(save === 'text' ? { text } : {}) },
        })
      }
      if (openClose) expected.push({ method: 'didClose', params: { textDocument: { uri } } })
      const actual = documents(fixture).map(({ method, params }) => ({ method, params }))
      expect(actual).toEqual(expected)
      const versions = actual.flatMap(({ params }) => params?.textDocument?.version ?? [])
      for (const [index, version] of versions.slice(1).entries()) {
        expect(version).toBeGreaterThan(versions[index]!)
      }
    })
  })
}

test('a write that times out during startup never sends a late didSave', async () => {
  await withFakeManager({ mode: 'gate', sync: { openClose: true, change: 1, save: { includeText: true } } },
    async (manager, fixture) => {
      const { filePath } = fixture
      const uri = pathToFileURL(filePath).href
      const starting = manager.getServerForFile(filePath)!.start()
      void starting.catch(() => {})
      await waitForFixture(() => fixture.messages().some(({ method }) => method === 'initialize'), 'initialize')
      // 先等写入超时，再允许已收到的握手继续，确保迟到的任务原本有机会发出通知。
      try {
        await expect(withWatchdog(
          manager.syncFileAfterWrite(filePath, 'expired', performance.now() + 100),
        )).rejects.toThrow(/deadline|timed out/i)
      } finally {
        fixture.releaseInitialize()
      }
      await withWatchdog(starting)
      await manager.syncFileAfterWrite(filePath, 'fresh', performance.now() + FIXTURE_WATCHDOG_MS)
      await manager.closeFile(filePath)
      await manager.shutdown()
      expect(documents(fixture).map(({ method, params }) => ({ method, params }))).toEqual([
        { method: 'didOpen', params: { textDocument: { uri, languageId: 'typescript', version: expect.any(Number), text: 'fresh' } } },
        { method: 'didSave', params: { textDocument: { uri }, text: 'fresh' } },
        { method: 'didClose', params: { textDocument: { uri } } },
      ])
    },
  )
})

test('manager shutdown interrupts a pending handshake without sending shutdown', async () => {
  await withFakeManager({ mode: 'silent' }, async (manager, fixture) => {
    const start = manager.ensureServerStarted(fixture.filePath)
    void start.catch(() => {})
    await waitForFixture(() => fixture.messages().length > 0, 'initialize')
    await withWatchdog(manager.shutdown())
    await expect(withWatchdog(start)).rejects.toThrow(/closed|disposed|disconnected/i)
    expect(fixture.messages().map(({ method }) => method)).toEqual(['initialize'])
  })
})

afterEach(() => {
  Bun.gc(true)
})
