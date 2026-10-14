import { describe, expect, test } from 'bun:test'
import {
  buildModelDiscoveryUrls,
  createModelDiscoveryService,
  parseDiscoveredModel,
  resolveClaudeProxyModelId,
  type ModelDiscoveryConnection,
} from './modelDiscovery.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function harness(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  let time = 0
  let connection: ModelDiscoveryConnection | null = {
    baseURL: 'https://gateway.test/prefix',
    provider: 'firstParty',
    headers: { 'x-api-key': 'fake-key' },
  }
  let timeout: (() => void) | undefined
  const calls: { url: string; init: RequestInit }[] = []
  const service = createModelDiscoveryService({
    getConnection: () => connection,
    now: () => time,
    scheduleTimeout: (callback, ms) => {
      expect(ms).toBe(3000)
      timeout = callback
      return () => { timeout = undefined }
    },
    fetch: async (url, init) => {
      calls.push({ url, init })
      return fetchFn(url, init)
    },
  })
  return {
    service, calls,
    advance: (ms: number) => { time += ms },
    expire: () => { timeout?.() },
    setConnection: (value: ModelDiscoveryConnection | null) => { connection = value },
    getConnection: () => connection!,
  }
}

const one = { data: [{ id: 'Provider/Model:V2', display_name: 'Model Two' }] }

describe('model discovery URL and response parsing', () => {
  test('preserves prefix, recognizes v1, normalizes host/port/slashes', () => {
    expect(buildModelDiscoveryUrls('https://GATEWAY.test:443/team///')).toEqual({
      endpoint: 'https://gateway.test/team',
      primary: 'https://gateway.test/team/v1/models',
      fallback: 'https://gateway.test/team/models',
    })
    expect(buildModelDiscoveryUrls('http://localhost:8080/team/v1/')?.primary)
      .toBe('http://localhost:8080/team/v1/models')
    expect(buildModelDiscoveryUrls('http://localhost:8080/team/v1/')?.fallback)
      .toBe('http://localhost:8080/team/models')
    expect(buildModelDiscoveryUrls('https://gateway.test')?.primary)
      .toBe('https://gateway.test/v1/models')
  })

  test('rejects absent, malformed, official and credential-bearing endpoints', () => {
    for (const value of [
      undefined, '', 'not a URL', 'file:///tmp/models', 'ftp://gateway.test',
      'https://user:pass@gateway.test', 'https://user@gateway.test',
      'https://@gateway.test', 'https://:@gateway.test', 'https:gateway.test',
      'https://gateway.test/\u202e',
      'https://gateway.test/?a=1', 'https://gateway.test/#frag',
      'https://gateway.test/?', 'https://gateway.test/#',
      ' https://gateway.test', 'https://gate\nway.test',
      'https://api.anthropic.com', 'http://API.ANTHROPIC.COM:1234/v1',
      'https://api.anthropic.com./', 'https://api-staging.anthropic.com/v1',
    ]) expect(buildModelDiscoveryUrls(value)).toBeNull()
  })

  test('resolves CLIProxyAPI Claude IDs before exposing models', () => {
    expect(resolveClaudeProxyModelId('claude-fable-5-dd-hsalf-newq/lacol'))
      .toBe('local/qwen-flash')
    expect(resolveClaudeProxyModelId('claude-fable-5-dd-2k-imik(max)'))
      .toBe('kimi-k2(max)')
    expect(parseDiscoveredModel({
      id: 'claude-fable-5-dd-hsalf-newq/lacol',
      display_name: 'qwen-flash',
    })).toEqual({ id: 'local/qwen-flash', displayName: 'qwen-flash' })
  })

  test('keeps raw ID case and separators; sanitizes display names only', () => {
    expect(parseDiscoveredModel({ id: 'Team/Model:AbC', display_name: '\u001bName\n\u202e' }))
      .toEqual({ id: 'Team/Model:AbC', displayName: 'Name' })
    expect(parseDiscoveredModel({ id: 'x', display_name: 'A'.repeat(250) })?.displayName)
      .toHaveLength(200)
    expect(parseDiscoveredModel({ id: 'x', display_name: '\n' })).toEqual({ id: 'x' })
    for (const id of ['', 'a b', 'a\tb', 'a\u0000b', 'a\u202eb', 'x'.repeat(513), 3]) {
      expect(parseDiscoveredModel({ id })).toBeNull()
    }
    expect(parseDiscoveredModel(null)).toBeNull()
  })
})

