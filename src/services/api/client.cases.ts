import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let apiKey: string | null = null
let helper: string | undefined
let cached: string | null = null
const executeHelper = mock(() => Promise.resolve('must-not-run'))

mock.module('src/utils/auth.js', () => ({
  getAnthropicApiKey: () => apiKey,
  getConfiguredApiKeyHelper: () => helper,
  getApiKeyFromApiKeyHelperCached: () => cached,
  getApiKeyFromApiKeyHelper: executeHelper,
}))
mock.module('src/utils/http.js', () => ({ getUserAgent: () => 'Claudium/Test' }))
mock.module('src/utils/model/providers.js', () => ({
  isFirstPartyAnthropicBaseUrl: () => false,
}))
mock.module('src/utils/proxy.js', () => ({ getProxyFetchOptions: () => ({}) }))
mock.module('../../bootstrap/state.js', () => ({
  getSessionId: () => 'fake-session', getIsNonInteractiveSession: () => false,
}))
mock.module('../../utils/debug.js', () => ({
  isDebugToStdErr: () => false, logForDebugging: () => {},
}))

const { getAnthropicRequestHeaders, getAnthropicClient } = await import('./client.js')
const legacyRoutingFlags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
const keys = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ADDITIONAL_PROTECTION',
  'ANTHROPIC_BASE_URL', ...legacyRoutingFlags,
] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))

beforeEach(() => {
  apiKey = null
  helper = undefined
  cached = null
  executeHelper.mockClear()
  for (const key of keys) delete process.env[key]
})

afterAll(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  mock.restore()
})

describe('Messages API routing', () => {
  test.each([...legacyRoutingFlags])('ignores removed routing flag %s for custom endpoints', async flag => {
    apiKey = 'fixture-key'
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.test/prefix'
    process.env[flag] = '1'
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const client = await getAnthropicClient({
      maxRetries: 0,
      fetchOverride: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({
          id: 'fixture-message', type: 'message', role: 'assistant', model: 'Team/Model:V2',
          content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })
    await client.beta.messages.create({
      model: 'Team/Model:V2', max_tokens: 1, messages: [{ role: 'user', content: 'test' }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://gateway.test/prefix/v1/messages?beta=true')
    expect(requests[0]!.headers.get('x-api-key')).toBe('fixture-key')
    expect(requests[0]!.headers.has('x-client-request-id')).toBe(false)
    expect(requests[0]!.body.model).toBe('Team/Model:V2')
    expect(requests[0]!.body).not.toHaveProperty('anthropic_version')
    expect(requests[0]!.body).not.toHaveProperty('anthropic_beta')
  })
})

describe('nonblocking discovery authentication', () => {
  test('uses API key without inventing a Bearer token', () => {
    apiKey = 'fake-api-key'
    const headers = getAnthropicRequestHeaders()!
    expect(headers.get('x-api-key')).toBe('fake-api-key')
    expect(headers.has('authorization')).toBe(false)
    expect(executeHelper).not.toHaveBeenCalled()
  })

  test('preserves custom headers and custom API key precedence', () => {
    apiKey = 'environment-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-API-Key: custom-key\nauthorization: Basic custom\nX-Gateway: tenant:route'
    const headers = getAnthropicRequestHeaders()!
    expect(headers.get('x-api-key')).toBe('custom-key')
    expect(headers.get('authorization')).toBe('Basic custom')
    expect(headers.get('x-gateway')).toBe('tenant:route')
  })

  test('duplicate custom headers use last value instead of comma-joining identities', () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Gateway: old\nx-gateway: current\nAuthorization: Basic old\nauthorization: Basic current'
    const headers = getAnthropicRequestHeaders()!
    expect(headers.get('x-gateway')).toBe('current')
    expect(headers.get('authorization')).toBe('Basic current')
  })

  test('token overrides custom Authorization case-insensitively', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'fake-token'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'authorization: Basic old'
    helper = 'fake-helper'
    expect(getAnthropicRequestHeaders()!.get('authorization')).toBe('Bearer fake-token')
    expect(executeHelper).not.toHaveBeenCalled()
  })

  test('reads configured helper cache but never executes the helper', () => {
    helper = 'fake-helper'
    cached = 'cached-token'
    expect(getAnthropicRequestHeaders()!.get('authorization')).toBe('Bearer cached-token')
    expect(executeHelper).not.toHaveBeenCalled()
  })

  test('skips cold helper auth and its failure sentinel instead of using a different identity', () => {
    helper = 'fake-helper'
    apiKey = 'other-identity'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Basic other-identity'
    for (const value of [null, '', ' ']) {
      cached = value
      expect(getAnthropicRequestHeaders()).toBeNull()
    }
    expect(executeHelper).not.toHaveBeenCalled()
  })

  test('does not use stale helper credentials after the helper is removed', () => {
    cached = 'previous-helper-token'
    expect(getAnthropicRequestHeaders()!.has('authorization')).toBe(false)
  })

  test('reuses application headers required by gateways', () => {
    process.env.CLAUDE_CODE_CONTAINER_ID = 'fake-container'
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'test-app'
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = 'true'
    const headers = getAnthropicRequestHeaders()!
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('user-agent')).toBe('Claudium/Test')
    expect(headers.get('x-claude-code-session-id')).toBe('fake-session')
    expect(headers.get('x-claude-container-id')).toBe('fake-container')
    expect(headers.get('x-client-app')).toBe('test-app')
    expect(headers.get('x-anthropic-additional-protection')).toBe('true')
  })

  test('custom application header overrides match the inference client', () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'User-Agent: Custom/Test\nx-app: custom-app\nx-claude-code-session-id: custom-session'
    const headers = getAnthropicRequestHeaders()!
    expect(headers.get('user-agent')).toBe('Custom/Test')
    expect(headers.get('x-app')).toBe('custom-app')
    expect(headers.get('x-claude-code-session-id')).toBe('custom-session')
  })
})
