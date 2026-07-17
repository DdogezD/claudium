/**
 * Resolve a plugin or skill model override to the active main-loop model.
 * Plugin and skill model fields are compatibility metadata, not model selectors.
 */
export function resolveFrontmatterModel(
  rawModel: string | null | undefined,
  activeModel: string,
): string | undefined {
  return rawModel?.trim() ? activeModel : undefined
}
