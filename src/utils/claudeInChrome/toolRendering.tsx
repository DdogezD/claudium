import * as React from 'react';
import type { MCPToolResult } from '../mcpValidation.js';

export type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ChromeToolName = string;

export function renderChromeToolResultMessage(output: MCPToolResult, toolName: ChromeToolName, verbose: boolean): React.ReactNode {
  return null;
}

export function getClaudeInChromeMCPToolOverrides(toolName: string): { renderToolUseMessage: (input: Record<string, unknown>, verbose: boolean) => React.ReactNode } | undefined {
  return undefined;
}
