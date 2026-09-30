import { describe, expect, test } from 'bun:test'
import {
  buildSearxngSearchUrl,
  buildSearxngWebSearchErrorBlocks,
  formatSearxngResultsText,
  performSearxngWebSearch,
  sanitizeSearxngBlocksForAPI,
  SearxngRequestError,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeResult(
  url: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { title: url, url, content: 'snippet', ...overrides }
}

describe('performSearxngWebSearch', () => {
  test('sends q, format=json and pageno to SearXNG', async () => {
    const requestedUrls: URL[] = []

    const { blocks } = await performSearxngWebSearch({
      request: { query: 'bun runtime' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888/',
      fetchFn: async input => {
        requestedUrls.push(toUrl(input))
        return jsonResponse({
          results: [
            {
              title: 'Bun',
              url: 'https://bun.sh/',
              content: 'Fast JavaScript runtime',
            },
          ],
        })
      },
    })

    expect(requestedUrls[0]?.pathname).toBe('/search')
    expect([...requestedUrls[0]!.searchParams.entries()].sort()).toEqual([
      ['format', 'json'],
      ['pageno', '1'],
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
    const { blocks } = await performSearxngWebSearch({
      request: {
        query: 'runtime docs',
        allowedDomains: ['example.com'],
        blockedDomains: ['blocked.example.com'],
      },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        jsonResponse({
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

  test('paginates to fill the result set after domain filtering', async () => {
    const pages: number[] = []

    const { blocks } = await performSearxngWebSearch({
      request: {
        query: 'docs',
        allowedDomains: ['example.com'],
      },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async input => {
        const url = toUrl(input)
        const page = Number(url.searchParams.get('pageno'))
        pages.push(page)
        if (page === 1) {
          // Page 1 only has results that get filtered out
          return jsonResponse({
            results: [makeResult('https://other.test/a')],
          })
        }
        return jsonResponse({
          results: [makeResult('https://example.com/from-page-2')],
        })
      },
    })

    // Page 3 returns the same URL as page 2, so pagination stops there
    expect(pages).toEqual([1, 2, 3])
    const resultBlock = blocks[1] as { content: Array<{ url: string }> }
    expect(resultBlock.content.map(r => r.url)).toEqual([
      'https://example.com/from-page-2',
    ])
  })

  test('stops paginating when a page yields no new results', async () => {
    const pages: number[] = []

    await performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async input => {
        const url = toUrl(input)
        const page = Number(url.searchParams.get('pageno'))
        pages.push(page)
        // Same URL repeated on every page
        return jsonResponse({
          results: [makeResult('https://example.com/dup')],
        })
      },
    })

    expect(pages).toEqual([1, 2])
  })

  test('caps results at the internal target', async () => {
    const { blocks } = await performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        jsonResponse({
          results: Array.from({ length: 30 }, (_, i) =>
            makeResult(`https://example.com/${i}`),
          ),
        }),
    })

    const resultBlock = blocks[1] as { content: unknown[] }
    expect(resultBlock.content).toHaveLength(20)
  })

  test('throws SearxngRequestError with status on HTTP failure', async () => {
    const promise = performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () => new Response('boom', { status: 429 }),
    })

    await expect(promise).rejects.toMatchObject({
      name: 'SearxngRequestError',
      status: 429,
    })
  })

  test('normalizes HTML snippets', async () => {
    const { blocks } = await performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        jsonResponse({
          results: [
            makeResult('https://example.com/a', {
              content:
                'The <b>&lt;b&gt;</b> tag   draws\nreaders&#39; attention &amp; more',
            }),
          ],
        }),
    })

    const resultBlock = blocks[1] as {
      content: Array<{ encrypted_content: string }>
    }
    const snippet = Buffer.from(
      resultBlock.content[0]!.encrypted_content,
      'base64',
    ).toString('utf8')
    expect(snippet).toBe('The <b> tag draws readers\' attention & more')
  })

  test('truncates long snippets', async () => {
    const { blocks } = await performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        jsonResponse({
          results: [
            makeResult('https://example.com/a', {
              content: 'x'.repeat(1000),
            }),
          ],
        }),
    })

    const resultBlock = blocks[1] as {
      content: Array<{ encrypted_content: string }>
    }
    const snippet = Buffer.from(
      resultBlock.content[0]!.encrypted_content,
      'base64',
    ).toString('utf8')
    expect(snippet).toHaveLength(501)
    expect(snippet.endsWith('…')).toBe(true)
  })
})

describe('buildSearxngWebSearchErrorBlocks', () => {
  test('builds a server_tool_use paired with an error result', () => {
    const blocks = buildSearxngWebSearchErrorBlocks(
      { query: 'docs', allowedDomains: ['example.com'] },
      'too_many_requests',
      'tool-use-id',
    )

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      type: 'server_tool_use',
      id: 'tool-use-id',
      name: 'web_search',
      input: { query: 'docs', allowed_domains: ['example.com'] },
    })
    expect(blocks[1]).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: 'tool-use-id',
      content: {
        type: 'web_search_tool_result_error',
        error_code: 'too_many_requests',
      },
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
    expect(url.searchParams.get('pageno')).toBe('1')
  })
})
describe('sanitizeSearxngBlocksForAPI', () => {
  test('empties web_search_tool_result content, keeps server_tool_use', async () => {
    const { blocks } = await performSearxngWebSearch({
      request: { query: 'docs' },
      signal: new AbortController().signal,
      baseUrl: 'http://localhost:8888',
      fetchFn: async () =>
        jsonResponse({
          results: [makeResult('https://example.com/a')],
        }),
    })

    const sanitized = sanitizeSearxngBlocksForAPI(blocks)
    expect(sanitized[0]).toEqual(blocks[0])
    expect(sanitized[1]).toMatchObject({
      type: 'web_search_tool_result',
      content: [],
    })
    // Original blocks untouched
    expect((blocks[1] as { content: unknown[] }).content).toHaveLength(1)
  })
})

describe('formatSearxngResultsText', () => {
  test('lists title, url and normalized snippet', () => {
    const text = formatSearxngResultsText({ query: 'bun' }, [
      {
        title: 'Bun',
        url: 'https://bun.sh/',
        content: 'Fast <b>runtime</b> &amp; toolkit',
      },
      { title: '', url: 'https://example.com/', content: '' },
    ])

    expect(text).toBe(
      'Search results for "bun" (via SearXNG):\n' +
        '1. Bun — https://bun.sh/\n' +
        '   Fast runtime & toolkit\n' +
        '2. https://example.com/ — https://example.com/',
    )
  })

  test('marks empty result sets', () => {
    expect(formatSearxngResultsText({ query: 'bun' }, [])).toContain(
      '(no results)',
    )
  })
})
