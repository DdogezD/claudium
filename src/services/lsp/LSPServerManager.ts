import { readFile } from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type {
  Position,
  ServerCapabilities,
  TextDocumentContentChangeEvent,
  TextDocumentSyncKind,
} from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAllLspServers } from './config.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from './LSPServerInstance.js'
import type { ScopedLspServerConfig } from './types.js'
/**
 * LSP Server Manager interface returned by createLSPServerManager.
 * Manages multiple LSP server instances and routes requests based on file extensions.
 */
export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers */
  initialize(): Promise<void>
  /** Shutdown all running servers and clear state */
  shutdown(): Promise<void>
  /** Get the LSP server instance for a given file path */
  getServerForFile(filePath: string): LSPServerInstance | undefined
  /** Ensure the appropriate LSP server is started for the given file */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  /** Send a request to the appropriate LSP server for the given file */
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  /** Get all running server instances */
  getAllServers(): Map<string, LSPServerInstance>
  /** Synchronize file open to LSP server (sends didOpen notification) */
  openFile(filePath: string, content: string): Promise<void>
  /** Synchronize file change to LSP server (sends didChange notification) */
  changeFile(filePath: string, content: string): Promise<void>
  /** Synchronize file save to LSP server (sends didSave notification) */
  saveFile(filePath: string): Promise<void>
  /** 将已写盘的文本同步并保存为同一文档事务；deadline 使用 performance.now() 时钟。 */
  syncFileAfterWrite(
    filePath: string,
    content: string,
    deadline: number,
  ): Promise<void>
  /** Synchronize file close to LSP server (sends didClose notification) */
  closeFile(filePath: string): Promise<void>
  /** Check if a file is already open on a compatible LSP server */
  isFileOpen(filePath: string): boolean
}

type DocumentConnection = {
  server: LSPServerInstance
  generation: number
}

// 整文替换只需要旧文本的 EOF，不必在 LRU 里保留全文。
type OpenedDocument = DocumentConnection & { end: Position | undefined }

// 只用协议的类型导入，避免在加载 manager 时提前加载 LSP 客户端依赖。
const SYNC_NONE = 0
const SYNC_FULL = 1
const SYNC_INCREMENTAL = 2

function documentSync(sync: ServerCapabilities['textDocumentSync']): {
  openClose: boolean
  change: TextDocumentSyncKind
  save: false | { includeText?: boolean }
} {
  const kind = typeof sync === 'number' ? sync : sync?.change
  const change =
    kind === SYNC_FULL || kind === SYNC_INCREMENTAL ? kind : SYNC_NONE
  if (typeof sync === 'number') {
    // 兼容 Microsoft 客户端对旧式数字声明的默认行为。
    const enabled = change !== SYNC_NONE
    return { openClose: enabled, change, save: enabled ? {} : false }
  }
  return {
    openClose: sync?.openClose === true,
    change,
    save: sync?.save === true ? {} : sync?.save || false,
  }
}

function utf16End(text: string): Position {
  let line = 0
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code !== 13 && code !== 10) continue
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++
    line++
    lineStart = i + 1
  }
  // JS 下标以 UTF-16 码元计数；CRLF 合作一处换行。
  return { line, character: text.length - lineStart }
}

function documentDeadlineError(): Error {
  return new Error('LSP document synchronization deadline exceeded')
}

function checkDocumentDeadline(deadline?: number): void {
  if (deadline !== undefined && performance.now() >= deadline) {
    throw documentDeadlineError()
  }
}

/**
 * Creates an LSP server manager instance.
 *
 * Manages multiple LSP server instances and routes requests based on file extensions.
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 *
 * @returns LSP server manager instance
 *
 * @example
 * const manager = createLSPServerManager()
 * await manager.initialize()
 * const result = await manager.sendRequest('/path/to/file.ts', 'textDocument/definition', params)
 * await manager.shutdown()
 */
