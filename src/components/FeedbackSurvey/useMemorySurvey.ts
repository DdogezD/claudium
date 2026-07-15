export function useMemorySurvey() {
  return { state: 'closed' as const, lastResponse: null, handleSelect: () => {}, handleTranscriptSelect: () => {} }
}
