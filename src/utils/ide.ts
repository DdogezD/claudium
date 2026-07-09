/**
 * Stubbed: IDE detection/integration removed.
 */

import memoize from 'lodash-es/memoize.js'
import { env } from './env.js'
import { envDynamic } from './envDynamic.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { join } from 'path'

export type IdeType =
  | 'cursor'
  | 'windsurf'
  | 'vscode'

export type DetectedIDEInfo = {
  name: string
  port: number
  workspaceFolders: string[]
  url: string
  isValid: boolean
  authToken?: string
  ideRunningInWindows?: boolean
}

export interface IDEExtensionInstallationStatus {
  installed: boolean
  error: string | null
  installedVersion: string | null
  ideType: IdeType | null
}

export function isVSCodeIde(ide: IdeType | null): boolean {
  return false
}

export function isJetBrainsIde(ide: IdeType | null): boolean {
  return false
}

export const isSupportedVSCodeTerminal = memoize(() => false)

export const isSupportedJetBrainsTerminal = memoize(() => false)

export const isSupportedTerminal = memoize(() => false)

export function getTerminalIdeType(): IdeType | null {
  return null
}

export async function getSortedIdeLockfiles(): Promise<string[]> {
  return []
}

export async function getIdeLockfilesPaths(): Promise<string[]> {
  return [join(getClaudeConfigHomeDir(), 'ide')]
}

export async function cleanupStaleIdeLockfiles(): Promise<void> {}

export async function maybeInstallIDEExtension(
  _ideType: IdeType,
): Promise<IDEExtensionInstallationStatus | null> {
  return null
}

export async function findAvailableIDE(): Promise<DetectedIDEInfo | null> {
  return null
}

export async function detectIDEs(
  _includeInvalid: boolean,
): Promise<DetectedIDEInfo[]> {
  return []
}

export async function maybeNotifyIDEConnected(_client: any): Promise<void> {}

export function hasAccessToIDEExtensionDiffFeature(
  _mcpClients: any[],
): boolean {
  return false
}

export async function isIDEExtensionInstalled(
  _ideType: IdeType,
): Promise<boolean> {
  return false
}

export async function isCursorInstalled(): Promise<boolean> {
  return false
}

export async function isWindsurfInstalled(): Promise<boolean> {
  return false
}

export async function isVSCodeInstalled(): Promise<boolean> {
  return false
}

export async function detectRunningIDEs(): Promise<IdeType[]> {
  return []
}

export async function detectRunningIDEsCached(): Promise<IdeType[]> {
  return []
}

export function resetDetectRunningIDEs(): void {}

export function getConnectedIdeName(
  _mcpClients: any[],
): string | null {
  return null
}

export function getIdeClientName(
  _ideClient?: any,
): string | null {
  return null
}

export function toIDEDisplayName(_terminal: string | null): string {
  return 'IDE'
}

export function getConnectedIdeClient(
  _mcpClients?: any[],
): any | undefined {
  return undefined
}

export async function closeOpenDiffs(
  _ideClient: any,
): Promise<void> {}

export async function initializeIdeIntegration(
  _onIdeDetected: (ide: DetectedIDEInfo | null) => void,
  _ideToInstallExtension: IdeType | null,
  _onShowIdeOnboarding: () => void,
  _onInstallationComplete: (status: IDEExtensionInstallationStatus | null) => void,
): Promise<void> {}

export { callIdeRpc } from '../services/mcp/client.js'
