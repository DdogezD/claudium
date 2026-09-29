import type { ClientOptions } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaServerToolUseBlock,
  BetaWebSearchResultBlock,
  BetaWebSearchToolResultBlock,
  BetaWebSearchToolResultErrorCode,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getUserAgent } from '../../utils/http.js'

export const SEARXNG_BASE_URL_ENV_VAR = 'CLAUDE_CODE_SEARXNG_BASE_URL'

// Collect up to this many results after domain filtering. Pages are fetched
// until the target is reached, results are exhausted, or MAX_PAGES is hit.
const TARGET_RESULTS = 20
const MAX_PAGES = 5
const SNIPPET_MAX_LENGTH = 500

export type SearxngWebSearchRequest = {
  query: string
  allowedDomains?: string[]
  blockedDomains?: string[]
}

type FetchLike = NonNullable<ClientOptions['fetch']> | typeof fetch

type SearxngSearchResponse = {
  results?: SearxngSearchResult[]
}

type SearxngSearchResult = {
  title?: string | null
  url?: string | null
  content?: string | null
  publishedDate?: string | null
}

export function hasSearxngWebSearchOverride(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getConfiguredSearxngBaseUrl(env) !== undefined
}

export function getConfiguredSearxngBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const baseUrl = env[SEARXNG_BASE_URL_ENV_VAR]?.trim()
  return baseUrl ? baseUrl.replace(/\/+$/, '') : undefined
}

export class SearxngRequestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SearxngRequestError'
    this.status = status
  }
}

export function buildSearxngSearchUrl(
  baseUrl: string,
  query: string,
  page = 1,
): URL {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`Invalid ${SEARXNG_BASE_URL_ENV_VAR} value: ${baseUrl}`)
  }

  const pathnameBase = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  url.pathname = `${pathnameBase}/search`
  url.search = ''
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('pageno', String(page))
  return url
}

function buildServerToolUseBlock(
  request: SearxngWebSearchRequest,
  toolUseId: string,
): BetaServerToolUseBlock {
  return {
    id: toolUseId,
    input: {
      query: request.query,
      ...(request.allowedDomains
        ? { allowed_domains: request.allowedDomains }
        : {}),
      ...(request.blockedDomains
        ? { blocked_domains: request.blockedDomains }
        : {}),
    },
    name: 'web_search',
    type: 'server_tool_use',
  }
}

export function buildSearxngWebSearchBlocks(
  request: SearxngWebSearchRequest,
  results: SearxngSearchResult[],
  toolUseId: string = randomUUID(),
): BetaContentBlock[] {
  const resultBlock: BetaWebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: results
      .map(toBetaWebSearchResult)
      .filter(
        (
          result,
        ): result is BetaWebSearchResultBlock => result !== undefined,
      ),
  }

  return [buildServerToolUseBlock(request, toolUseId), resultBlock]
}

export function buildSearxngWebSearchErrorBlocks(
  request: SearxngWebSearchRequest,
  errorCode: BetaWebSearchToolResultErrorCode = 'unavailable',
  toolUseId: string = randomUUID(),
): BetaContentBlock[] {
  const resultBlock: BetaWebSearchToolResultBlock = {
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: {
      type: 'web_search_tool_result_error',
      error_code: errorCode,
    },
  }

  return [buildServerToolUseBlock(request, toolUseId), resultBlock]
}

