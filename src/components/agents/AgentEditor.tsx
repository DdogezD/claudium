import chalk from 'chalk'
import figures from 'figures'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useSetAppState } from 'src/state/AppState.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { Tools } from '../../Tool.js'
import {
  type AgentColorName,
  setAgentColor,
} from '../../tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  getActiveAgentsFromList,
  isCustomAgent,
  isPluginAgent,
} from '../../tools/AgentTool/loadAgentsDir.js'
import type { EffortValue } from '../../utils/effort.js'
import { editFileInEditor } from '../../utils/promptEditor.js'
import { getActualAgentFilePath, updateAgentFile } from './agentFileUtils.js'
import { AgentModelInput } from './AgentModelInput.js'
import { ColorPicker } from './ColorPicker.js'
import { ToolSelector } from './ToolSelector.js'
import { getAgentSourceDisplayName } from './utils.js'

type Props = {
  agent: AgentDefinition
  tools: Tools
  onSaved: (message: string) => void
  onBack: () => void
}

type EditMode = 'menu' | 'edit-tools' | 'edit-color' | 'edit-model'

type SaveChanges = {
  tools?: string[]
  color?: AgentColorName
  model?: string | null
  effort?: EffortValue | null
  contextWindowTokens?: number | null
}

export function AgentEditor({
  agent,
  tools,
  onSaved,
  onBack,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const [editMode, setEditMode] = useState<EditMode>('menu')
  const [selectedMenuIndex, setSelectedMenuIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedColor, setSelectedColor] = useState<
    AgentColorName | undefined
  >(agent.color as AgentColorName | undefined)

  const handleOpenInEditor = useCallback(async () => {
    const filePath = getActualAgentFilePath(agent)
    const result = await editFileInEditor(filePath)
    if (result.error) {
      setError(result.error)
    } else {
      onSaved(
        `Opened ${agent.agentType} in editor. If you made edits, restart to load the latest version.`,
      )
    }
  }, [agent, onSaved])

  const handleSave = useCallback(
    async (changes: SaveChanges = {}) => {
      const {
        tools: newTools,
        color: newColor,
        model: newModel,
        effort: newEffort,
        contextWindowTokens: newContextWindowTokens,
      } = changes
      const finalColor = newColor ?? selectedColor
      const hasToolsChanged = newTools !== undefined
      const hasModelChanged = newModel !== undefined
      const hasEffortChanged = newEffort !== undefined
      const hasContextChanged = newContextWindowTokens !== undefined
      const hasColorChanged = finalColor !== agent.color

      if (
        !hasToolsChanged &&
        !hasModelChanged &&
        !hasEffortChanged &&
        !hasContextChanged &&
        !hasColorChanged
      ) {
        return false
      }

      if (!isCustomAgent(agent) && !isPluginAgent(agent)) {
        return false
      }

      try {
        const finalModel =
          newModel === null ? undefined : newModel ?? agent.model
        const finalEffort =
          newEffort === null ? undefined : newEffort ?? agent.effort
        const finalContextWindowTokens =
          newContextWindowTokens === null
            ? undefined
            : newContextWindowTokens ?? agent.contextWindowTokens

        await updateAgentFile(
          agent,
          agent.whenToUse,
          newTools ?? agent.tools,
          agent.getSystemPrompt(),
          finalColor,
          finalModel,
          agent.memory,
          finalEffort,
          finalContextWindowTokens,
        )

        if (hasColorChanged && finalColor) {
          setAgentColor(agent.agentType, finalColor)
        }

        setAppState(state => {
          const allAgents = state.agentDefinitions.allAgents.map(a => {
            if (a.agentType !== agent.agentType) return a

            const updated = {
              ...a,
              tools: newTools ?? a.tools,
              color: finalColor,
            }
            if (hasModelChanged) {
              if (newModel === null) delete updated.model
              else updated.model = newModel
            }
            if (hasEffortChanged) {
              if (newEffort === null) delete updated.effort
              else updated.effort = newEffort
            }
            if (hasContextChanged) {
              if (newContextWindowTokens === null) {
                delete updated.contextWindowTokens
              } else {
                updated.contextWindowTokens = newContextWindowTokens
              }
            }
            return updated
          })

          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              activeAgents: getActiveAgentsFromList(allAgents),
              allAgents,
            },
          }
        })
        onSaved(`Updated agent: ${chalk.bold(agent.agentType)}`)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save agent')
        return false
      }
    },
    [agent, selectedColor, onSaved, setAppState],
  )

  const menuItems = useMemo(
    () => [
      { label: 'Open in editor', action: handleOpenInEditor },
      { label: 'Edit tools', action: () => setEditMode('edit-tools') },
      { label: 'Edit model', action: () => setEditMode('edit-model') },
      { label: 'Edit color', action: () => setEditMode('edit-color') },
    ],
    [handleOpenInEditor],
  )

  const handleEscape = useCallback(() => {
    setError(null)
    if (editMode === 'menu') onBack()
    else setEditMode('menu')
  }, [editMode, onBack])

  const handleMenuKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'up') {
        e.preventDefault()
        setSelectedMenuIndex(index => Math.max(0, index - 1))
      } else if (e.key === 'down') {
        e.preventDefault()
        setSelectedMenuIndex(index =>
          Math.min(menuItems.length - 1, index + 1),
        )
      } else if (e.key === 'return') {
        e.preventDefault()
        const selectedItem = menuItems[selectedMenuIndex]
        if (selectedItem) void selectedItem.action()
      }
    },
    [menuItems, selectedMenuIndex],
  )

  useKeybinding('confirm:no', handleEscape, { context: 'Confirmation' })

  const renderMenu = (): React.ReactNode => (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleMenuKeyDown}>
      <Text dimColor>Source: {getAgentSourceDisplayName(agent.source)}</Text>
      <Box marginTop={1} flexDirection="column">
        {menuItems.map((item, index) => (
          <Text
            key={item.label}
            color={index === selectedMenuIndex ? 'suggestion' : undefined}
          >
            {index === selectedMenuIndex ? `${figures.pointer} ` : '  '}
            {item.label}
          </Text>
        ))}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
    </Box>
  )

  switch (editMode) {
    case 'menu':
      return renderMenu()
    case 'edit-tools':
      return (
        <ToolSelector
          tools={tools}
          initialTools={agent.tools}
          onComplete={async finalTools => {
            setEditMode('menu')
            await handleSave({ tools: finalTools })
          }}
        />
      )
    case 'edit-color':
      return (
        <ColorPicker
          agentName={agent.agentType}
          currentColor={
            selectedColor || (agent.color as AgentColorName) || 'automatic'
          }
          onConfirm={async color => {
            setSelectedColor(color)
            setEditMode('menu')
            await handleSave({ color })
          }}
        />
      )
    case 'edit-model':
      return (
        <AgentModelInput
          initialModel={agent.model}
          initialContext={agent.contextWindowTokens}
          initialEffort={String(agent.effort ?? '')}
          onComplete={async result => {
            setEditMode('menu')
            const useSubagentModel = Object.keys(result).length === 0
            await handleSave({
              model: useSubagentModel ? null : result.model ?? null,
              contextWindowTokens: useSubagentModel
                ? null
                : result.contextWindowTokens ?? null,
              effort: useSubagentModel
                ? null
                : result.reasoningEffort ?? null,
            })
          }}
          onCancel={() => setEditMode('menu')}
        />
      )
    default:
      return null
  }
}
