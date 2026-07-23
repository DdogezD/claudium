import * as path from 'path'
import { pathToFileURL } from 'url'
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
  /** Synchronize file close to LSP server (sends didClose notification) */
  closeFile(filePath: string): Promise<void>
  /** Check if a file is already open on a compatible LSP server */
  isFileOpen(filePath: string): boolean
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
export function createLSPServerManager(): LSPServerManager {
  // Maximum number of files that may be simultaneously tracked as "open" on
  // language servers.  When exceeded the least-recently-used file is evicted
  // (didClose sent to its server) before the new file is opened.
  const MAX_OPEN_FILES = 50

  // Private state managed via closures
  const servers: Map<string, LSPServerInstance> = new Map()
  const extensionMap: Map<string, string[]> = new Map()
  // Track which files have been opened on which servers (URI -> {serverName, generation})
  // Insertion-order Map enables O(1) LRU eviction: the first key is the oldest.
  const openedFiles: Map<string, { serverName: string; generation: number }> = new Map()

  /**
   * Initialize the manager by loading all configured LSP servers.
   *
   * @throws {Error} If configuration loading fails
   */
  async function initialize(): Promise<void> {
    let serverConfigs: Record<string, ScopedLspServerConfig>

    try {
      const result = await getAllLspServers()
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
   * Shutdown all running servers and clear state.
   * Only servers in 'running' state are explicitly stopped;
   * servers in other states are cleared without shutdown.
   *
   * @throws {Error} If one or more servers fail to stop
   */
  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([, s]) => s.state === 'running' || s.state === 'error',
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

    if (server.state === 'stopped' || server.state === 'error') {
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

  /**
   * Evict the least-recently-used opened file.
   * Sends didClose to the recorded server, then removes the local record.
   * Returns true on success, false if eviction failed (server healthy but
   * notification failed).
   */
  async function evictLRUEntry(): Promise<boolean> {
    const firstKey = openedFiles.keys().next().value
    if (!firstKey) return true // nothing to evict
    const record = openedFiles.get(firstKey)!
    const server = servers.get(record.serverName)

    // Server is gone or unhealthy — its state is already lost, safe to
    // remove the local record.
    if (!server || !server.isHealthy()) {
      openedFiles.delete(firstKey)
      logForDebugging(
        `LSP: Evicted (server not healthy) ${firstKey}`,
      )
      return true
    }

    try {
      await server.sendNotification('textDocument/didClose', {
        textDocument: { uri: firstKey },
      })
      openedFiles.delete(firstKey)
      logForDebugging(
        `LSP: Evicted (didClose ok) ${firstKey}`,
      )
      return true
    } catch (error) {
      logError(
        new Error(
          `LSP: Eviction didClose failed for ${firstKey}: ${errorMessage(error)}`,
        ),
      )
      // Keep the record — the server may still hold the document.
      return false
    }
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath)
    if (!server) return

    const fileUri = pathToFileURL(path.resolve(filePath)).href
    const existing = openedFiles.get(fileUri)

    // Same server, same generation: already tracked, just touch.
    if (
      existing &&
      existing.serverName === server.name &&
      existing.generation === server.generation
    ) {
      touch(fileUri)
      logForDebugging(
        `LSP: File already open on ${server.name} (gen ${server.generation}), skipping didOpen for ${filePath}`,
      )
      return
    }

    // Server restarted (generation changed) or routing changed: close on
    // the old server before (re)opening.
    if (existing) {
      const oldServer = servers.get(existing.serverName)
      if (oldServer && oldServer.isHealthy()) {
        try {
          await oldServer.sendNotification('textDocument/didClose', {
            textDocument: { uri: fileUri },
          })
        } catch (error) {
          // Best-effort; the old server might already be gone.
          logForDebugging(
            `LSP: didClose for server migration/restart failed on ${existing.serverName}: ${errorMessage(error)}`,
          )
        }
      }
      openedFiles.delete(fileUri)
    }

    // Evict LRU files until there is room for the new entry.
    while (openedFiles.size >= MAX_OPEN_FILES) {
      const ok = await evictLRUEntry()
      if (!ok) {
        throw new Error(
          `LSP: Cannot open ${filePath}: document cap (${MAX_OPEN_FILES}) reached and eviction failed`,
        )
      }
    }

    // Get language ID from server's extensionToLanguage mapping
    const ext = path.extname(filePath).toLowerCase()
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext'

    try {
      await server.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: content,
        },
      })
      openedFiles.set(fileUri, {
        serverName: server.name,
        generation: server.generation,
      })
      logForDebugging(
        `LSP: Sent didOpen for ${filePath} (languageId: ${languageId}, server: ${server.name} gen ${server.generation})`,
      )
    } catch (error) {
      const err = new Error(
        `Failed to sync file open ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      throw err
    }
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') {
      return openFile(filePath, content)
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href
    const existing = openedFiles.get(fileUri)

    // If file hasn't been opened on this server yet (or server restarted),
    // open it first. LSP servers require didOpen before didChange.
    if (
      !existing ||
      existing.serverName !== server.name ||
      existing.generation !== server.generation
    ) {
      return openFile(filePath, content)
    }

    try {
      await server.sendNotification('textDocument/didChange', {
        textDocument: {
          uri: fileUri,
          version: 1,
        },
        contentChanges: [{ text: content }],
      })
      // Touch LRU order on successful change.
      touch(fileUri)
      logForDebugging(`LSP: Sent didChange for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file change ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      throw err
    }
  }

  /**
   * Save a file in LSP servers (sends didSave notification)
   * Called after file is written to disk to trigger diagnostics
   */
  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') return

    try {
      await server.sendNotification('textDocument/didSave', {
        textDocument: {
          uri: pathToFileURL(path.resolve(filePath)).href,
        },
      })
      logForDebugging(`LSP: Sent didSave for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file save ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      throw err
    }
  }

  /**
   * Close a file in LSP servers (sends didClose notification).
   * Uses the recorded server name (not extension-based routing) so the
   * notification goes to the same server that received didOpen.
   */
  async function closeFile(filePath: string): Promise<void> {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    const existing = openedFiles.get(fileUri)
    if (!existing) return

    const server = servers.get(existing.serverName)
    if (!server || !server.isHealthy()) {
      // Server is gone — its state is lost, just clean up locally.
      openedFiles.delete(fileUri)
      return
    }

    try {
      await server.sendNotification('textDocument/didClose', {
        textDocument: { uri: fileUri },
      })
      openedFiles.delete(fileUri)
      logForDebugging(`LSP: Sent didClose for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file close ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      throw err
    }
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    const existing = openedFiles.get(fileUri)
    if (!existing) return false
    const server = servers.get(existing.serverName)
    // Consider the file "open" only if the server is still running with
    // the same generation — a restarted server has lost its document state.
    return (
      server !== undefined &&
      server.isHealthy() &&
      server.generation === existing.generation
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
    closeFile,
    isFileOpen,
  }
}