export async function performSearxngWebSearch({
  request,
  signal,
  baseUrl = getConfiguredSearxngBaseUrl(),
  fetchFn = fetch,
}: {
  request: SearxngWebSearchRequest
  signal: AbortSignal
  baseUrl?: string
  fetchFn?: FetchLike
}): Promise<BetaContentBlock[]> {
  if (!baseUrl) {
    throw new Error(`${SEARXNG_BASE_URL_ENV_VAR} is not set`)
  }

  const results: SearxngSearchResult[] = []
  const seenUrls = new Set<string>()

  // Domain filtering happens client-side, so filtering a single page would
  // shrink an already-small set. Paginate until we have TARGET_RESULTS
  // matches, the instance runs out of results, or we hit MAX_PAGES.
  for (
    let page = 1;
    page <= MAX_PAGES && results.length < TARGET_RESULTS;
    page++
  ) {
    const pageResults = await fetchSearxngPage(baseUrl, request.query, page, {
      signal,
      fetchFn,
    })
    if (pageResults.length === 0) {
      break
    }

    const matched = filterSearxngResults(pageResults, request)
    let newOnPage = 0
    for (const result of matched) {
      const url = (result.url as string).trim()
      if (seenUrls.has(url)) {
        continue
      }
      seenUrls.add(url)
      results.push(result)
      newOnPage++
      if (results.length >= TARGET_RESULTS) {
        break
      }
    }

    // Engines frequently repeat results across pages; a page whose matches
    // are all duplicates means further pages are unlikely to help. A page
    // with zero matches at all (e.g. domain filtering) is NOT a stop signal.
    if (matched.length > 0 && newOnPage === 0) {
      break
    }
  }

  return buildSearxngWebSearchBlocks(request, results)
}

async function fetchSearxngPage(
  baseUrl: string,
  query: string,
  page: number,
  {
    signal,
    fetchFn,
  }: {
    signal: AbortSignal
    fetchFn: FetchLike
  },
): Promise<SearxngSearchResult[]> {
  const searchUrl = buildSearxngSearchUrl(baseUrl, query, page)
  const response = await fetchFn(searchUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': getSearxngUserAgent(),
    },
    signal,
  })

  if (!response.ok) {
    const body = (await safeReadText(response)).slice(0, 200)
    throw new SearxngRequestError(
      body.length > 0
        ? `SearXNG request failed (${response.status} ${response.statusText}): ${body}`
        : `SearXNG request failed (${response.status} ${response.statusText})`,
      response.status,
    )
  }

  const payload = (await response.json()) as SearxngSearchResponse
  return payload.results ?? []
}

function filterSearxngResults(
  results: SearxngSearchResult[],
  request: SearxngWebSearchRequest,
): SearxngSearchResult[] {
  return results.filter(result => {
    const url = typeof result.url === 'string' ? result.url.trim() : ''
    if (!url) {
      return false
    }

    let hostname: string
    try {
      hostname = new URL(url).hostname.toLowerCase()
    } catch {
      return false
    }

    if (
      request.allowedDomains?.length &&
      !request.allowedDomains.some(domain => hostMatchesDomain(hostname, domain))
    ) {
      return false
    }

    if (
      request.blockedDomains?.some(domain => hostMatchesDomain(hostname, domain))
    ) {
      return false
    }

    return true
  })
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.trim().toLowerCase().replace(/^\.+/, '')
  if (!normalizedDomain) {
    return false
  }

  return (
    hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
  )
}

function toBetaWebSearchResult(
  result: SearxngSearchResult,
): BetaWebSearchResultBlock | undefined {
  const url = typeof result.url === 'string' ? result.url.trim() : ''
  if (!url) {
    return undefined
  }

  const title =
    typeof result.title === 'string' && result.title.trim().length > 0
      ? result.title.trim()
      : url

  return {
    encrypted_content: normalizeSnippet(result.content),
    page_age:
      typeof result.publishedDate === 'string' && result.publishedDate.trim()
        ? result.publishedDate.trim()
        : null,
    title,
    type: 'web_search_result',
    url,
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return match
        }
      }
      return match
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function normalizeSnippet(content: string | null | undefined): string {
  if (typeof content !== 'string') {
    return ''
  }

  // SearXNG engines return snippets containing HTML markup and entities
  // (highlight spans, <b> tags, &amp; ...). Strip tags first so entity
  // decoding doesn't resurrect tag-like text, then decode and collapse.
  const normalized = decodeHtmlEntities(
    content.replace(/<[^>]*>/g, ' '),
  )
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= SNIPPET_MAX_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…`
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function getSearxngUserAgent(): string {
  try {
    return getUserAgent()
  } catch {
    return 'claudium-searxng'
  }
}