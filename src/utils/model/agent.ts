import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import {
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { resolveModelProfileModel } from './modelProfiles.js'

export type AgentModelOption = {
  value: string
  label: string
  description: string
}

/**
 * Get the default subagent model. Falls back to modelProfiles.subagent.model
 * if configured, otherwise 'inherit' (use the parent thread's model).
 */
export function getDefaultSubagentModel(): string {
  return resolveModelProfileModel('subagent') ?? 'inherit'
}

/**
 * Get the effective model string for an agent.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: PermissionMode,
): string {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp.toLowerCase() === 'inherit') {
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  return parseUserSpecifiedModel(agentModelWithExp)
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * Get available model options for agents.
 * Only shows Subagent Model (from /config) and Inherit from parent.
 * Users wanting a custom model should type it directly in the model input.
 */
export function getAgentModelOptions(): AgentModelOption[] {
  const profileModel = resolveModelProfileModel('subagent')
  const options: AgentModelOption[] = [
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
  if (profileModel) {
    options.unshift({
      value: profileModel,
      label: capitalize(profileModel),
      description: 'Subagent Model (configured in /config)',
    })
  }
  return options
}
