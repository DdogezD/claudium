import { getCwd } from '../../cwd.js'
import { findGitRoot, getIsClean } from '../../git.js'

/**
 * Stub: OAuth stripped. Claude.ai login checks always return false.
 */
export async function checkNeedsClaudeAiLogin(): Promise<boolean> {
  return false
}

export async function checkIsGitClean(): Promise<boolean> {
  const isClean = await getIsClean({ ignoreUntracked: true })
  return isClean
}

export async function checkHasRemoteEnvironment(): Promise<boolean> {
  return false
}

export function checkIsInGitRepo(): boolean {
  return findGitRoot(getCwd()) !== null
}

export async function checkHasGitRemote(): Promise<boolean> {
  return false
}

export async function checkGithubAppInstalled(
  _owner: string,
  _repo: string,
  _signal?: AbortSignal,
): Promise<boolean> {
  return false
}

export async function checkGithubTokenSynced(): Promise<boolean> {
  return false
}

export async function checkRepoForRemoteAccess(
  _owner: string,
  _repo: string,
): Promise<{ hasAccess: boolean; method: 'github-app' | 'token-sync' | 'none' }> {
  return { hasAccess: false, method: 'none' }
}
