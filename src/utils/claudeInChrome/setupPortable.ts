export const CHROME_EXTENSION_URL = ''

export type ChromiumBrowser =
  | 'chrome'
  | 'brave'
  | 'arc'
  | 'chromium'
  | 'edge'
  | 'vivaldi'
  | 'opera'

export type BrowserPath = {
  browser: ChromiumBrowser
  dir: string
}

export function getAllBrowserDataPathsPortable(): BrowserPath[] {
  return []
}

export async function detectExtensionInstallationPortable(
  browserPaths: BrowserPath[],
  extensionIds: string[],
): Promise<{ isInstalled: boolean; browser: ChromiumBrowser | null }> {
  return { isInstalled: false, browser: null }
}

export async function isChromeExtensionInstalledPortable(
  browserPaths: { browser: ChromiumBrowser; path: string }[],
  log?: (msg: string) => void,
): Promise<boolean> {
  return false
}

export async function isChromeExtensionInstalled(log?: { (...args: any[]): void }): Promise<boolean> {
  return false
}