describe('model discovery requests', () => {
  test('uses only configured host, auth and proxy options, with redirects disabled', async () => {
    const h = harness(async () => json(one))
    h.getConnection().headers = new Headers({
      'X-API-Key': 'custom-key', Authorization: 'Bearer fake-token',
      'X-Custom': 'custom-value', 'Anthropic-Version': 'custom-version',
    })
    h.getConnection().fetchOptions = { proxy: 'http://proxy.test' } as RequestInit
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toBe('https://gateway.test/prefix/v1/models')
    const init = h.calls[0]!.init
    expect(init.redirect).toBe('error')
    expect(init.method).toBe('GET')
    expect((init as { proxy?: string }).proxy).toBe('http://proxy.test')
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe('custom-key')
    expect(headers.get('authorization')).toBe('Bearer fake-token')
    expect(headers.get('anthropic-version')).toBe('custom-version')
    expect(headers.get('x-custom')).toBe('custom-value')
    expect(h.service.getDiscoveredModels()).toEqual([
      { id: 'Provider/Model:V2', displayName: 'Model Two' },
    ])
  })

  test('adds version compatibility without converting API key to Bearer', async () => {
    const h = harness(async () => json(one))
    await h.service.refreshDiscoveredModels()
    const headers = new Headers(h.calls[0]!.init.headers)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-api-key')).toBe('fake-key')
    expect(headers.has('authorization')).toBe(false)
  })

  test('skips unsupported connections and returns one stable empty reference', async () => {
    const h = harness(async () => { throw new Error('must not fetch') })
    const empty = h.service.getDiscoveredModels()
    const base = h.getConnection()
    for (const connection of [
      null, { ...base, baseURL: undefined }, { ...base, baseURL: 'https://api.anthropic.com' },
      { ...base, baseURL: 'invalid' }, { ...base, provider: 'bedrock' },
      { ...base, provider: 'vertex' }, { ...base, provider: 'foundry' },
      { ...base, unixSocket: '/tmp/fake.sock' }, { ...base, essentialTrafficOnly: true },
    ]) {
      h.setConnection(connection)
      await h.service.refreshDiscoveredModels()
      expect(h.service.getDiscoveredModels()).toBe(empty)
    }
    expect(h.calls).toHaveLength(0)
  })

  test('fallback is same-prefix and only for 404/405', async () => {
    for (const status of [404, 405, 400, 401, 403, 429, 500, 302]) {
      let count = 0
      const h = harness(async () => ++count === 1 ? json({}, status) : json(one))
      await h.service.refreshDiscoveredModels()
      expect(h.calls).toHaveLength([404, 405].includes(status) ? 2 : 1)
      if (h.calls.length === 2) {
        expect(h.calls[1]!.url).toBe('https://gateway.test/prefix/models')
      }
    }
  })

  test('fallback under v1 does not duplicate v1 and does not retry failures', async () => {
    const h = harness(async () => json({}, 404))
    h.getConnection().baseURL = 'https://gateway.test/team/v1'
    await h.service.refreshDiscoveredModels()
    expect(h.calls.map(call => call.url)).toEqual([
      'https://gateway.test/team/v1/models', 'https://gateway.test/team/models',
    ])
  })

  test('local cursors only: remote URL fields are never followed', async () => {
    const cursor = 'Team/model:1&next=https://evil.test'
    let count = 0
    const h = harness(async () => ++count === 1 ? json({
      data: [{ id: 'one' }], has_more: true, last_id: cursor,
      next: 'https://evil.test/steal', next_url: 'https://evil.test/steal',
    }) : json({ data: [{ id: 'two' }, { id: 'one' }] }))
    await h.service.refreshDiscoveredModels()
    const url = new URL(h.calls[1]!.url)
    expect(url.origin).toBe('https://gateway.test')
    expect(url.pathname).toBe('/prefix/v1/models')
    expect(url.searchParams.get('after_id')).toBe(cursor)
    expect([...url.searchParams.keys()]).toEqual(['after_id'])
    expect(h.service.getDiscoveredModels().map(model => model.id)).toEqual(['one', 'two'])
  })

  test('caps pagination at three pages and raw item count at 1000', async () => {
    let count = 0
    const h = harness(async () => json({
      data: [{ id: `m${++count}` }], has_more: true, last_id: `m${count}`,
    }))
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(3)
    expect(h.service.getDiscoveredModels()).toHaveLength(3)
    const many = harness(async () => json({
      data: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` })),
      has_more: true, last_id: 'm1000',
    }))
    await many.service.refreshDiscoveredModels()
    expect(many.calls).toHaveLength(1)
    expect(many.service.getDiscoveredModels()).toHaveLength(1000)
  })

  test('a later-page 404 never switches routes or returns a partial failed result', async () => {
    let count = 0
    const h = harness(async () => ++count === 1 ? json({
      data: [{ id: 'one' }], has_more: true, last_id: 'one',
    }) : json({}, 404))
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(2)
    expect(new URL(h.calls[1]!.url).pathname).toBe('/prefix/v1/models')
    expect(h.service.getDiscoveredModels()).toHaveLength(0)
  })

  test('missing or repeated cursors fail silently instead of looping', async () => {
    for (const cursor of [undefined, '', 'bad cursor', 'same']) {
      const h = harness(async () => json({
        data: [{ id: 'x' }], has_more: true, last_id: cursor,
      }))
      await h.service.refreshDiscoveredModels()
      expect(h.service.getDiscoveredModels()).toHaveLength(0)
      expect(h.calls.length).toBe(cursor === 'same' ? 2 : 1)
    }
  })

  test('malformed JSON/schema, redirected responses and transport failures stay silent', async () => {
    for (const fn of [
      async () => new Response('{'),
      async () => json({ models: [{ id: 'x' }] }),
      async () => { throw new Error('fake transport error') },
      async () => {
        const response = json(one)
        Object.defineProperty(response, 'redirected', { value: true })
        return response
      },
    ]) {
      const h = harness(fn)
      await expect(h.service.refreshDiscoveredModels()).resolves.toBeUndefined()
      expect(h.service.getDiscoveredModels()).toHaveLength(0)
      expect(h.calls).toHaveLength(1)
    }
  })

  test('enforces body limit on advertised and streamed bytes', async () => {
    for (const advertised of [true, false]) {
      const h = harness(async () => new Response('x'.repeat(1024 * 1024 + 1), {
        headers: advertised ? { 'content-length': String(1024 * 1024 + 1) } : {},
      }))
      await h.service.refreshDiscoveredModels()
      expect(h.service.getDiscoveredModels()).toHaveLength(0)
    }
  })

  test('1 MiB budget is cumulative across pages', async () => {
    let count = 0
    const h = harness(async () => json({
      data: [{ id: `m${++count}` }], has_more: true, last_id: `m${count}`,
      padding: 'x'.repeat(600_000),
    }))
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(2)
    expect(h.service.getDiscoveredModels()).toHaveLength(0)
  })

  test('three-second deadline bounds a fetch ignoring AbortSignal', async () => {
    const h = harness(async () => new Promise<Response>(() => {}))
    const pending = h.service.refreshDiscoveredModels()
    h.expire()
    await pending
    expect(h.calls[0]!.init.signal?.aborted).toBe(true)
    expect(h.service.getDiscoveredModels()).toHaveLength(0)
  })

  test('same deadline includes stalled body reads and cancels the stream', async () => {
    let cancelled = false
    const h = harness(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')) },
      cancel() { cancelled = true },
    })))
    const pending = h.service.refreshDiscoveredModels()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    h.expire()
    await pending
    expect(cancelled).toBe(true)
    expect(h.service.getDiscoveredModels()).toHaveLength(0)
  })
})

describe('model discovery scoped cache and subscriptions', () => {
  test('singleflight and success TTL reuse stable references', async () => {
    let resolve!: (response: Response) => void
    const h = harness(async () => new Promise<Response>(done => { resolve = done }))
    const first = h.service.refreshDiscoveredModels()
    expect(h.service.refreshDiscoveredModels()).toBe(first)
    expect(h.calls).toHaveLength(1)
    resolve(json(one))
    await first
    const models = h.service.getDiscoveredModels()
    h.advance(299_999)
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(1)
    expect(h.service.getDiscoveredModels()).toBe(models)
    h.advance(1)
    const next = h.service.refreshDiscoveredModels()
    resolve(json(one))
    await next
    expect(h.calls).toHaveLength(2)
    expect(h.service.getDiscoveredModels()).toBe(models)
  })

  test('failure cooldown, stale preservation, and no notifications for failures/equal data', async () => {
    let fail = false
    const h = harness(async () => fail ? json({}, 503) : json(one))
    let notifications = 0
    const unsubscribe = h.service.subscribeModelDiscovery(() => { notifications++ })
    await h.service.refreshDiscoveredModels()
    const cached = h.service.getDiscoveredModels()
    expect(notifications).toBe(1)
    fail = true
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    expect(h.service.getDiscoveredModels()).toBe(cached)
    h.advance(59_999)
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(2)
    fail = false
    h.advance(1)
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(3)
    expect(notifications).toBe(1)
    unsubscribe()
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    expect(notifications).toBe(1)
  })

  test('normalizes header names/order but isolates endpoint, auth and all effective headers', async () => {
    const h = harness(async () => json(one))
    const base = h.getConnection()
    base.headers = { 'X-API-Key': 'fake-key', 'X-Region': 'one' }
    await h.service.refreshDiscoveredModels()
    const original = h.service.getDiscoveredModels()
    h.setConnection({ ...base, baseURL: 'https://GATEWAY.test:443/prefix/',
      headers: { 'x-region': 'one', 'x-api-key': 'fake-key' } })
    expect(h.service.getDiscoveredModels()).toBe(original)
    await h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(1)
    for (const changes of [
      { baseURL: 'https://another.test/prefix' },
      { headers: { 'x-api-key': 'other-fake-key' } },
      { headers: { authorization: 'Bearer fake-token' } },
      { headers: { 'x-api-key': 'fake-key', 'x-region': 'two' } },
    ]) {
      h.setConnection({ ...base, ...changes })
      expect(h.service.getDiscoveredModels()).toHaveLength(0)
      await h.service.refreshDiscoveredModels()
      expect(h.service.getDiscoveredModels()).toEqual(original)
    }
    expect(h.calls).toHaveLength(5)
    h.setConnection(base)
    expect(h.service.getDiscoveredModels()).toBe(original)
  })

  test('old-scope inflight result never notifies or populates current scope', async () => {
    let resolve!: (response: Response) => void
    const h = harness(async () => new Promise<Response>(done => { resolve = done }))
    const original = h.getConnection()
    let notifications = 0
    h.service.subscribeModelDiscovery(() => { notifications++ })
    const pending = h.service.refreshDiscoveredModels()
    h.setConnection({ ...original, headers: { 'x-api-key': 'rotated-fake-key' } })
    resolve(json(one))
    await pending
    expect(h.service.getDiscoveredModels()).toHaveLength(0)
    expect(notifications).toBe(0)
    h.setConnection(original)
    expect(h.service.getDiscoveredModels()).toHaveLength(1)
  })

  test('caps concurrent connection scopes without evicting active requests', async () => {
    const resolvers: ((response: Response) => void)[] = []
    const h = harness(async () => new Promise<Response>(resolve => { resolvers.push(resolve) }))
    const base = h.getConnection()
    const pending: Promise<void>[] = []
    for (let i = 0; i < 33; i++) {
      h.setConnection({ ...base, baseURL: `https://gateway.test/scope-${i}` })
      pending.push(h.service.refreshDiscoveredModels())
    }
    expect(h.calls).toHaveLength(32)
    resolvers.forEach(resolve => resolve(json(one)))
    await Promise.all(pending)
    const next = h.service.refreshDiscoveredModels()
    expect(h.calls).toHaveLength(33)
    resolvers[32]!(json(one))
    await next
  })

  test('successful empty discovery clears stale models and notifies once', async () => {
    let empty = false
    const h = harness(async () => json(empty ? { data: [] } : one))
    let notifications = 0
    h.service.subscribeModelDiscovery(() => { notifications++ })
    await h.service.refreshDiscoveredModels()
    empty = true
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    const models = h.service.getDiscoveredModels()
    expect(models).toHaveLength(0)
    expect(notifications).toBe(2)
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    expect(h.service.getDiscoveredModels()).toBe(models)
    expect(notifications).toBe(2)
  })

  test('subscriber errors are isolated; unsubscribe and effective changes work', async () => {
    let id = 'first'
    const h = harness(async () => json({ data: [{ id }] }))
    let notifications = 0
    h.service.subscribeModelDiscovery(() => { throw new Error('fake UI error') })
    const unsubscribe = h.service.subscribeModelDiscovery(() => { notifications++ })
    await h.service.refreshDiscoveredModels()
    id = 'second'
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    expect(notifications).toBe(2)
    unsubscribe()
    id = 'third'
    h.advance(300_000)
    await h.service.refreshDiscoveredModels()
    expect(notifications).toBe(2)
  })
})
