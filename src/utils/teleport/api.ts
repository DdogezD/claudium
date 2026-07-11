/**
 * Stub: OAuth has been stripped. Teleport/remote session API is unavailable.
 */

export const CCR_BYOC_BETA = ''

export function isTransientNetworkError(_error: unknown): boolean {
  return false
}

export async function axiosGetWithRetry<T>(): Promise<T | null> {
  return null
}

export type SessionStatus = 'requires_action' | 'running' | 'idle' | 'archived'
export type GitSource = { type: 'git'; repository: string; branch: string }
export type KnowledgeBaseSource = { type: 'knowledge_base' }
export type SessionContextSource = GitSource | KnowledgeBaseSource
export type OutcomeGitInfo = { repository: string; branch: string }
export type GitRepositoryOutcome = { git: OutcomeGitInfo }
export type Outcome = GitRepositoryOutcome
export type SessionContext = {
  source: SessionContextSource
  outcomes?: Outcome[]
  current_step?: string
  current_step_goal?: string
}
export type SessionResource = {
  id: string
  display_id: string
  status: SessionStatus
  updated_at: string
  title?: string
  model?: string
  outcome?: string
  environment_id?: string
}
export type ListSessionsResponse = {
  data: SessionResource[]
  has_more: boolean
}

export async function prepareApiRequest(): Promise<never> {
  throw new Error('OAuth has been stripped. Set ANTHROPIC_API_KEY instead.')
}

export async function fetchCodeSessionsFromSessionsAPI(): Promise<
  SessionResource[]
> {
  return []
}

export function getOAuthHeaders(_accessToken: string): Record<string, string> {
  return {}
}

export async function fetchSession(): Promise<null> {
  return null
}

export function getBranchFromSession(): string | null {
  return null
}

export async function updateSessionTitle(): Promise<void> {}

export async function sendEventToRemoteSession(): Promise<void> {}

