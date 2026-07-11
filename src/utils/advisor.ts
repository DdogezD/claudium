// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getAdvisorModel(): string | undefined {
  return process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() || undefined
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
