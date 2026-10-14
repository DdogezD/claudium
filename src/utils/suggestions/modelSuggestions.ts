import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { ModelOption } from '../model/modelOptions.js'

export type ModelCompletionToken = {
  start: number
  end: number
  query: string
}

export function getModelCompletionToken(
  input: string,
  cursorOffset: number,
): ModelCompletionToken | null {
  const match = /^\/model([ \t]+)([^\s]*)/.exec(input)
  if (!match) return null
  const start = '/model'.length + match[1]!.length
  const end = start + match[2]!.length
  if (cursorOffset < start || cursorOffset > end) return null
  return { start, end, query: input.slice(start, cursorOffset) }
}

export function generateModelSuggestions(
  options: readonly ModelOption[],
  query: string,
): SuggestionItem[] {
  const search = query.toLowerCase()
  const suggestions: SuggestionItem[] = []
  const seen = new Set<string>()
  for (const option of options) {
    if (option.value === null) continue
    const id = option.value
    if (!id || id.length > 512 || /[\s\p{Cc}\p{Cf}]/u.test(id) || seen.has(id)) continue
    if (!id.toLowerCase().includes(search)) continue
    seen.add(id)
    suggestions.push({
      id,
      displayText: id,
    })
  }
  return suggestions.sort((a, b) =>
    Number(b.id.toLowerCase() === search) - Number(a.id.toLowerCase() === search)
    || Number(b.id.toLowerCase().startsWith(search)) - Number(a.id.toLowerCase().startsWith(search)),
  )
}

export function applyModelSuggestion(
  input: string,
  cursorOffset: number,
  model: string,
): { newInput: string; cursorPos: number } | null {
  const token = getModelCompletionToken(input, cursorOffset)
  if (!token) return null
  const suffix = input.slice(token.end)
  const separator = suffix.length === 0 ? ' ' : ''
  return {
    newInput: input.slice(0, token.start) + model + separator + suffix,
    cursorPos: token.start + model.length + separator.length,
  }
}
