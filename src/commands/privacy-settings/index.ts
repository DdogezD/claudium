const privacySettings = { name: 'privacy-settings', type: 'local-jsx' as const, isEnabled: () => false, isHidden: true, load: () => import('./privacy-settings.js') }
export default privacySettings
