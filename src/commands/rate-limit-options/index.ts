const rateLimitOptions = { name: 'rate-limit-options', type: 'local-jsx' as const, isEnabled: () => false, isHidden: true, load: () => import('./rate-limit-options.js') }
export default rateLimitOptions
