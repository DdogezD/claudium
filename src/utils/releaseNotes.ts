// Release notes fetch stripped (Anthropic GitHub online service)
export async function fetchAndStoreChangelog(): Promise<void> {}
export async function checkForReleaseNotes(): Promise<{ hasReleaseNotes: boolean }> { return { hasReleaseNotes: false } }
export function getCachedChangelog(): string { return '' }
export function getLatestReleaseVersion(): string { return '' }
export function getRecentReleaseNotes() { return null }
export function getStoredChangelogFromMemory() { return null }
export function checkForReleaseNotesSync() { return { hasReleaseNotes: false } }
export async function migrateChangelogFromConfig(): Promise<void> {}
