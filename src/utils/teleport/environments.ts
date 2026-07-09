/**
 * Stub: OAuth has been stripped. Remote environments are unavailable.
 */

export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
export type EnvironmentState = 'active'
export type ANTHROPIC_CLOUD_REGION = 'us-east'

export type EnvironmentResource = {
  id: string
  name: string
  kind: EnvironmentKind
  state: EnvironmentState
  region: ANTHROPIC_CLOUD_REGION | string
}

export async function fetchEnvironments(): Promise<EnvironmentResource[]> {
  return []
}

export type EnvironmentSelectionInfo = {
  availableEnvironments: EnvironmentResource[]
  defaultEnvironmentId: string | null
}

export function getEnvironmentSelectionInfo(): EnvironmentSelectionInfo {
  return { availableEnvironments: [], defaultEnvironmentId: null }
}
