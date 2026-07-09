/**
 * Stubbed: JetBrains plugin detection removed.
 */

export async function isJetBrainsPluginInstalled(_ideType: string): Promise<boolean> {
  return false
}

export async function isJetBrainsPluginInstalledCached(
  _ideType: string,
  _forceRefresh?: boolean,
): Promise<boolean> {
  return false
}

export function isJetBrainsPluginInstalledCachedSync(_ideType: string): boolean {
  return false
}
