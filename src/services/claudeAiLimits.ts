export interface ClaudeAiLimits { }
export function useClaudeAiLimits() { return {} as any }
export function getRateLimitErrorMessage() { return '' }
export function isExtraUsageAllowed() { return false }
export function getRawUtilization() { return undefined }
export const currentLimits = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export function extractQuotaStatusFromError() { return null }
export function extractQuotaStatusFromHeaders() { return null }
export function getClaudeAiLimits() { return {} as any }
export function getRateLimitWarning() { return null }
export function getUsingOverageText() { return null }
export const statusListeners: Set<(limits: ClaudeAiLimits) => void> = new Set()
export async function checkQuotaStatus(): Promise<void> {}
