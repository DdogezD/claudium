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
