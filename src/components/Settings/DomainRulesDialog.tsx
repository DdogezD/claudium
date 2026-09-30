import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { compileMatchPattern } from '../../tools/WebSearchTool/matchPattern.js'
import TextInput from '../TextInput.js'

// Raw settings-shaped lists, as read from settings.json.
export type DomainRuleLists = {
  searchAllowed: string[]
  searchBlocked: string[]
  fetchAllow: string[]
  fetchDeny: string[]
  sandboxAllowed: string[]
}

export type DomainRuleMode = 'blocklist' | 'allowlist'

// What the dialog reports: ONE rule list per group plus the mode that
// gives it meaning. Mapping mode+list to concrete settings keys is the
// caller's job — the UI never exposes two parallel lists.
export type DomainRulesResult = {
  search: { mode: DomainRuleMode; rules: string[] }
  fetch: { mode: DomainRuleMode; rules: string[] }
  sandbox: { rules: string[] }
}

// Collapse the raw settings lists into the single-list-per-group model.
// When both sides are populated (hand-edited settings), the allowlist
// wins for web search (it is the hard ceiling at runtime) and the
// blocklist wins for web fetch (losing deny rules silently is worse).
export function deriveDomainRules(lists: DomainRuleLists): DomainRulesResult {
  return {
    search:
      lists.searchAllowed.length > 0
        ? { mode: 'allowlist', rules: lists.searchAllowed }
        : { mode: 'blocklist', rules: lists.searchBlocked },
    fetch:
      lists.fetchDeny.length > 0
        ? { mode: 'blocklist', rules: lists.fetchDeny }
        : lists.fetchAllow.length > 0
          ? { mode: 'allowlist', rules: lists.fetchAllow }
          : { mode: 'blocklist', rules: [] },
    sandbox: { rules: lists.sandboxAllowed },
  }
}

type GroupKey = 'websearch' | 'webfetch' | 'sandbox'

type Group = {
  key: GroupKey
  title: string
  placeholder: string
  validate: (rule: string, existing: string[]) => string | null
  modeLabel?: Record<DomainRuleMode, string>
}

function baseRuleError(rule: string, existing: string[]): string | null {
  const trimmed = rule.trim()
  if (!trimmed) return 'Rule cannot be empty'
  if (existing.includes(trimmed)) return 'Rule already exists'
  return null
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

const GROUPS: Group[] = [
  {
    key: 'websearch',
    title: 'Web Search',
    placeholder: 'example.com or *://*.example.com/path/*',
    modeLabel: {
      blocklist: 'Allow all except blocked',
      allowlist: 'Allow only listed domains',
    },
    validate(rule, existing) {
      const base = baseRuleError(rule, existing)
      if (base) return base
      const trimmed = rule.trim()
      if (trimmed.includes('://')) {
        return compileMatchPattern(trimmed) === null
          ? 'Invalid match pattern (expected e.g. *://*.example.com/path/*)'
          : null
      }
      return DOMAIN_RE.test(trimmed) ? null : 'Invalid domain'
    },
  },
  {
    key: 'webfetch',
    title: 'Web Fetch',
    placeholder: 'example.com or *.example.com',
    modeLabel: {
      blocklist: 'Block listed domains (others will ask)',
      allowlist: 'Always allow listed domains (others will ask)',
    },
    validate(rule, existing) {
      const base = baseRuleError(rule, existing)
      if (base) return base
      const trimmed = rule.trim()
      if (trimmed.includes('://') || trimmed.includes('/')) {
        return 'Domains only — e.g. example.com or *.example.com'
      }
      const body = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed
      return DOMAIN_RE.test(body) ? null : 'Invalid domain'
    },
  },
  {
    key: 'sandbox',
    title: 'Sandbox',
    placeholder: 'example.com',
    validate(rule, existing) {
      const base = baseRuleError(rule, existing)
      if (base) return base
      const trimmed = rule.trim()
      if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes('*')) {
        return 'Plain domains only — e.g. example.com'
      }
      return DOMAIN_RE.test(trimmed) ? null : 'Invalid domain'
    },
  },
]

type Row =
  | { type: 'entry'; index: number }
  | { type: 'add' }
  | { type: 'done' }

type Props = {
  initial: DomainRuleLists
  onComplete: (result: DomainRulesResult) => void
  onCancel: () => void
}

