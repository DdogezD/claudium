const resetLimits = { name: 'reset-limits', type: 'local' as const, isEnabled: () => false, isHidden: true }
export default resetLimits
export function resetLimits() { return null }
export function resetLimitsNonInteractive() { return null }
