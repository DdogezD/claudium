/**
 * HTTP utility constants and helpers
 */

import axios from 'axios'
import { getAnthropicApiKey } from './auth.js'
import { getClaudeCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

export function getUserAgent(): string {
  return getClaudeCodeUserAgent()
}

export function getMCPUserAgent(): string {
  return `${getClaudeCodeUserAgent()} MCP/1.0`
}

export function getWebFetchUserAgent(): string {
  const workload = getWorkload()
  return `ClaudeCodeFetch/${workload}`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Get authentication headers for API requests using API key auth.
 * OAuth path has been stripped.
 */
export function getAuthHeaders(): AuthHeaders {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      'x-api-key': apiKey,
    },
  }
}

/**
 * OAuth 401 retry has been stripped. Passes through to the request directly.
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  _opts?: { also403Revoked?: boolean },
): Promise<T> {
  return await request()
}
