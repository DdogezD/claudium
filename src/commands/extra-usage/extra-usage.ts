// Anthropic extra-usage command stripped
export async function call(): Promise<{ type: 'message'; value: string }> {
  return { type: 'message', value: 'Extra usage requires ANTHROPIC_API_KEY configuration.' }
}
