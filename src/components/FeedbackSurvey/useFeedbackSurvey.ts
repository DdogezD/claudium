export function useFeedbackSurvey() {
  return { state: 'closed' as const, lastResponse: null, handleSelect: () => {}, handleTranscriptSelect: () => {} }
}
