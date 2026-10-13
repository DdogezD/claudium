import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let headers: Headers | null = new Headers({ 'x-api-key': 'fake-key' })
let provider = 'firstParty'
let privacy = false
let bypass = false
const readAuth = mock(() => headers)
const readProxy = mock(() => ({ proxy: 'http://proxy.test', tls: { serverName: 'gateway.test' } }))
const fetchFn = mock(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({
  data: [{ id: 'runtime-model' }],
})))

mock.module('../../services/api/client.js', () => ({ getAnthropicRequestHeaders: readAuth }))
mock.module('../proxy.js', () => ({
  getProxyFetchOptions: readProxy,
  shouldBypassProxy: () => bypass,
}))
mock.module('./providers.js', () => ({ getAPIProvider: () => provider }))
mock.module('../privacyLevel.js', () => ({ isEssentialTrafficOnly: () => privacy }))

const { getDiscoveredModels, refreshDiscoveredModels } = await import('./modelDiscovery.js')
const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const originalFetch = globalThis.fetch
let sequence = 0

beforeEach(() => {
  headers = new Headers({ 'x-api-key': 'fake-key' })
  provider = 'firstParty'
  privacy = false
  bypass = false
  readAuth.mockClear()
  readProxy.mockClear()
  fetchFn.mockClear()
  globalThis.fetch = fetchFn as unknown as typeof fetch
  for (const key of keys) delete process.env[key]
  process.env.ANTHROPIC_BASE_URL = `https://gateway.test/runtime-${++sequence}`
})

afterAll(() => {
  globalThis.fetch = originalFetch
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  mock.restore()
})

describe('runtime model discovery wiring', () => {
  test('skips missing and official endpoints before resolving authentication', async () => {
    for (const endpoint of [undefined, '', 'https://api.anthropic.com', 'invalid']) {
      if (endpoint === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = endpoint
      await refreshDiscoveredModels()
      expect(getDiscoveredModels()).toEqual([])
    }
    expect(readAuth).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('uses only the configured endpoint, effective auth and transport', async () => {
    await refreshDiscoveredModels()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, options] = fetchFn.mock.calls[0]!
    expect(url).toBe(`${process.env.ANTHROPIC_BASE_URL}/v1/models`)
    expect(new Headers(options?.headers).get('x-api-key')).toBe('fake-key')
    expect(options?.redirect).toBe('error')
    expect((options as { proxy?: string }).proxy).toBe('http://proxy.test')
    expect(getDiscoveredModels()).toEqual([{ id: 'runtime-model' }])
    expect(readProxy.mock.calls.every(args => args.length === 0)).toBe(true)
  })

  test('does not resolve auth or fetch in privacy, tunnel or cloud-provider modes', async () => {
    privacy = true
    await refreshDiscoveredModels()
    privacy = false
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/fake.sock'
    await refreshDiscoveredModels()
    delete process.env.ANTHROPIC_UNIX_SOCKET
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    await refreshDiscoveredModels()
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    provider = 'bedrock'
    await refreshDiscoveredModels()
    expect(readAuth).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('unready helper authentication does not issue an anonymous request or poison retry', async () => {
    headers = null
    await refreshDiscoveredModels()
    expect(fetchFn).not.toHaveBeenCalled()
    headers = new Headers({ authorization: 'Bearer ready-helper' })
    await refreshDiscoveredModels()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer ready-helper')
  })

  test('NO_PROXY bypass removes Bun proxy without dropping TLS options', async () => {
    bypass = true
    await refreshDiscoveredModels()
    const options = fetchFn.mock.calls[0]![1] as RequestInit & { proxy?: string; tls?: unknown }
    expect(options.proxy).toBeUndefined()
    expect(options.tls).toEqual({ serverName: 'gateway.test' })
  })

  test('changing endpoint or authentication cannot expose a previous directory', async () => {
    await refreshDiscoveredModels()
    expect(getDiscoveredModels()).toHaveLength(1)
    process.env.ANTHROPIC_BASE_URL += '/new'
    expect(getDiscoveredModels()).toEqual([])
    await refreshDiscoveredModels()
    headers = new Headers({ 'x-api-key': 'different-account' })
    expect(getDiscoveredModels()).toEqual([])
    await refreshDiscoveredModels()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
})
