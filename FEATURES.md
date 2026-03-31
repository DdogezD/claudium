# Feature Flags

This repository has two different "experimental" mechanisms:

1. `bun run build:dev`
   Builds a dev-stamped binary (`cli-dev`) and marks it as an experimental build.
   It does not automatically enable every compile-time feature flag in the source.

2. `feature('FLAG_NAME')`
   Bun compile-time flags that include or strip code paths at build time.

## Build Variants

- `bun run build`
  Builds the regular external binary at `./cli`.
- `bun run build:dev`
  Builds `./cli-dev` with a `-dev.YYYYMMDD.tHHMMSS.sha...` version and the experimental GrowthBook client key.
- `bun run build:dev:full`
  Builds `./cli-dev` with the snapshot-safe experimental bundle listed below.

## Snapshot-Safe Experimental Bundle

The following flags were smoke-tested against this leaked source snapshot and compile successfully together:

- `QUICK_SEARCH`
  Enables prompt quick-search UI paths.
- `HISTORY_PICKER`
  Enables interactive prompt history picker UI.
- `TOKEN_BUDGET`
  Enables token budget tracking and related UI warnings.
- `VOICE_MODE`
  Enables voice-mode UI and command paths.
  Runtime still depends on optional native audio support.
- `ULTRAPLAN`
  Enables ultraplan command and prompt-input triggers.
- `CACHED_MICROCOMPACT`
  Enables cached microcompact plumbing.
- `PROMPT_CACHE_BREAK_DETECTION`
  Enables cache-break detection around compact/query flow.

These are the flags used by `build:dev:full`.

`CHICAGO_MCP` compiles from this snapshot, but the resulting binary is not
runtime-safe because it reaches unresolved `@ant/*` computer-use modules.
It is intentionally excluded from `build:dev:full`.

## Flags Present In Source

The codebase references these compile-time flags:

- `ABLATION_BASELINE`
- `AGENT_MEMORY_SNAPSHOT`
- `AGENT_TRIGGERS`
- `AGENT_TRIGGERS_REMOTE`
- `ALLOW_TEST_VERSIONS`
- `ANTI_DISTILLATION_CC`
- `AUTO_THEME`
- `AWAY_SUMMARY`
- `BASH_CLASSIFIER`
- `BG_SESSIONS`
- `BREAK_CACHE_COMMAND`
- `BRIDGE_MODE`
- `BUDDY`
- `BUILDING_CLAUDE_APPS`
- `BUILTIN_EXPLORE_PLAN_AGENTS`
- `BYOC_ENVIRONMENT_RUNNER`
- `CACHED_MICROCOMPACT`
- `CCR_AUTO_CONNECT`
- `CCR_MIRROR`
- `CCR_REMOTE_SETUP`
- `CHICAGO_MCP`
- `COMMIT_ATTRIBUTION`
- `COMPACTION_REMINDERS`
- `CONNECTOR_TEXT`
- `CONTEXT_COLLAPSE`
- `COORDINATOR_MODE`
- `COWORKER_TYPE_TELEMETRY`
- `DAEMON`
- `DIRECT_CONNECT`
- `DOWNLOAD_USER_SETTINGS`
- `DUMP_SYSTEM_PROMPT`
- `ENHANCED_TELEMETRY_BETA`
- `EXPERIMENTAL_SKILL_SEARCH`
- `EXTRACT_MEMORIES`
- `FILE_PERSISTENCE`
- `FORK_SUBAGENT`
- `HARD_FAIL`
- `HISTORY_PICKER`
- `HISTORY_SNIP`
- `HOOK_PROMPTS`
- `IS_LIBC_GLIBC`
- `IS_LIBC_MUSL`
- `KAIROS`
- `KAIROS_BRIEF`
- `KAIROS_CHANNELS`
- `KAIROS_DREAM`
- `KAIROS_GITHUB_WEBHOOKS`
- `KAIROS_PUSH_NOTIFICATION`
- `LODESTONE`
- `MCP_RICH_OUTPUT`
- `MCP_SKILLS`
- `MEMORY_SHAPE_TELEMETRY`
- `MESSAGE_ACTIONS`
- `MONITOR_TOOL`
- `NATIVE_CLIENT_ATTESTATION`
- `NATIVE_CLIPBOARD_IMAGE`
- `NEW_INIT`
- `OVERFLOW_TEST_TOOL`
- `PERFETTO_TRACING`
- `POWERSHELL_AUTO_MODE`
- `PROACTIVE`
- `PROMPT_CACHE_BREAK_DETECTION`
- `QUICK_SEARCH`
- `REACTIVE_COMPACT`
- `REVIEW_ARTIFACT`
- `RUN_SKILL_GENERATOR`
- `SELF_HOSTED_RUNNER`
- `SHOT_STATS`
- `SKILL_IMPROVEMENT`
- `SLOW_OPERATION_LOGGING`
- `SSH_REMOTE`
- `TEAMMEM`
- `TEMPLATES`
- `TERMINAL_PANEL`
- `TOKEN_BUDGET`
- `TORCH`
- `TRANSCRIPT_CLASSIFIER`
- `TREE_SITTER_BASH`
- `TREE_SITTER_BASH_SHADOW`
- `UDS_INBOX`
- `ULTRAPLAN`
- `ULTRATHINK`
- `UNATTENDED_RETRY`
- `UPLOAD_USER_SETTINGS`
- `VERIFICATION_AGENT`
- `VOICE_MODE`
- `WEB_BROWSER_TOOL`
- `WORKFLOW_SCRIPTS`

