import type { ZodError } from 'zod/v4'

/**
 * Sets a nested value in an object given a path array.
 * e.g., setNestedValue(obj, ['a', 0, 'b'], 'val')
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: PropertyKey[],
  value: unknown,
): void {
  if (path.length === 0) return
  let current: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]!)
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[String(path[path.length - 1]!)] = value
}

/**
 * Gets a nested value given a path array.
 */
function getNestedValue(
  obj: Record<string, unknown>,
  path: PropertyKey[],
): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[String(key)]
  }
  return current
}

/**
 * Removes keys with null values from the input.
 * Handles the pattern where models send `null` for optional fields instead of omitting them.
 */
function stripNulls(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let changed = false
  for (const key of Object.keys(input)) {
    if (input[key] === null) {
      changed = true
    } else {
      result[key] = input[key]
    }
  }
  return changed ? result : input
}

/**
 * Unwraps markdown auto-links in string values.
 * Matches patterns like [notes.md](http://notes.md) where the link text
 * is a plausible path and the URL is an http link containing the same name.
 * Real markdown links like [click](https://x.com) pass through untouched.
 */
function unwrapMarkdownLinksInStrings(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...input }
  let changed = false

  for (const key of Object.keys(result)) {
    const value = result[key]
    if (typeof value !== 'string') continue

    // Match [text](url) where text looks like a filename/path and url is an http link
    // Only unwrap when the text equals the url without protocol (degenerate auto-link case)
    const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
    let newValue = value
    let match: RegExpExecArray | null
    let localChanged = false

    while ((match = markdownLinkRegex.exec(value)) !== null) {
      const linkText = match[1]!
      const linkUrl = match[2]!

      // Only unwrap if: link text doesn't contain markdown, url is http/https,
      // and the degenerate case applies (link text === url without protocol prefix)
      // This preserves real markdown like [click here](https://example.com)
      if (
        linkUrl.startsWith('http://') || linkUrl.startsWith('https://')
      ) {
        const urlWithoutProtocol = linkUrl.replace(/^https?:\/\//, '')
        // Degenerate case: the visible text is the same as the URL path
        const isDegenerate =
          linkText === urlWithoutProtocol ||
          linkText === linkUrl

        if (isDegenerate) {
          // Replace just this occurrence
          newValue = newValue.replace(match[0], linkText)
          localChanged = true
        }
      }
    }

    if (localChanged) {
      result[key] = newValue
      changed = true
    }
  }

  return changed ? result : input
}

/**
 * Where Zod expected an array but received a string, attempt JSON.parse.
 * Handles '["a","b"]' → ["a","b"].
 */
function parseJsonStringArrays(
  input: Record<string, unknown>,
  issues: ZodError['issues'],
): Record<string, unknown> {
  const result = { ...input }
  let changed = false

  // Collect issue paths where expected=array, received=string
  const arrayIssuePaths = new Set<string>()
  for (const issue of issues) {
    if (
      issue.code === 'invalid_type' &&
      'expected' in issue &&
      issue.expected === 'array' &&
      'received' in issue &&
      issue.received === 'string'
    ) {
      const pathKey = issue.path.map(String).join('.')
      arrayIssuePaths.add(pathKey)
    }
  }

  if (arrayIssuePaths.size === 0) return input

  for (const pathKey of arrayIssuePaths) {
    const pathParts = pathKey ? pathKey.split('.') : []
    const value = pathParts.length > 0
      ? getNestedValue(result, pathParts)
      : undefined

    if (typeof value !== 'string') continue

    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        if (pathParts.length > 0) {
          setNestedValue(result, pathParts, parsed)
        }
        changed = true
      }
    } catch {
      // Not valid JSON, leave for wrapBareStrings step
    }
  }

  return changed ? result : input
}

/**
 * Where Zod expected an array but received a string (not JSON-parseable),
 * wrap the bare string in an array: "foo" → ["foo"].
 * Must run AFTER parseJsonStringArrays so '["a","b"]' doesn't become ['["a","b"]'].
 */
function wrapBareStringsInArrays(
  input: Record<string, unknown>,
  issues: ZodError['issues'],
): Record<string, unknown> {
  const result = { ...input }
  let changed = false

  for (const issue of issues) {
    if (
      issue.code === 'invalid_type' &&
      'expected' in issue &&
      issue.expected === 'array' &&
      'received' in issue &&
      issue.received === 'string'
    ) {
      const pathKey = issue.path.map(String).join('.')
      const pathParts = pathKey ? pathKey.split('.') : []
      const value = pathParts.length > 0
        ? getNestedValue(result, pathParts)
        : undefined

      if (typeof value !== 'string') continue

      // Don't wrap if it looks like JSON (already handled by parseJsonStringArrays)
      if (value.trim().startsWith('[') || value.trim().startsWith('{')) continue

      if (pathParts.length > 0) {
        setNestedValue(result, pathParts, [value])
        changed = true
      }
    }
  }

  return changed ? result : input
}

