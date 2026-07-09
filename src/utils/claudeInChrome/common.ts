import type { ChromiumBrowser } from './setupPortable.js'

export type { ChromiumBrowser } from './setupPortable.js'

export const CLAUDE_IN_CHROME_MCP_SERVER_NAME = ''

export const CHROMIUM_BROWSERS: Record<string, any> = {}
export const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = []

export function getAllBrowserDataPaths(): { browser: ChromiumBrowser; path: string }[] {
  return []
}

export function getAllNativeMessagingHostsDirs(): { browser: ChromiumBrowser; path: string }[] {
  return []
}

export function getAllWindowsRegistryKeys(): { browser: ChromiumBrowser; key: string }[] {
  return []
}

export async function detectAvailableBrowser(): Promise<ChromiumBrowser | null> {
  return null
}

export function isClaudeInChromeMCPServer(name: string): boolean {
  return false
}

export function trackClaudeInChromeTabId(tabId: number): void {}

export function isTrackedClaudeInChromeTabId(tabId: number): boolean {
  return false
}

export async function openInChrome(url: string): Promise<boolean> {
  return false
}

export function getSocketDir(): string {
  return ''
}

export function getSecureSocketPath(): string {
  return ''
}

export function getAllSocketPaths(): string[] {
  return []
}
