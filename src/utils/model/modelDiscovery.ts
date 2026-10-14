import { createHash } from 'node:crypto'

export type DiscoveredModel = { id: string; displayName?: string }

const EMPTY: readonly DiscoveredModel[] = Object.freeze([])
const SUCCESS_TTL = 5 * 60_000
const FAILURE_COOLDOWN = 60_000
const MAX_BYTES = 1024 * 1024
const MAX_ITEMS = 1000
const MAX_PAGES = 3
const CONTROL = /[\p{Cc}\p{Cf}]/u
const CLAUDE_PROXY_MODEL_PREFIX = 'claude-fable-5-dd-'

function reverseModelId(value: string): string {
  return [...value].reverse().join('')
}

export function resolveClaudeProxyModelId(id: string): string {
  const suffixStart = id.lastIndexOf('(')
  const hasSuffix = suffixStart > 0 && id.endsWith(')')
  const base = hasSuffix ? id.slice(0, suffixStart) : id
  if (!base.startsWith(CLAUDE_PROXY_MODEL_PREFIX)) return id
  const encoded = base.slice(CLAUDE_PROXY_MODEL_PREFIX.length)
  if (!encoded) return id
  const resolved = reverseModelId(encoded)
  return hasSuffix ? `${resolved}${id.slice(suffixStart)}` : resolved
}

export function buildModelDiscoveryUrls(baseURL: string | undefined): {
  endpoint: string
  primary: string
  fallback: string
} | null {
  if (
    !baseURL || !/^https?:\/\//i.test(baseURL) ||
    baseURL !== baseURL.trim() || /[\s?#\\]/u.test(baseURL) ||
    CONTROL.test(baseURL) || /^https?:\/\/[^/]*@/i.test(baseURL)
  ) {
    return null
  }
  try {
    const url = new URL(baseURL)
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password ||
      hostname === 'anthropic.com' || hostname.endsWith('.anthropic.com')
    ) return null
    const path = url.pathname.replace(/\/+$/, '')
    url.pathname = path
    const endpoint = url.href.replace(/\/$/, '')
    const prefix = path.endsWith('/v1') ? path.slice(0, -3) : path
    const origin = url.origin
    return {
      endpoint,
      primary: `${origin}${prefix}/v1/models`,
      fallback: `${origin}${prefix}/models`,
    }
  } catch {
    return null
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/\s/u.test(value) && !CONTROL.test(value)
}

export function parseDiscoveredModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== 'object') return null
  const { id, display_name } = value as Record<string, unknown>
  if (!validId(id)) return null
  const resolvedId = resolveClaudeProxyModelId(id)
  const displayName = typeof display_name === 'string'
    ? display_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200)
    : undefined
  return displayName ? { id: resolvedId, displayName } : { id: resolvedId }
}

export type ModelDiscoveryConnection = {
  baseURL?: string
  provider: string
  essentialTrafficOnly?: boolean
  unixSocket?: string
  headers: HeadersInit
  fetchOptions?: RequestInit
}

type Dependencies = {
  getConnection: () => ModelDiscoveryConnection | null
  fetch: (url: string, options: RequestInit) => Promise<Response>
  now?: () => number
  scheduleTimeout?: (callback: () => void, ms: number) => () => void
}

type Entry = {
  models: readonly DiscoveredModel[]
  successAt?: number
  failureAt?: number
  inflight?: Promise<void>
}

