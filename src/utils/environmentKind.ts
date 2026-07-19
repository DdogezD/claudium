type EnvironmentKind = 'byoc' | 'anthropic_cloud'

/**
 * Get the environment kind from CLAUDE_CODE_ENVIRONMENT_KIND.
 * Returns null if not set or not a recognized value.
 * Migrated from filePersistence/outputsScanner.ts.
 */
export function getEnvironmentKind(): EnvironmentKind | null {
  const kind = process.env.CLAUDE_CODE_ENVIRONMENT_KIND
  if (kind === 'byoc' || kind === 'anthropic_cloud') {
    return kind
  }
  return null
}