/**
 * Known field name aliases that open models commonly emit instead of the
 * correct Anthropic tool schema names. Maps model-emitted names → schema names.
 *
 * Models trained on non-Anthropic tool distributions (OpenAI function calling,
 * custom harnesses, etc.) use their own naming conventions. The model knows
 * WHAT field to provide — it just hasn't memorized the exact JSON contract
 * Anthropic happened to pick.
 */
const FIELD_ALIASES: Record<string, string> = {
  // Read tool — unambiguous foreign-key patterns
  absolutePath: 'file_path',
  filePath: 'file_path',

  // Write tool
  contents: 'content',

  // Edit tool — camelCase variants of snake_case originals
  oldStr: 'old_string',
  oldString: 'old_string',
  newStr: 'new_str',
  newString: 'new_str',
  replaceWith: 'new_str',

  // Grep/Glob tool — domain-specific aliases
  regex: 'pattern',
  searchPattern: 'pattern',
  globPattern: 'pattern',

  // Bash tool
  cmd: 'command',

  // NotebookEdit tool
  notebookPath: 'notebook_path',
  absoluteNotebookPath: 'notebook_path',

  // Agent tools
  agentId: 'agent_id',
  subagentType: 'subagent_type',
  taskId: 'task_id',
  agentType: 'agent_type',
}

/**
 * Where Zod reports unrecognized keys AND missing required fields, attempt to
 * remap unknown keys to the correct schema names using known aliases.
 *
 * Only remaps when the validator explicitly complains about BOTH an unrecognized
 * key and a missing required field — this avoids accidental renames on inputs
 * that happen to have extra keys but aren't missing anything.
 */
function renameUnrecognizedKeys(
  input: Record<string, unknown>,
  issues: ZodError['issues'],
): Record<string, unknown> {
  // Collect unrecognized keys
  const unrecognizedKeys = new Set<string>()
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys' && 'keys' in issue) {
      for (const key of (issue as { keys: string[] }).keys) {
        unrecognizedKeys.add(key)
      }
    }
  }
  if (unrecognizedKeys.size === 0) return input

  // Collect missing required fields (only at root path — nested are too ambiguous)
  const missingRequired = new Set<string>()
  for (const issue of issues) {
    if (
      issue.code === 'invalid_type' &&
      'received' in issue &&
      issue.received === 'undefined' &&
      'path' in issue &&
      issue.path.length === 1
    ) {
      missingRequired.add(String(issue.path[0]))
    }
  }
  if (missingRequired.size === 0) return input

  // Try to match unrecognized keys to missing required fields via alias map
  const result = { ...input }
  let changed = false

  for (const unknownKey of unrecognizedKeys) {
    const canonicalKey = FIELD_ALIASES[unknownKey]
    if (canonicalKey && missingRequired.has(canonicalKey)) {
      result[canonicalKey] = result[unknownKey]
      delete result[unknownKey]
      changed = true
    }
  }

  return changed ? result : input
}

export type RepairResult = {
  repaired: Record<string, unknown>
  repairs: string[]
}

/**
 * Attempts to repair tool input that failed Zod validation.
 *
 * The validate-then-repair pattern:
 * 1. Parse the input as-is. If it succeeds, ship it — valid inputs are never touched.
 * 2. On failure, walk the validator's issue list. For each issue path, try
 *    repairs in order until one applies.
 * 3. Each repair is applied, then the result is re-tested by the caller.
 *
 * Repair order is critical: json-array-parse must run before bare-string-wrap,
 * or '["a","b"]' becomes ['["a","b"]'].
 */
export function repairToolInput(
  input: Record<string, unknown>,
  _error: ZodError,
  _toolName: string,
): RepairResult | null {
  let current = { ...input }
  const repairs: string[] = []

  // 0. Rename unrecognized keys to canonical names (MUST run first — other
  //    repairs operate on values at known key paths; wrong key names defeat them)
  const withRenamedKeys = renameUnrecognizedKeys(current, _error.issues)
  if (withRenamedKeys !== current) {
    repairs.push('renamed_unrecognized_keys')
    current = withRenamedKeys
  }

  // 1. Strip null values (null for optional)
  const withoutNulls = stripNulls(current)
  if (withoutNulls !== current) {
    repairs.push('stripped_null_values')
    current = withoutNulls
  }

  // 2. Unwrap markdown auto-links in string values
  const withoutLinks = unwrapMarkdownLinksInStrings(current)
  if (withoutLinks !== current) {
    repairs.push('unwrapped_markdown_links')
    current = withoutLinks
  }

  // 3. Parse JSON-stringified arrays (MUST run before bare string wrap)
  const withParsedArrays = parseJsonStringArrays(current, _error.issues)
  if (withParsedArrays !== current) {
    repairs.push('parsed_json_string_arrays')
    current = withParsedArrays
  }

  // 4. Wrap bare strings in arrays
  const withBareStrings = wrapBareStringsInArrays(current, _error.issues)
  if (withBareStrings !== current) {
    repairs.push('wrapped_bare_strings_in_arrays')
    current = withBareStrings
  }

  return repairs.length > 0 ? { repaired: current, repairs } : null
}
