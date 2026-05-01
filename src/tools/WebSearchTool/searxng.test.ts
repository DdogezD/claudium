import { describe, expect, test } from 'bun:test'
import {
  buildSearxngSearchUrl,
  performSearxngWebSearch,
} from './searxng.js'

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input
  }
  if (typeof input === 'string') {
    return new URL(input)
  }
  return new URL(input.url)
}

describe('performSearxngWebSearch', () => {
  test('sends only q and format=json to SearXNG', async () => {
    let requestedUrl: URL | undefined

    const blocks = await performSearxngWebSearch({
      request: { query: 'bun runtime' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888/',
      fetchFn: async input => {
        requestedUrl = toUrl(input)
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Bun',
                url: 'https://bun.sh/',
                content: 'Fast JavaScript runtime',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    })

    expect(requestedUrl?.pathname).toBe('/search')
    expect([...requestedUrl!.searchParams.entries()].sort()).toEqual([
      ['format', 'json'],
      ['q', 'bun runtime'],
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      type: 'server_tool_use',
      name: 'web_search',
    })
    expect(blocks[1]).toMatchObject({
      type: 'web_search_tool_result',
    })
    expect((blocks[1] as { content: unknown[] }).content).toHaveLength(1)
  })

  test('filters domains locally using allowed and blocked lists', async () => {
    const blocks = await performSearxngWebSearch({
      request: {
        query: 'runtime docs',
        allowedDomains: ['example.com'],
        blockedDomains: ['blocked.example.com'],
      },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: 'Allowed',
                url: 'https://docs.example.com/guide',
                content: 'Allowed result',
              },
              {
                title: 'Blocked',
                url: 'https://blocked.example.com/post',
                content: 'Blocked result',
              },
              {
                title: 'Different domain',
                url: 'https://other.test/post',
                content: 'Other result',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    })

    const resultBlock = blocks[1] as {
      content: Array<{ title: string; url: string }>
    }

    expect(resultBlock.content).toHaveLength(1)
    expect(resultBlock.content[0]).toMatchObject({
      title: 'Allowed',
      url: 'https://docs.example.com/guide',
    })
  })
})

describe('buildSearxngSearchUrl', () => {
  test('preserves a configured base path', () => {
    const url = buildSearxngSearchUrl(
      'http://localhost:8888/searxng/',
      'query text',
    )

    expect(url.pathname).toBe('/searxng/search')
    expect(url.searchParams.get('q')).toBe('query text')
    expect(url.searchParams.get('format')).toBe('json')
  })
})