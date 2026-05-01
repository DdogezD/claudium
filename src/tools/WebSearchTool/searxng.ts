import type { ClientOptions } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaServerToolUseBlock,
  BetaWebSearchResultBlock,
  BetaWebSearchToolResultBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getUserAgent } from '../../utils/http.js'

export const SEARXNG_BASE_URL_ENV_VAR = 'CLAUDE_CODE_SEARXNG_BASE_URL'

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

export function buildSearxngSearchUrl(baseUrl: string, query: string): URL {
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
  return url
}

export function buildSearxngWebSearchBlocks(
  request: SearxngWebSearchRequest,
  results: SearxngSearchResult[],
  toolUseId = randomUUID(),
): BetaContentBlock[] {
  const serverToolUse: BetaServerToolUseBlock = {
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

  return [serverToolUse, resultBlock]
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

  const searchUrl = buildSearxngSearchUrl(baseUrl, request.query)
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
    throw new Error(
      body.length > 0
        ? `SearXNG request failed (${response.status} ${response.statusText}): ${body}`
        : `SearXNG request failed (${response.status} ${response.statusText})`,
    )
  }

  const payload = (await response.json()) as SearxngSearchResponse
  const filteredResults = filterSearxngResults(payload.results ?? [], request)
  return buildSearxngWebSearchBlocks(request, filteredResults)
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

function normalizeSnippet(content: string | null | undefined): string {
  if (typeof content !== 'string') {
    return ''
  }

  return content.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim()
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