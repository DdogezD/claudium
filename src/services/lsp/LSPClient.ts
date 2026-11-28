import { type ChildProcess, spawn } from 'child_process'
import { once } from 'events'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { withTimeout } from '../../utils/sleep.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start: (
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>
      cwd?: string
    },
  ) => Promise<void>
  initialize: (params: InitializeParams) => Promise<InitializeResult>
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>
  sendNotification: (method: string, params: unknown) => Promise<void>
  /** Like sendNotification but re-throws on transport failure. */
  sendNotificationStrict: (
    method: string,
    params: unknown,
    deadline?: number,
  ) => Promise<void>
  onNotification: (method: string, handler: (params: unknown) => void) => void
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ) => void
  stop: () => Promise<void>
}

type Transport = {
  child: ChildProcess
  rpc?: MessageConnection
  capabilities?: ServerCapabilities
  stopping: boolean
}

const NOTIFICATION_TIMEOUT_MS = 2_000
const SHUTDOWN_TIMEOUT_MS = 2_000

export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  let active: Transport | undefined
  const notificationHandlers = new Map<string, (params: unknown) => void>()
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >()

  function release(transport: Transport): void {
    if (active !== transport) return
    active = undefined
    // JSON-RPC 的 close 事件本身不会拒绝挂起的请求。
    try {
      transport.rpc?.dispose()
    } catch (error) {
      logForDebugging(`LSP server ${serverName} disposal failed: ${errorMessage(error)}`)
    }
    const { child } = transport
    try {
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill()
      }
    } catch (error) {
      logForDebugging(`LSP server ${serverName} could not be stopped: ${errorMessage(error)}`)
    }
  }

  function disconnected(transport: Transport, error: Error): void {
    if (active !== transport) return
    release(transport)
    if (!transport.stopping) {
      logError(error)
      onCrash?.(error)
    }
  }

  function getConnection() {
    const transport = active
    const rpc = transport?.rpc
    if (!transport || !rpc || transport.stopping) {
      throw new Error(`LSP server ${serverName} is not connected`)
    }
    return { transport, rpc }
  }

  async function sendNotificationStrict(
    method: string,
    params: unknown,
    deadline = performance.now() + NOTIFICATION_TIMEOUT_MS,
  ): Promise<void> {
    const remaining = deadline - performance.now()
    const timeoutMessage = `LSP notification ${method} timed out for ${serverName}`
    if (remaining <= 0) throw new Error(timeoutMessage)
    const { transport, rpc } = getConnection()
    try {
      await withTimeout(
        rpc.sendNotification(method, params),
        remaining,
        timeoutMessage,
      )
      if (active !== transport) {
        throw new Error(`LSP server ${serverName} disconnected during ${method}`)
      }
    } catch (error) {
      // 写入一旦开始，失败后无法判断服务端已应用哪些文档状态。
      disconnected(transport, toError(error))
      throw error
    }
  }

  return {
    get capabilities() {
      return active?.capabilities
    },
    get isInitialized() {
      return active?.capabilities !== undefined && !active.stopping
    },

    async start(command, args, options) {
      if (active) throw new Error(`LSP server ${serverName} is already started`)
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: subprocessEnv(options?.env),
        cwd: options?.cwd,
        windowsHide: true,
      })
      const transport: Transport = { child, stopping: false }
      active = transport
      child.stdin?.on('error', error => {
        if (active === transport && !transport.stopping) {
          logForDebugging(`LSP server ${serverName} stdin error: ${error.message}`)
        }
      })
      try {
        await once(child, 'spawn')
        if (active !== transport) {
          throw new Error(`LSP server ${serverName} stopped during startup`)
        }
        if (
          !child.stdout ||
          !child.stdin ||
          child.stdout.destroyed ||
          child.stdin.destroyed ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          throw new Error(`LSP server ${serverName} stdio is not available`)
        }
        child.stderr?.on('data', (data: Buffer) => {
          const output = data.toString().trim()
          if (active === transport && output) {
            logForDebugging(`[LSP SERVER ${serverName}] ${output}`)
          }
        })
        child.on('error', error => disconnected(transport, error))
        child.once('exit', (code, signal) => {
          disconnected(
            transport,
            new Error(`LSP server ${serverName} exited (${signal ?? code})`),
          )
        })
        const rpc = createMessageConnection(
          new StreamMessageReader(child.stdout),
          new StreamMessageWriter(child.stdin),
        )
        transport.rpc = rpc
        rpc.onError(([error]) => disconnected(transport, error))
        rpc.onClose(() => {
          disconnected(transport, new Error(`LSP server ${serverName} connection closed`))
        })
        for (const [method, handler] of notificationHandlers) {
          rpc.onNotification(method, handler)
        }
        for (const [method, handler] of requestHandlers) {
          rpc.onRequest(method, handler)
        }
        rpc.listen()
        await rpc.trace(Trace.Verbose, {
          log: (message: string) => {
            logForDebugging(`[LSP PROTOCOL ${serverName}] ${message}`)
          },
        })
        logForDebugging(`LSP client started for ${serverName}`)
      } catch (error) {
        release(transport)
        throw error
      }
    },

    async initialize(params) {
      const { transport, rpc } = getConnection()
      const result = await rpc.sendRequest<InitializeResult>('initialize', params)
      if (active !== transport || transport.stopping) {
        throw new Error(`LSP server ${serverName} disconnected during initialization`)
      }
      const encoding = result.capabilities.positionEncoding
      if (encoding !== undefined && encoding !== 'utf-16') {
        throw new Error(`LSP server ${serverName} selected unsupported position encoding ${encoding}`)
      }
      await rpc.sendNotification('initialized', {})
      if (active !== transport || transport.stopping) {
        throw new Error(`LSP server ${serverName} disconnected during initialization`)
      }
      transport.capabilities = result.capabilities
      logForDebugging(`LSP server ${serverName} initialized`)
      return result
    },

    async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
      const { transport, rpc } = getConnection()
      if (!transport.capabilities) throw new Error('LSP server not initialized')
      try {
        return await rpc.sendRequest<TResult>(method, params)
      } catch (error) {
        logError(new Error(`LSP server ${serverName} request ${method} failed: ${errorMessage(error)}`))
        throw error
      }
    },

    async sendNotification(method, params) {
      try {
        await sendNotificationStrict(method, params)
      } catch (error) {
        logForDebugging(`LSP notification ${method} failed for ${serverName}: ${errorMessage(error)}`)
      }
    },
    sendNotificationStrict,

    onNotification(method, handler) {
      notificationHandlers.set(method, handler)
      active?.rpc?.onNotification(method, handler)
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      const handleRequest = handler as (params: unknown) => unknown
      requestHandlers.set(method, handleRequest)
      active?.rpc?.onRequest(method, handleRequest)
    },

    async stop() {
      const transport = active
      if (!transport || transport.stopping) return
      transport.stopping = true
      const { rpc, child, capabilities } = transport
      try {
        if (rpc && capabilities) {
          const shutdown = async () => {
            await rpc.sendRequest('shutdown')
            await Promise.all([once(child, 'exit'), rpc.sendNotification('exit')])
          }
          await withTimeout(shutdown(), SHUTDOWN_TIMEOUT_MS, `LSP server ${serverName} shutdown timed out`)
        }
      } finally {
        release(transport)
      }
      logForDebugging(`LSP client stopped for ${serverName}`)
    },
  }
}