## High-Traffic Feature Families

These are the most prominent feature families in the snapshot:

- Assistant / brief / channels
  `KAIROS`, `KAIROS_BRIEF`, `KAIROS_CHANNELS`, `KAIROS_GITHUB_WEBHOOKS`, `KAIROS_PUSH_NOTIFICATION`, `KAIROS_DREAM`
- Classifiers / auto mode
  `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `TREE_SITTER_BASH`, `TREE_SITTER_BASH_SHADOW`
- Remote / bridge / computer-use
  `BRIDGE_MODE`, `DAEMON`, `DIRECT_CONNECT`, `SSH_REMOTE`, `CHICAGO_MCP`, `WEB_BROWSER_TOOL`
- Planning / agents / automation
  `ULTRAPLAN`, `COORDINATOR_MODE`, `FORK_SUBAGENT`, `AGENT_TRIGGERS`, `AGENT_TRIGGERS_REMOTE`, `VERIFICATION_AGENT`
- Context / compact / memory
  `CONTEXT_COLLAPSE`, `REACTIVE_COMPACT`, `CACHED_MICROCOMPACT`, `PROMPT_CACHE_BREAK_DETECTION`, `TOKEN_BUDGET`, `HISTORY_SNIP`, `BG_SESSIONS`, `TEAMMEM`, `EXTRACT_MEMORIES`
- UI extras
  `QUICK_SEARCH`, `HISTORY_PICKER`, `VOICE_MODE`, `MESSAGE_ACTIONS`, `AUTO_THEME`, `SHOT_STATS`

## Known Broken In This Snapshot

These flags do appear in source, but turning them on currently fails to build because referenced modules are missing from the leaked snapshot:

- `KAIROS`
- `KAIROS_BRIEF`
- `PROACTIVE`
- `BRIDGE_MODE`
- `DAEMON`
- `DIRECT_CONNECT`
- `SSH_REMOTE`
- `COORDINATOR_MODE`
- `CHICAGO_MCP`
- `BUDDY`
- `UDS_INBOX`
- `CONTEXT_COLLAPSE`
- `REACTIVE_COMPACT`
- `EXPERIMENTAL_SKILL_SEARCH`
- `MCP_SKILLS`
- `WORKFLOW_SCRIPTS`
- `MONITOR_TOOL`
- `REVIEW_ARTIFACT`
- `TEAMMEM`
- `TRANSCRIPT_CLASSIFIER`

The failures are mostly missing files such as assistant-mode modules, remote/server modules, workflow/monitor tools, skill-search modules, classifier prompt files, and team-memory helpers.

## Useful Entry Points

- Feature-aware build logic:
  [scripts/build.ts](/Users/paolo/Repos/claude-code/scripts/build.ts)
- Experimental GrowthBook key selection:
  [src/constants/keys.ts](/Users/paolo/Repos/claude-code/src/constants/keys.ts)
- Feature-gated command imports:
  [src/commands.ts](/Users/paolo/Repos/claude-code/src/commands.ts)
- Feature-gated tool imports:
  [src/tools.ts](/Users/paolo/Repos/claude-code/src/tools.ts)
- Feature-gated query behavior:
  [src/query.ts](/Users/paolo/Repos/claude-code/src/query.ts)
- Feature-gated CLI options and startup flow:
  [src/main.tsx](/Users/paolo/Repos/claude-code/src/main.tsx)