export function createLSPServerManager(
  loadServers = getAllLspServers,
): LSPServerManager {
  // Maximum number of files that may be simultaneously tracked as "open" on
  // language servers.  When exceeded the least-recently-used file is evicted
  // (didClose sent to its server) before the new file is opened.
  const MAX_OPEN_FILES = 50

  // Private state managed via closures
  const servers: Map<string, LSPServerInstance> = new Map()
  const extensionMap: Map<string, string[]> = new Map()
  // 只记录实际发过 didOpen 的文档；Map 首项是最久未用的记录。
  const openedFiles = new Map<string, OpenedDocument>()
  const documentTails = new Map<string, Promise<void>>()
  let documentQueue = Promise.resolve()
  // 全局单调版本也覆盖不发 didOpen 的 Full 同步，无需为它另建无界缓存。
  let documentVersion = 0

  /**
   * Initialize the manager by loading all configured LSP servers.
   *
   * @throws {Error} If configuration loading fails
   */
  async function initialize(): Promise<void> {
    let serverConfigs: Record<string, ScopedLspServerConfig>

    try {
      const result = await loadServers()
      serverConfigs = result.servers
      logForDebugging(
        `[LSP SERVER MANAGER] getAllLspServers returned ${Object.keys(serverConfigs).length} server(s)`,
      )
    } catch (error) {
      const err = error as Error
      logError(
        new Error(`Failed to load LSP server configuration: ${err.message}`),
      )
      throw error
    }

    // Build extension → server mapping
    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        // Validate config before using it
        if (!config.command) {
          throw new Error(
            `Server ${serverName} missing required 'command' field`,
          )
        }
        if (
          !config.extensionToLanguage ||
          Object.keys(config.extensionToLanguage).length === 0
        ) {
          throw new Error(
            `Server ${serverName} missing required 'extensionToLanguage' field`,
          )
        }

        // Map file extensions to this server (derive from extensionToLanguage)
        const fileExtensions = Object.keys(config.extensionToLanguage)
        for (const ext of fileExtensions) {
          const normalized = ext.toLowerCase()
          if (!extensionMap.has(normalized)) {
            extensionMap.set(normalized, [])
          }
          const serverList = extensionMap.get(normalized)
          if (serverList) {
            serverList.push(serverName)
          }
        }

        // Create server instance
        const instance = createLSPServerInstance(serverName, config)
        servers.set(serverName, instance)

        // Register handler for workspace/configuration requests from the server
        // Some servers (like TypeScript) send these even when we say we don't support them
        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) => {
            logForDebugging(
              `LSP: Received workspace/configuration request from ${serverName}`,
            )
            // Return empty/null config for each requested item
            // This satisfies the protocol without providing actual configuration
            return params.items.map(() => null)
          },
        )
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to initialize LSP server ${serverName}: ${err.message}`,
          ),
        )
        // Continue with other servers - don't fail entire initialization
      }
    }

    logForDebugging(`LSP manager initialized with ${servers.size} servers`)
  }

  /**
   * 关闭服务并清理状态，包括仍在等待握手的子进程。
   *
   * @throws {Error} If one or more servers fail to stop
   */
  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([, server]) => server.state !== 'stopped',
    )

    const results = await Promise.allSettled(
      toStop.map(([, server]) => server.stop()),
    )

    servers.clear()
    extensionMap.clear()
    openedFiles.clear()

    const errors = results
      .map((r, i) =>
        r.status === 'rejected'
          ? `${toStop[i]![0]}: ${errorMessage(r.reason)}`
          : null,
      )
      .filter((e): e is string => e !== null)

    if (errors.length > 0) {
      const err = new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors.join('; ')}`,
      )
      logError(err)
      throw err
    }
  }

  /**
   * Get the LSP server instance for a given file path.
   * If multiple servers handle the same extension, returns the first registered server.
   * Returns undefined if no server handles this file type.
   */
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = path.extname(filePath).toLowerCase()
    const serverNames = extensionMap.get(ext)

    if (!serverNames || serverNames.length === 0) {
      return undefined
    }

    // Use first server (can add priority later)
    const serverName = serverNames[0]
    if (!serverName) {
      return undefined
    }

    return servers.get(serverName)
  }

  /**
   * Ensure the appropriate LSP server is started for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start
   */
  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (!server) return undefined

    if (
      server.state === 'stopped' ||
      server.state === 'error' ||
      server.state === 'starting'
    ) {
      try {
        await server.start()
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to start LSP server for file ${filePath}: ${err.message}`,
          ),
        )
        throw error
      }
    }

    return server
  }

  /**
   * Send a request to the appropriate LSP server for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start or request fails
   */
  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined

    try {
      return await server.sendRequest<T>(method, params)
    } catch (error) {
      const err = error as Error
      logError(
        new Error(
          `LSP request failed for file ${filePath}, method '${method}': ${err.message}`,
        ),
      )
      throw error
    }
  }

  // Return public interface
  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

  /**
   * Touch an entry in the openedFiles Map to mark it as recently used.
   * The Map's insertion order drives LRU eviction.
   */
  function touch(fileUri: string): void {
    const record = openedFiles.get(fileUri)
    if (record) {
      openedFiles.delete(fileUri)
      openedFiles.set(fileUri, record)
    }
  }

  function enqueueDocumentOperation(
    fileUri: string,
    run: () => Promise<void>,
    ready: Promise<void> = Promise.resolve(),
    deadline?: number,
  ): Promise<void> {
    // 按 URI 保留调用顺序；等启动或前序操作时不占用全局 LRU 队列。
    const previous = documentTails.get(fileUri) ?? Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const task = Promise.all([previous, ready]).then(() => {
      checkDocumentDeadline(deadline)
      const turn = documentQueue.then(() => {
        // 取得队列后由 strict 通知负责发送期限和处置，不能用外层 race 抢先解锁。
        clearTimeout(timer)
        checkDocumentDeadline(deadline)
        return run()
      })
      documentQueue = turn.catch(() => {})
      return turn
    })
    const result =
      deadline === undefined
        ? task
        : Promise.race([
            task,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(documentDeadlineError()),
                Math.ceil(deadline - performance.now()),
              )
            }),
          ]).finally(() => clearTimeout(timer))

    // 即使当前调用排队超时，也不能让后续同 URI 调用越过还未完成的前序。
    const tail = Promise.all([previous, result.catch(() => {})]).then(() => {
      if (documentTails.get(fileUri) === tail) documentTails.delete(fileUri)
    })
    documentTails.set(fileUri, tail)
    return result
  }

  function isCurrentConnection({
    server,
    generation,
  }: DocumentConnection): boolean {
    return (
      servers.get(server.name) === server &&
      server.generation === generation &&
      server.isHealthy()
    )
  }

  function assertCurrentConnection(connection: DocumentConnection): void {
    if (!isCurrentConnection(connection)) {
      throw new Error(
        `LSP: Document connection changed for server ${connection.server.name}`,
      )
    }
  }

  async function withDocumentServer(
    filePath: string,
    startIfNeeded: boolean,
    run: (
      fileUri: string,
      connection: DocumentConnection,
      sync: ReturnType<typeof documentSync>,
    ) => Promise<void>,
    deadline?: number,
  ): Promise<void> {
    checkDocumentDeadline(deadline)
    const server = getServerForFile(filePath)
    if (!server) return
    const { state } = server
    const needsStart =
      state === 'starting' ||
      (startIfNeeded && (state === 'stopped' || state === 'error'))
    if (!startIfNeeded && !needsStart && state !== 'running') return

    const fileUri = pathToFileURL(path.resolve(filePath)).href
    // 绑定发起时的连接，或本次共享启动将产生的那一代，而不是执行时的最新连接。
    const connection = {
      server,
      generation: server.generation + (needsStart ? 1 : 0),
    }
    return enqueueDocumentOperation(
      fileUri,
      () => {
        assertCurrentConnection(connection)
        return run(
          fileUri,
          connection,
          documentSync(server.capabilities?.textDocumentSync),
        )
      },
      needsStart ? server.start() : undefined,
      deadline,
    )
  }

  async function notifyDocument(
    connection: DocumentConnection,
    fileUri: string,
    event: 'didOpen' | 'didChange' | 'didSave' | 'didClose',
    params: unknown,
    deadline?: number,
  ): Promise<void> {
    checkDocumentDeadline(deadline)
    assertCurrentConnection(connection)
    try {
      await connection.server.sendNotificationStrict(
        `textDocument/${event}`,
        params,
        deadline,
      )
      logForDebugging(`LSP: Sent ${event} for ${fileUri}`)
    } catch (error) {
      const err = new Error(
        `LSP: ${event} failed for ${fileUri}: ${errorMessage(error)}`,
        { cause: error },
      )
      logError(err)
      throw err
    }
  }

  async function closeOpenedDocument(
    fileUri: string,
    record: OpenedDocument,
    deadline?: number,
  ): Promise<void> {
    try {
      if (isCurrentConnection(record)) {
        await notifyDocument(
          record,
          fileUri,
          'didClose',
          { textDocument: { uri: fileUri } },
          deadline,
        )
      }
    } catch (error) {
      // 连接仍活着时保留记录；失效的代只清缓存，绝不向新连接补发 close。
      if (!isCurrentConnection(record)) openedFiles.delete(fileUri)
      throw error
    }
    openedFiles.delete(fileUri)
  }

  async function openDocument(
    filePath: string,
    fileUri: string,
    connection: DocumentConnection,
    content: string,
    changeKind: TextDocumentSyncKind,
    deadline?: number,
  ): Promise<void> {
    if (openedFiles.size >= MAX_OPEN_FILES) {
      const [oldestUri, oldest] = openedFiles.entries().next().value!
      try {
        await closeOpenedDocument(oldestUri, oldest, deadline)
      } catch (error) {
        throw new Error(
          `LSP: Cannot open ${filePath}: document cap (${MAX_OPEN_FILES}) reached and eviction failed: ${errorMessage(error)}`,
          { cause: error },
        )
      }
    }

    const version = documentVersion + 1
    const ext = path.extname(filePath).toLowerCase()
    const languageId =
      connection.server.config.extensionToLanguage[ext] || 'plaintext'
    await notifyDocument(
      connection,
      fileUri,
      'didOpen',
      { textDocument: { uri: fileUri, languageId, version, text: content } },
      deadline,
    )
    assertCurrentConnection(connection)
    documentVersion = version
    openedFiles.set(fileUri, {
      ...connection,
      end: changeKind === SYNC_INCREMENTAL ? utf16End(content) : undefined,
    })
  }

  function saveDocument(
    fileUri: string,
    connection: DocumentConnection,
    text?: string,
    deadline?: number,
  ): Promise<void> {
    return notifyDocument(
      connection,
      fileUri,
      'didSave',
      { textDocument: { uri: fileUri }, ...(text === undefined ? {} : { text }) },
      deadline,
    )
  }

  function syncDocument(
    filePath: string,
    content: string,
    operation: 'open' | 'change' | 'write',
    deadline?: number,
  ): Promise<void> {
    return withDocumentServer(
      filePath,
      true,
      async (fileUri, connection, sync) => {
        let existing = openedFiles.get(fileUri)
        if (
          existing &&
          (existing.server !== connection.server ||
            existing.generation !== connection.generation)
        ) {
          await closeOpenedDocument(fileUri, existing, deadline)
          existing = undefined
        }

        if (sync.openClose && !existing) {
          // 首次同步直接用当前文本打开，不再发送重复的 didChange。
          await openDocument(
            filePath,
            fileUri,
            connection,
            content,
            sync.change,
            deadline,
          )
        } else if (operation !== 'open' && sync.change !== SYNC_NONE) {
          let change: TextDocumentContentChangeEvent = { text: content }
          if (sync.change === SYNC_INCREMENTAL) {
            // 读盘不能证明服务端持有相同的旧文本；没有基线时也跳过本次保存。
            if (!existing?.end) return
            change = {
              range: { start: { line: 0, character: 0 }, end: existing.end },
              text: content,
            }
          }
          const version = documentVersion + 1
          await notifyDocument(
            connection,
            fileUri,
            'didChange',
            { textDocument: { uri: fileUri, version }, contentChanges: [change] },
            deadline,
          )
          assertCurrentConnection(connection)
          documentVersion = version
          if (existing) {
            existing.end =
              sync.change === SYNC_INCREMENTAL ? utf16End(content) : undefined
          }
        }

        if (existing) touch(fileUri)
        if (operation === 'write' && sync.save) {
          await saveDocument(
            fileUri,
            connection,
            sync.save.includeText ? content : undefined,
            deadline,
          )
        }
      },
      deadline,
    )
  }

  function openFile(filePath: string, content: string): Promise<void> {
    return syncDocument(filePath, content, 'open')
  }

  function changeFile(filePath: string, content: string): Promise<void> {
    return syncDocument(filePath, content, 'change')
  }

  function syncFileAfterWrite(
    filePath: string,
    content: string,
    deadline: number,
  ): Promise<void> {
    return syncDocument(filePath, content, 'write', deadline)
  }

  function saveFile(filePath: string): Promise<void> {
    return withDocumentServer(
      filePath,
      false,
      async (fileUri, connection, sync) => {
        if (!sync.save) return
        const existing = openedFiles.get(fileUri)
        const isOpen =
          existing?.server === connection.server &&
          existing.generation === connection.generation
        if (!isOpen && (sync.openClose || sync.change === SYNC_INCREMENTAL)) return
        // 旧 API 没有写盘文本参数；includeText 时直接读盘。
        const text = sync.save.includeText
          ? await readFile(filePath, 'utf8')
          : undefined
        await saveDocument(fileUri, connection, text)
        if (isOpen) touch(fileUri)
      },
    )
  }

  function closeFile(filePath: string): Promise<void> {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    return enqueueDocumentOperation(fileUri, async () => {
      const existing = openedFiles.get(fileUri)
      if (existing) await closeOpenedDocument(fileUri, existing)
    })
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    const existing = openedFiles.get(fileUri)
    return (
      existing !== undefined &&
      existing.server === getServerForFile(filePath) &&
      isCurrentConnection(existing)
    )
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    syncFileAfterWrite,
    closeFile,
    isFileOpen,
  }
}
