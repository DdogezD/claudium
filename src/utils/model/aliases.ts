// Model family aliases are intentionally unsupported. Configure an explicit model ID.

const LEGACY_MODEL_ALIAS_PATTERN = /^(?:sonnet|opus|haiku)(?:\[1m\])?$/

export function isLegacyModelAlias(model: string): boolean {
  return LEGACY_MODEL_ALIAS_PATTERN.test(model.trim().toLowerCase())
}
