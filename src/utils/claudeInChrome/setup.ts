export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  return false
}

export function shouldAutoEnableClaudeInChrome(): boolean {
  return false
}

export function setupClaudeInChrome(): {
  mcpConfig: Record<string, any>
  allowedTools: string[]
  systemPrompt: string
} {
  return { mcpConfig: {}, allowedTools: [], systemPrompt: '' }
}

export async function installChromeNativeHostManifest(manifestBinaryPath: string): Promise<void> {}

export async function isChromeExtensionInstalled(): Promise<boolean> {
  return false
}
