// Fast mode stripped — all stubs return disabled/inactive defaults
import { createSignal } from './signal.js'

export function isFastModeEnabled(): boolean { return false }
export function isFastModeAvailable(): boolean { return false }
export function getFastModeUnavailableReason(): string | null { return null }
export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.6'
export function getFastModeModel(): string { return '' }
export function getInitialFastModeSetting(_model: unknown): boolean { return false }
export function isFastModeSupportedByModel(): boolean { return false }
export type FastModeRuntimeState = { cooldownRemaining: number | null; cooldownReason: string | null; overloaded: boolean }
export type CooldownReason = 'rate_limit' | 'overloaded'
export const onCooldownTriggered = createSignal<[number, CooldownReason]>().subscribe
export const onCooldownExpired = createSignal().subscribe
export function getFastModeRuntimeState(): FastModeRuntimeState { return { cooldownRemaining: null, cooldownReason: null, overloaded: false } }
export function triggerFastModeCooldown() {}
export function clearFastModeCooldown() {}
export function handleFastModeRejectedByAPI() {}
export const onFastModeOverageRejection = createSignal<[string]>().subscribe
export function handleFastModeOverageRejection(_reason: string | null) {}
export function isFastModeCooldown(): boolean { return false }
export function getFastModeState(
  _model: unknown,
  _settingsFastMode: boolean,
  _isFirstTurn: boolean,
): { fastMode: boolean; fastModeModel: string | null; fastModeReason: string | null; fastModePricing: string | null } {
  return { fastMode: false, fastModeModel: null, fastModeReason: null, fastModePricing: null }
}
export type FastModeDisabledReason = 'free' | 'preference' | 'extra_usage_disabled' | 'network_error' | 'unknown'
export const onOrgFastModeChanged = createSignal<[boolean]>().subscribe
export function resolveFastModeStatusFromCache(): void {}
