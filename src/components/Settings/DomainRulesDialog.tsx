import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { compileMatchPattern } from '../../tools/WebSearchTool/matchPattern.js'
import TextInput from '../TextInput.js'

export type DomainRuleLists = {
  searchAllowed: string[]
  searchBlocked: string[]
  fetchAllow: string[]
  fetchDeny: string[]
  sandboxAllowed: string[]
}

type ListRef = keyof DomainRuleLists

type GroupKey = 'websearch' | 'webfetch' | 'sandbox'

type Group = {
  key: GroupKey
  title: string
  lists: { ref: ListRef; title: string }[]
  validate: (rule: string, existing: string[]) => string | null
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
    lists: [
      { ref: 'searchAllowed', title: 'Allowed' },
      { ref: 'searchBlocked', title: 'Blocked' },
    ],
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
    lists: [
      { ref: 'fetchAllow', title: 'Allowed' },
      { ref: 'fetchDeny', title: 'Blocked' },
    ],
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
    lists: [{ ref: 'sandboxAllowed', title: 'Allowed' }],
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
  | { type: 'entry'; list: ListRef; index: number }
  | { type: 'add'; list: ListRef }
  | { type: 'done' }

type Props = {
  initial: DomainRuleLists
  onComplete: (result: DomainRuleLists) => void
  onCancel: () => void
}

export function DomainRulesDialog({
  initial,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [lists, setLists] = useState<DomainRuleLists>(initial)
  const [groupIndex, setGroupIndex] = useState(0)
  const [selectedRow, setSelectedRow] = useState(0)
  const [editing, setEditing] = useState<{
    list: ListRef
    index: number | null
  } | null>(null)
  const [editText, setEditText] = useState('')
  const [editOffset, setEditOffset] = useState(0)
  const [editError, setEditError] = useState<string | null>(null)
  const isTerminalFocused = useTerminalFocus()

  const group = GROUPS[groupIndex]!

  const rows: Row[] = [
    ...group.lists.flatMap((l): Row[] => [
      ...lists[l.ref].map((_, index): Row => ({
        type: 'entry',
        list: l.ref,
        index,
      })),
      { type: 'add', list: l.ref },
    ]),
    { type: 'done' },
  ]
  const clampedSelected = Math.min(selectedRow, rows.length - 1)
  const currentRow = rows[clampedSelected]

  // Esc closes the dialog (discards) — only when not editing a rule.
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
    isActive: editing === null,
  })

  function setList(list: ListRef, next: string[]): void {
    setLists(prev => ({ ...prev, [list]: next }))
  }

  function startEdit(list: ListRef, index: number | null): void {
    const initialText = index === null ? '' : lists[list][index]!
    setEditing({ list, index })
    setEditText(initialText)
    setEditOffset(initialText.length)
    setEditError(null)
  }

  function commitEdit(): void {
    if (!editing) return
    const list = lists[editing.list]
    const existing = list.filter((_, i) => i !== editing.index)
    const error = group.validate(editText, existing)
    if (error) {
      setEditError(error)
      return
    }
    const trimmed = editText.trim()
    const next =
      editing.index === null
        ? [...list, trimmed]
        : list.map((e, i) => (i === editing.index ? trimmed : e))
    setList(editing.list, next)
    setEditing(null)
  }

  function switchGroup(delta: -1 | 1): void {
    setGroupIndex(prev => (prev + delta + GROUPS.length) % GROUPS.length)
    setSelectedRow(0)
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
    } else if (key.upArrow) {
      setSelectedRow(prev => (prev - 1 + rows.length) % rows.length)
    } else if (key.downArrow) {
      setSelectedRow(prev => (prev + 1) % rows.length)
    } else if (input === 'd' && currentRow?.type === 'entry') {
      setList(
        currentRow.list,
        lists[currentRow.list].filter((_, i) => i !== currentRow.index),
      )
      setSelectedRow(prev => Math.min(prev, rows.length - 2))
    } else if (key.return) {
      if (!currentRow) return
      if (currentRow.type === 'entry') {
        startEdit(currentRow.list, currentRow.index)
      } else if (currentRow.type === 'add') {
        startEdit(currentRow.list, null)
      } else {
        onComplete(lists)
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
          placeholder={
            group.key === 'websearch'
              ? 'example.com or *://*.example.com/path/*'
              : group.key === 'webfetch'
                ? 'example.com or *.example.com'
                : 'example.com'
          }
          columns={50}
          cursorOffset={editOffset}
          onChangeCursorOffset={setEditOffset}
        />
        {editError && <Text color="error">{editError}</Text>}
      </Box>
    )
  }

  let rowNumber = -1

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
      <Box flexDirection="column">
        {group.lists.map(l => (
          <React.Fragment key={l.ref}>
            <Text bold color="subtle">
              {l.title}
            </Text>
            {lists[l.ref].length === 0 && <Text dimColor> (none)</Text>}
            {lists[l.ref].map((entry, index) => {
              rowNumber++
              const thisRow = rowNumber
              const isSelected = thisRow === clampedSelected && editing === null
              const isEditingThis =
                editing?.list === l.ref && editing.index === index
              return (
                <Box key={`${l.ref}-${index}`} gap={1}>
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
              rowNumber++
              const thisRow = rowNumber
              const isSelected = thisRow === clampedSelected && editing === null
              const isEditingThis =
                editing?.list === l.ref && editing.index === null
              return (
                <Box key={`${l.ref}-add`} gap={1}>
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
          </React.Fragment>
        ))}
        <Box gap={1}>
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
          : '↑/↓ navigate · ←/→ group · enter edit · d delete · Esc cancel'}
      </Text>
    </Box>
  )
}
