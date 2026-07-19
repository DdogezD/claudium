import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/utils/todo/types.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../utils/commitAttribution.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Store } from './store.js'

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // Mutable ref - avoids array spreading per message
      writtenPathsRef: { current: Set<string> } // Mutable ref - relative paths written to overlay
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'companion'

export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // Optional - only present when ENABLE_AGENT_SWARMS is true (for dead code elimination)
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // CoordinatorTaskPanel selection: -1 = pill, 0 = main, 1..N = agent rows.
  // AppState (not local) so the panel can read it directly without prop-drilling
  // through PromptInput → PromptInputFooter.
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // Which footer pill is focused (arrow-key navigation below the prompt).
  // Lives in AppState so pill components rendered outside PromptInput
  // (CompanionSprite in REPL.tsx) can read their own focused state.
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // Agent name from --agent CLI flag or settings (for logo display)
  agent: string | undefined
  // Assistant mode fully enabled (settings + GrowthBook gate + trust).
  // Single source of truth - computed once in main.tsx before option
  // mutation, consumers read this instead of re-calling isAssistantMode().
  kairosEnabled: boolean
}> & {
  // Unified task state - excluded from DeepImmutable because TaskState contains function types
  tasks: { [taskId: string]: TaskState }
  // Name → AgentId registry populated by Agent tool when `name` is provided.
  // Latest-wins on collision. Used by SendMessage to route by name.
  agentNameRegistry: Map<string, AgentId>
  // Task ID that has been foregrounded - its messages are shown in main view
  foregroundedTaskId?: string
  // Task ID of in-process teammate whose transcript is being viewed (undefined = leader's view)
  viewingAgentTaskId?: string
  // Latest companion reaction from the friend observer (src/buddy/observer.ts)
  companionReaction?: string
  // Timestamp of last /buddy pet — CompanionSprite renders hearts while recent
  companionPetAt?: number
  // TODO (ashwin): see if we can use utility-types DeepReadonly for this
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /**
     * Incremented by /reload-plugins to trigger MCP effects to re-run
     * and pick up newly-enabled plugin MCP servers. Effects read this
     * as a dependency; the value itself is not consumed.
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /**
     * Plugin system errors collected during loading and initialization.
     * See {@link PluginError} type documentation for complete details on error
     * structure, context fields, and display format.
     */
    errors: PluginError[]
    // Installation status for background plugin/marketplace installation
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * Set to true when plugin state on disk has changed (background reconcile,
     * /plugin menu install, external settings edit) and active components are
     * stale. In interactive mode, user runs /reload-plugins to consume. In
     * headless mode, refreshPluginState() auto-consumes via refreshActivePlugins().
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // The tmux target (e.g., "session:window.pane")
  }
  tungstenLastCapturedTime?: number // Timestamp when frame was captured for model
  tungstenLastCommand?: {
    command: string // The command string to display (e.g., "Enter", "echo hello")
    timestamp: number // When the command was sent
  }
  // Sticky tmux panel visibility — mirrors globalConfig.tungstenPanelVisible for reactivity.
  tungstenPanelVisible?: boolean
  // Transient auto-hide at turn end — separate from tungstenPanelVisible so the
  // pill stays in the footer (user can reopen) but the panel content doesn't take
  // screen space when idle. Cleared on next Tmux tool use or user toggle. NOT persisted.
  tungstenPanelAutoHidden?: boolean
  // WebBrowser tool (codename bagel): pill visible in footer
  bagelActive?: boolean
  // WebBrowser tool: current page URL shown in pill label
  bagelUrl?: string
  // WebBrowser tool: sticky panel visibility toggle
  bagelPanelVisible?: boolean
  // chicago MCP session state. Types inlined (not imported from
  // @ant/computer-use-mcp/types) so external typecheck passes without the
  // ant-scoped dep resolved. Shapes match `AppGrant`/`CuGrantFlags`
  // structurally — wrapper.tsx assigns via structural compatibility. Only
  // populated when feature('CHICAGO_MCP') is active.
  computerUseMcpState?: {
    // Session-scoped app allowlist. NOT persisted across resume.
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // Clipboard/system-key grant flags (orthogonal to allowlist).
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // Dims-only (NOT the blob) for scaleCoord after compaction. The full
    // `ScreenshotResult` including base64 is process-local in wrapper.tsx.
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // Accumulated by onAppsHidden, cleared + unhidden at turn end.
    hiddenDuringTurn?: ReadonlySet<string>
    // Which display CU targets. Written back by the package's
    // `autoTargetDisplay` resolver via `onResolvedDisplayUpdated`. Persisted
    // across resume so clicks stay on the display the model last saw.
    selectedDisplayId?: number
    // True when the model explicitly picked a display via `switch_display`.
    // Makes `handleScreenshot` skip the resolver chase chain and honor
    // `selectedDisplayId` directly. Cleared on resolver writeback (pinned
    // display unplugged → Swift fell back to main) and on
    // `switch_display("auto")`.
    displayPinnedByModel?: boolean
    // Sorted comma-joined bundle-ID set the display was last auto-resolved
    // for. `handleScreenshot` only re-resolves when the allowed set has
    // changed since — keeps the resolver from yanking on every screenshot.
    displayResolvedForApps?: string
  }
  // REPL tool VM context - persists across REPL calls for state sharing
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // Self-identity for swarm members (separate processes in tmux panes)
    // Note: This is different from toolUseContext.agentId which is for in-process subagents
    selfAgentId?: string // Swarm member's own ID (same as leadAgentId for leaders)
    selfAgentName?: string // Swarm member's name ('team-lead' for leaders)
    isLeader?: boolean // True if this swarm member is the team leader
    selfAgentColor?: string // Assigned color for UI (used by dynamically joined sessions)
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // Standalone agent context for non-swarm sessions with custom name/color
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // Worker sandbox permission requests (leader side) - for network access approval
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // Pending permission request on worker side (shown while waiting for leader approval)
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // Pending sandbox permission request on worker side
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // Auth version - incremented on login/logout to trigger re-fetching of auth-dependent data
  authVersion: number
  // Initial message to process (from CLI args or plan mode exit)
  // When set, REPL will process the message and trigger a query
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // Session-scoped permission rules from plan mode (e.g., "run tests", "install dependencies")
    allowedPrompts?: AllowedPrompt[]
  } | null
  // Pending plan verification state (set when exiting plan mode)
  // Used by VerifyPlanExecution tool to trigger background verification
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // Denial tracking for classifier modes (YOLO, headless, etc.) - falls back to prompting when limits exceeded
  denialTracking?: DenialTrackingState
  // Active overlays (Select dialogs, etc.) for Escape key coordination
  activeOverlays: ReadonlySet<string>
  // Effort value
  effortValue?: EffortValue
  // Channel permission callbacks — permission prompts over Telegram/iMessage/etc.
  // Races against local UI + bridge + hooks + classifier via claim() in
  // interactiveHandler.ts. Constructed once in useManageMCPConnections.
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  // Determine initial permission mode for teammates spawned with plan_mode_required
  // Use lazy require to avoid circular dependency with teammate.ts
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  const initialSettings = getInitialSettings()

  return {
    settings: initialSettings,
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // alias, full name (as with --model or env var), or null (default)
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
  }
}
