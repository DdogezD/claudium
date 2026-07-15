export interface ExtraUsage { }
export interface RateLimit { }
export interface Utilization { }
export async function fetchUtilization(): Promise<{rate_limits: RateLimit[], utilization: Utilization}> {
  return { rate_limits: [], utilization: {} as Utilization }
}
export function getRawUtilization() { return undefined }