export function DomainRulesDialog({
  initial,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const derived = deriveDomainRules(initial)
  const [rules, setRules] = useState<Record<GroupKey, string[]>>({
    websearch: derived.search.rules,
    webfetch: derived.fetch.rules,
    sandbox: derived.sandbox.rules,
  })
  const [modes, setModes] = useState<Record<'websearch' | 'webfetch', DomainRuleMode>>({
    websearch: derived.search.mode,
    webfetch: derived.fetch.mode,
  })
  const [groupIndex, setGroupIndex] = useState(0)
  const [selectedRow, setSelectedRow] = useState(0)
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)
  const [editText, setEditText] = useState('')
  const [editOffset, setEditOffset] = useState(0)
  const [editError, setEditError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  const group = GROUPS[groupIndex]!
  const entries = rules[group.key]

  const rows: Row[] = [
    ...entries.map((_, index): Row => ({ type: 'entry', index })),
    { type: 'add' },
    { type: 'done' },
  ]
  const clampedSelected = Math.min(selectedRow, rows.length - 1)
  const currentRow = rows[clampedSelected]

  // Esc closes the dialog (discards) — only when not editing a rule.
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
    isActive: editing === null,
  })

  function startEdit(index: number | null): void {
    const initialText = index === null ? '' : entries[index]!
    setEditing({ index })
    setEditText(initialText)
    setEditOffset(initialText.length)
    setEditError(null)
  }

  function commitEdit(): void {
    if (!editing) return
    const existing = entries.filter((_, i) => i !== editing.index)
    const error = group.validate(editText, existing)
    if (error) {
      setEditError(error)
      return
    }
    const trimmed = editText.trim()
    const next =
      editing.index === null
        ? [...entries, trimmed]
        : entries.map((e, i) => (i === editing.index ? trimmed : e))
    setRules(prev => ({ ...prev, [group.key]: next }))
    setEditing(null)
  }

  function switchGroup(delta: -1 | 1): void {
    setGroupIndex(prev => (prev + delta + GROUPS.length) % GROUPS.length)
    setSelectedRow(0)
  }

  function toggleMode(): void {
    if (!group.modeLabel) return
    const key = group.key as 'websearch' | 'webfetch'
    setModes(prev => ({
      ...prev,
      [key]: prev[key] === 'allowlist' ? 'blocklist' : 'allowlist',
    }))
  }

  useInput((input, key) => {
    if (!isTerminalFocused) return

    // While editing, TextInput owns all keys except Esc (cancel edit).
    if (editing) {
      if (key.escape) {
        setEditing(null)
      }
      return
    }

    if (key.leftArrow) {
      switchGroup(-1)
    } else if (key.rightArrow) {
      switchGroup(1)
    } else if (key.tab) {
      toggleMode()
    } else if (key.upArrow) {
      setSelectedRow(prev => (prev - 1 + rows.length) % rows.length)
    } else if (key.downArrow) {
      setSelectedRow(prev => (prev + 1) % rows.length)
    } else if (input === 'd' && currentRow?.type === 'entry') {
      setRules(prev => ({
        ...prev,
        [group.key]: entries.filter((_, i) => i !== currentRow.index),
      }))
      setSelectedRow(prev => Math.min(prev, rows.length - 2))
    } else if (key.return) {
      if (!currentRow) return
      if (currentRow.type === 'entry') {
        startEdit(currentRow.index)
      } else if (currentRow.type === 'add') {
        startEdit(null)
      } else {
        onComplete({
          search: { mode: modes.websearch, rules: rules.websearch },
          fetch: { mode: modes.webfetch, rules: rules.webfetch },
          sandbox: { rules: rules.sandbox },
        })
      }
    }
  })

  function renderEditBox(): React.ReactNode {
    return (
      <Box flexDirection="column">
        <TextInput
          value={editText}
          onChange={v => {
            setEditText(v)
            setEditError(null)
          }}
          onSubmit={commitEdit}
          focus={isTerminalFocused}
          showCursor={isTerminalFocused}
          placeholder={group.placeholder}
          columns={50}
          cursorOffset={editOffset}
          onChangeCursorOffset={setEditOffset}
        />
        {editError && <Text color="error">{editError}</Text>}
      </Box>
    )
  }

  const mode = group.modeLabel
    ? modes[group.key as 'websearch' | 'webfetch']
    : undefined

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Domain rules</Text>
      <Box gap={2}>
        {GROUPS.map((g, i) => (
          <Text
            key={g.key}
            bold={i === groupIndex}
            color={i === groupIndex ? 'suggestion' : 'subtle'}
          >
            {i === groupIndex ? `‹ ${g.title} ›` : `  ${g.title}  `}
          </Text>
        ))}
      </Box>
      <Box gap={1}>
        <Text dimColor>Mode</Text>
        {group.modeLabel ? (
          <>
            {(Object.keys(group.modeLabel) as DomainRuleMode[]).map(m => {
              const active = m === mode
              return (
                <Text
                  key={m}
                  bold={active}
                  color={active ? 'suggestion' : 'subtle'}
                >
                  {active ? `‹ ${group.modeLabel![m]} ›` : ` ${group.modeLabel![m]} `}
                </Text>
              )
            })}
            <Text dimColor>(tab)</Text>
          </>
        ) : (
          <Text>Allow only listed domains</Text>
        )}
      </Box>
      <Box flexDirection="column">
        <Text dimColor>Rules</Text>
        {entries.length === 0 && <Text dimColor>  (none)</Text>}
        {entries.map((entry, index) => {
          const isSelected = index === clampedSelected && editing === null
          const isEditingThis = editing !== null && editing.index === index
          return (
            <Box key={index} gap={1}>
              <Text>{isSelected ? figures.pointer : ' '}</Text>
              {isEditingThis ? (
                renderEditBox()
              ) : (
                <Text color={isSelected ? 'suggestion' : undefined}>
                  {entry}
                </Text>
              )}
            </Box>
          )
        })}
        {(() => {
          const addRow = entries.length
          const isSelected = addRow === clampedSelected && editing === null
          const isEditingThis = editing !== null && editing.index === null
          return (
            <Box gap={1}>
              <Text>{isSelected ? figures.pointer : ' '}</Text>
              {isEditingThis ? (
                renderEditBox()
              ) : (
                <Text
                  dimColor={!isSelected}
                  color={isSelected ? 'suggestion' : undefined}
                >
                  + Add rule
                </Text>
              )}
            </Box>
          )
        })()}
        <Box gap={1} marginTop={1}>
          <Text>
            {clampedSelected === rows.length - 1 && editing === null
              ? figures.pointer
              : ' '}
          </Text>
          <Text
            bold
            color={
              clampedSelected === rows.length - 1 && editing === null
                ? 'suggestion'
                : undefined
            }
          >
            Done
          </Text>
        </Box>
      </Box>
      <Text dimColor>
        {editing
          ? 'enter to save rule · Esc to cancel edit'
          : group.modeLabel
            ? '↑/↓ navigate · ←/→ group · tab mode · enter edit · d delete · Esc cancel'
            : '↑/↓ navigate · ←/→ group · enter edit · d delete · Esc cancel'}
      </Text>
    </Box>
  )
}
