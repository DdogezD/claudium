/**
 * Stub: Bedrock support has been stripped.
 */

export const getBedrockInferenceProfiles = async function (): Promise<string[]> {
  return []
}

export function findFirstMatch(): string | null {
  return null
}

export async function createBedrockRuntimeClient(): Promise<null> {
  return null
}

export const getInferenceProfileBackingModel = async function (): Promise<string | null> {
  return null
}

export function isFoundationModel(_modelId: string): boolean {
  return false
}

export function extractModelIdFromArn(_modelId: string): string {
  return ''
}

export type BedrockRegionPrefix = string

export function getBedrockRegionPrefix(): BedrockRegionPrefix | null {
  return null
}

export function applyBedrockRegionPrefix(_modelId: string): string {
  return _modelId
}
