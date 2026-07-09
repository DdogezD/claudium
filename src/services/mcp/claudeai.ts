/**
 * Stub: OAuth has been stripped. Claude.ai MCP servers are unavailable.
 */

import type { ScopedMcpServerConfig } from './types.js'

export async function fetchClaudeAIMcpConfigsIfEligible(): Promise<Record<string, ScopedMcpServerConfig>> {
  return {}
}

export function markClaudeAiMcpConnected(): void {}

export function clearClaudeAIMcpConfigsCache(): void {}

export function hasClaudeAiMcpEverConnected(): boolean {
  return false
}


