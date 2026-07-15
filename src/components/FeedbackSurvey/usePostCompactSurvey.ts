export function usePostCompactSurvey() {
  return { state: 'closed' as const, lastResponse: null, handleSelect: () => {} }
}
