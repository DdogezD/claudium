import figures from 'figures'
import React, { useCallback, useState } from 'react'
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { parseRuleEntry } from '../../tools/WebSearchTool/matchPattern.js'
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
// gives it meaning — except web search in allowlist mode, which also
// carries `exceptions` (blocked carve-outs within the allowlist).
// Mapping mode+lists to concrete settings keys is the caller's job.
export type DomainRulesResult = {
  search: { mode: DomainRuleMode; rules: string[]; exceptions: string[] }
  fetch: { mode: DomainRuleMode; rules: string[] }
  sandbox: { rules: string[] }
}

// Collapse the raw settings lists into the single-list-per-group model.
// For web search, a populated allowlist means allowlist mode (it is the
// hard ceiling at runtime) and the blocklist becomes its exceptions.
// For web fetch, the blocklist wins when both sides are populated
// (losing deny rules silently is worse).
export function deriveDomainRules(lists: DomainRuleLists): DomainRulesResult {
  return {
    search:
      lists.searchAllowed.length > 0
        ? { mode: 'allowlist', rules: lists.searchAllowed, exceptions: lists.searchBlocked }
        : { mode: 'blocklist', rules: lists.searchBlocked, exceptions: [] },
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
    placeholder: 'example.com or example.com/path',
    modeLabel: {
      blocklist: 'Allow all except blocked',
      allowlist: 'Allow only listed domains',
    },
    validate(rule, existing) {
      const base = baseRuleError(rule, existing)
      if (base) return base
      return parseRuleEntry(rule.trim()) === null
        ? 'Invalid rule (expected e.g. example.com or example.com/path)'
        : null
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
  | { type: 'header' }
  | { type: 'exception'; index: number }
  | { type: 'addException' }
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
  const [searchExceptions, setSearchExceptions] = useState<string[]>(
    derived.search.exceptions,
  )
  const [modes, setModes] = useState<Record<'websearch' | 'webfetch', DomainRuleMode>>({
    websearch: derived.search.mode,
    webfetch: derived.fetch.mode,
  })
  const [groupIndex, setGroupIndex] = useState(0)
  const [selectedRow, setSelectedRow] = useState(0)
  const [editing, setEditing] = useState<{
    index: number | null
    list: 'rules' | 'exceptions'
  } | null>(null)
  const [editText, setEditText] = useState('')
  const [editOffset, setEditOffset] = useState(0)
  const [editError, setEditError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  const group = GROUPS[groupIndex]!
  const entries = rules[group.key]
  // Exceptions only exist for web search in allowlist mode.
  const showExceptions = group.key === 'websearch' && modes.websearch === 'allowlist'

  const rows: Row[] = showExceptions
    ? [
        ...entries.map((_, index): Row => ({ type: 'entry', index })),
        { type: 'add' },
        { type: 'header' },
        ...searchExceptions.map((_, index): Row => ({ type: 'exception', index })),
        { type: 'addException' },
        { type: 'done' },
      ]
    : [
        ...entries.map((_, index): Row => ({ type: 'entry', index })),
        { type: 'add' },
        { type: 'done' },
      ]
  // Header rows are visual separators — skip them in the direction of travel.
  const clampRow = (i: number, dir: 1 | -1 = 1): number => {
    let j = Math.max(0, Math.min(i, rows.length - 1))
    while (rows[j]?.type === 'header') j += dir
    return Math.max(0, Math.min(j, rows.length - 1))
  }
  const clampedSelected = clampRow(selectedRow)
  const currentRow = rows[clampedSelected]

  // Scroll window, same pattern as the Config main menu: render a fixed
  // number of rows and keep the selection inside the window.
  const { rows: terminalRows } = useTerminalSize()
  const maxVisible = Math.max(5, Math.min(Math.floor(terminalRows * 0.8), 30) - 12)
  const [scrollOffset, setScrollOffset] = useState(0)
  const adjustScrollOffset = useCallback(
    (newIndex: number) => {
      setScrollOffset(prev => {
        if (newIndex < prev) return newIndex
        if (newIndex >= prev + maxVisible) return newIndex - maxVisible + 1
        return prev
      })
    },
    [maxVisible],
  )
  // Keep the selection visible when the list shrinks (deletes) or the
  // window resizes.
  React.useEffect(() => {
    setScrollOffset(prev => {
      if (clampedSelected < prev) return clampedSelected
      if (clampedSelected >= prev + maxVisible) return clampedSelected - maxVisible + 1
      return prev
    })
  }, [rows.length, clampedSelected, maxVisible])
  const visibleRows = rows.slice(scrollOffset, scrollOffset + maxVisible)

  // Esc closes the dialog (discards) — only when not editing a rule.
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
    isActive: editing === null,
  })

  function startEdit(list: 'rules' | 'exceptions', index: number | null): void {
    const listEntries = list === 'rules' ? entries : searchExceptions
    const initialText = index === null ? '' : listEntries[index]!
    setEditing({ index, list })
    setEditText(initialText)
    setEditOffset(initialText.length)
    setEditError(null)
  }

  function commitEdit(): void {
    if (!editing) return
    const listEntries = editing.list === 'rules' ? entries : searchExceptions
    const existing = listEntries.filter((_, i) => i !== editing.index)
    const error = group.validate(editText, existing)
    if (error) {
      setEditError(error)
      return
    }
    const trimmed = editText.trim()
    const next =
      editing.index === null
        ? [...listEntries, trimmed]
        : listEntries.map((e, i) => (i === editing.index ? trimmed : e))
    if (editing.list === 'rules') {
      setRules(prev => ({ ...prev, [group.key]: next }))
    } else {
      setSearchExceptions(next)
    }
    setEditing(null)
  }

  function switchGroup(delta: -1 | 1): void {
    setGroupIndex(prev => (prev + delta + GROUPS.length) % GROUPS.length)
    setSelectedRow(0)
    setScrollOffset(0)
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
      const next = clampRow((clampedSelected - 1 + rows.length) % rows.length, -1)
      setSelectedRow(next)
      adjustScrollOffset(next)
    } else if (key.downArrow) {
      const next = clampRow((clampedSelected + 1) % rows.length, 1)
      setSelectedRow(next)
      adjustScrollOffset(next)
    } else if (
      input === 'd' &&
      (currentRow?.type === 'entry' || currentRow?.type === 'exception')
    ) {
      if (currentRow.type === 'entry') {
        setRules(prev => ({
          ...prev,
          [group.key]: entries.filter((_, i) => i !== currentRow.index),
        }))
      } else {
        setSearchExceptions(prev => prev.filter((_, i) => i !== currentRow.index))
      }
      setSelectedRow(prev => clampRow(prev, -1))
    } else if (key.return) {
      if (!currentRow) return
      if (currentRow.type === 'entry') {
        startEdit('rules', currentRow.index)
      } else if (currentRow.type === 'add') {
        startEdit('rules', null)
      } else if (currentRow.type === 'exception') {
        startEdit('exceptions', currentRow.index)
      } else if (currentRow.type === 'addException') {
        startEdit('exceptions', null)
      } else if (currentRow.type === 'done') {
        onComplete({
          search: { mode: modes.websearch, rules: rules.websearch, exceptions: searchExceptions },
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
        {scrollOffset > 0 && (
          <Text dimColor>
            {figures.arrowUp} {scrollOffset} more above
          </Text>
        )}
        {visibleRows.map((row, visibleIndex) => {
          const rowIndex = scrollOffset + visibleIndex
          const isSelected = rowIndex === clampedSelected && editing === null
          switch (row.type) {
            case 'header':
              return (
                <Text key="header" dimColor marginTop={1}>
                  Exceptions
                </Text>
              )
            case 'entry':
            case 'exception': {
              const list = row.type === 'entry' ? 'rules' : 'exceptions'
              const listEntries =
                row.type === 'entry' ? entries : searchExceptions
              const isEditingThis =
                editing !== null &&
                editing.list === list &&
                editing.index === row.index
              return (
                <Box key={`${row.type}-${row.index}`} gap={1}>
                  <Text>{isSelected ? figures.pointer : ' '}</Text>
                  {isEditingThis ? (
                    renderEditBox()
                  ) : (
                    <Text color={isSelected ? 'suggestion' : undefined}>
                      {listEntries[row.index]}
                    </Text>
                  )}
                </Box>
              )
            }
            case 'add':
            case 'addException': {
              const list = row.type === 'add' ? 'rules' : 'exceptions'
              const isEditingThis =
                editing !== null &&
                editing.list === list &&
                editing.index === null
              return (
                <Box key={row.type} gap={1}>
                  <Text>{isSelected ? figures.pointer : ' '}</Text>
                  {isEditingThis ? (
                    renderEditBox()
                  ) : (
                    <Text
                      dimColor={!isSelected}
                      color={isSelected ? 'suggestion' : undefined}
                    >
                      {row.type === 'add' ? '+ Add rule' : '+ Add exception'}
                    </Text>
                  )}
                </Box>
              )
            }
            case 'done':
              return (
                <Box key="done" gap={1} marginTop={1}>
                  <Text>{isSelected ? figures.pointer : ' '}</Text>
                  <Text bold color={isSelected ? 'suggestion' : undefined}>
                    Done
                  </Text>
                </Box>
              )
          }
        })}
        {scrollOffset + maxVisible < rows.length && (
          <Text dimColor>
            {figures.arrowDown} {rows.length - scrollOffset - maxVisible} more
            below
          </Text>
        )}
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
