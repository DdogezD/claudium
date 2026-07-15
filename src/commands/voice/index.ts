const voice = { name: 'voice', type: 'local' as const, isEnabled: () => false, isHidden: true, load: () => import('./voice.js') }
export default voice
