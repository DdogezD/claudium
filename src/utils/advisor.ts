// ---------------------------------------------------------------------------
// Types and isAdvisorBlock — retained for stripAdvisorBlocks (called from claude.ts)
// ---------------------------------------------------------------------------

export type AdvisorBlock =
  | { type: 'server_tool_use'; id: string; name: 'advisor'; input: { [key: string]: unknown } }
  | {
      type: 'advisor_tool_result'
      tool_use_id: string
      content:
        | { type: 'advisor_result'; text: string }
        | { type: 'advisor_redacted_result'; encrypted_content: string }
        | { type: 'advisor_tool_result_error'; error_code: string }
    }

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getAdvisorModel(): string | undefined {
  const fromEnv = process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim()
  if (fromEnv) return fromEnv
  // Fall back to settings (set via /advisor command)
  try {
    const { getInitialSettings } =
      require('./settings/settings.js') as typeof import('./settings/settings.js')
    return getInitialSettings().advisorModel
  } catch {
    return undefined
  }
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
