const usage = { name: 'usage', type: 'local' as const, isEnabled: () => false, isHidden: true, load: () => import('./usage.js') }
export default usage
