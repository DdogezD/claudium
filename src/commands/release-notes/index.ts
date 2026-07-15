const releaseNotes = { name: 'release-notes', type: 'local' as const, isEnabled: () => false, isHidden: true, load: () => import('./release-notes.js') }
export default releaseNotes