export function createModelDiscoveryService(deps: Dependencies) {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  const now = deps.now ?? Date.now
  const schedule = deps.scheduleTimeout ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  })

  function snapshot() {
    try {
      const connection = deps.getConnection()
      if (!connection || connection.provider !== 'firstParty' ||
        connection.essentialTrafficOnly || connection.unixSocket) return null
      const urls = buildModelDiscoveryUrls(connection.baseURL)
      if (!urls) return null
      const headers = new Headers(connection.headers)
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
      if (!headers.has('accept')) headers.set('accept', 'application/json')
      const pairs: [string, string][] = []
      headers.forEach((value, name) => pairs.push([name, value]))
      pairs.sort(([a], [b]) => a.localeCompare(b))
      const scope = createHash('sha256')
        .update(JSON.stringify([urls.endpoint, pairs])).digest('hex')
      return { connection, urls, headers, scope }
    } catch {
      return null
    }
  }

  function getDiscoveredModels(): readonly DiscoveredModel[] {
    const current = snapshot()
    return current ? entries.get(current.scope)?.models ?? EMPTY : EMPTY
  }

  async function discover(current: NonNullable<ReturnType<typeof snapshot>>) {
    const controller = new AbortController()
    let timedOut = false
    let cancelTimeout: () => void = () => {}
    const timeout = new Promise<never>((_, reject) => {
      cancelTimeout = schedule(() => {
        timedOut = true
        controller.abort()
        reject(new Error('Model discovery timeout'))
      }, 3000)
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    async function request() {
      let bytes = 0
      let items = 0
      const models = new Map<string, DiscoveredModel>()
      let target = current.urls.primary
      let cursor: string | undefined
      const cursors = new Set<string>()
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(target)
        if (cursor) url.searchParams.set('after_id', cursor)
        let response = await deps.fetch(url.href, {
          ...current.connection.fetchOptions,
          method: 'GET', headers: current.headers,
          signal: controller.signal, redirect: 'error',
        })
        if (timedOut) {
          void response.body?.cancel().catch(() => {})
          throw new Error('Model discovery timeout')
        }
        if (page === 0 && [404, 405].includes(response.status)) {
          void response.body?.cancel().catch(() => {})
          target = current.urls.fallback
          response = await deps.fetch(target, {
            ...current.connection.fetchOptions,
            method: 'GET', headers: current.headers,
            signal: controller.signal, redirect: 'error',
          })
        }
        if (timedOut || !response.ok || response.redirected || !response.body) {
          void response.body?.cancel().catch(() => {})
          throw new Error('Model discovery failed')
        }
        const length = response.headers.get('content-length')
        if (length && Number(length) > MAX_BYTES - bytes) {
          void response.body.cancel().catch(() => {})
          throw new Error('Model discovery body limit')
        }
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        while (true) {
          const chunk = await reader.read()
          if (timedOut) throw new Error('Model discovery timeout')
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > MAX_BYTES) throw new Error('Model discovery body limit')
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
        reader.releaseLock()
        reader = undefined
        const body: unknown = JSON.parse(text)
        if (!body || typeof body !== 'object' ||
          !Array.isArray((body as Record<string, unknown>).data)) {
          throw new Error('Invalid models response')
        }
        const { data, has_more, last_id } = body as {
          data: unknown[]; has_more?: unknown; last_id?: unknown
        }
        for (const value of data) {
          if (items >= MAX_ITEMS) break
          items++
          const model = parseDiscoveredModel(value)
          if (model && !models.has(model.id)) models.set(model.id, Object.freeze(model))
        }
        if (has_more !== true || items >= MAX_ITEMS || page === MAX_PAGES - 1) break
        if (!validId(last_id) || cursors.has(last_id)) {
          throw new Error('Invalid models cursor')
        }
        cursor = last_id
        cursors.add(cursor)
      }
      return models.size ? Object.freeze([...models.values()]) : EMPTY
    }
    try {
      return await Promise.race([request(), timeout])
    } finally {
      cancelTimeout()
      controller.abort()
      void reader?.cancel().catch(() => {})
    }
  }

  function refreshDiscoveredModels(): Promise<void> {
    const current = snapshot()
    if (!current) return Promise.resolve()
    let entry = entries.get(current.scope)
    if (entry?.inflight) return entry.inflight
    const time = now()
    if (entry && ((entry.failureAt !== undefined && time - entry.failureAt < FAILURE_COOLDOWN) ||
      (entry.successAt !== undefined && time - entry.successAt < SUCCESS_TTL))) {
      return Promise.resolve()
    }
    if (!entry) {
      if (entries.size >= 32) {
        const oldest = [...entries].find(([, value]) => !value.inflight)
        if (!oldest) return Promise.resolve()
        entries.delete(oldest[0])
      }
      entry = { models: EMPTY }
      entries.set(current.scope, entry)
    }
    const cached = entry
    const pending = discover(current).then(models => {
      cached.successAt = now()
      cached.failureAt = undefined
      const changed = JSON.stringify(models) !== JSON.stringify(cached.models)
      if (changed) {
        cached.models = models
        if (snapshot()?.scope === current.scope) {
          for (const listener of listeners) {
            try { listener() } catch {}
          }
        }
      }
    }).catch(() => {
      cached.failureAt = now()
    }).finally(() => {
      cached.inflight = undefined
    })
    cached.inflight = pending
    return pending
  }

  return {
    getDiscoveredModels,
    refreshDiscoveredModels,
    subscribeModelDiscovery(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

let readConnection: (() => ModelDiscoveryConnection | null) | undefined
let loading: Promise<void> | undefined
const service = createModelDiscoveryService({
  getConnection: () => readConnection?.() ?? null,
  fetch: (url, options) => globalThis.fetch(url, options),
})

function eligibleEnvironment(): boolean {
  return !!buildModelDiscoveryUrls(process.env.ANTHROPIC_BASE_URL) &&
    !process.env.ANTHROPIC_UNIX_SOCKET &&
    !process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
}

export function getDiscoveredModels(): readonly DiscoveredModel[] {
  return eligibleEnvironment() ? service.getDiscoveredModels() : EMPTY
}

export async function refreshDiscoveredModels(): Promise<void> {
  if (!eligibleEnvironment()) return
  if (!readConnection) {
    loading ??= Promise.all([
      import('../../services/api/client.js'),
      import('../proxy.js'),
      import('./providers.js'),
      import('../privacyLevel.js'),
    ]).then(([client, proxy, providers, privacy]) => {
      readConnection = () => {
        const provider = providers.getAPIProvider()
        if (!eligibleEnvironment() || provider !== 'firstParty' || privacy.isEssentialTrafficOnly()) {
          return null
        }
        const headers = client.getAnthropicRequestHeaders()
        if (!headers) return null
        const baseURL = process.env.ANTHROPIC_BASE_URL!
        const fetchOptions = proxy.getProxyFetchOptions()
        if (proxy.shouldBypassProxy(baseURL)) delete fetchOptions.proxy
        return { baseURL, provider, headers, fetchOptions }
      }
    }).catch(() => {}).finally(() => { loading = undefined })
    await loading
  }
  await service.refreshDiscoveredModels()
}

export const subscribeModelDiscovery = service.subscribeModelDiscovery
