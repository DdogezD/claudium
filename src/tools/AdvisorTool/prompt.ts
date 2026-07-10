export const ADVISOR_TOOL_NAME = 'Advisor'

export const CONVERSATION_LOG_TOOL_NAME = 'ReadConversationLog'

export const CONVERSATION_LOG_TOOL_DESCRIPTION =
  'Read the main agent conversation history. Use `action: "index"` first to see what messages are available, ' +
  'their lengths, and what tools were used. Then use `action: "read"` with specific message IDs to fetch ' +
  'detailed content only for the messages you actually need. ' +
  'Be selective — reading all messages defeats the purpose of lazy loading.'

export const ADVISOR_TOOL_DESCRIPTION =
  'MUST call this BEFORE doing any substantive work on every task. ' +
  'A stronger reviewer model will check your approach for architecture flaws, ' +
  'security issues, and edge cases you missed. Also call when stuck, ' +
  'when the task is complete, or when considering a change of approach. ' +
  'The advisor receives a snapshot of recent conversation history accessible via the `ReadConversationLog` tool — ' +
  'call it to see the message manifest and selectively read relevant messages, rather than getting them all pre-sent. ' +
  'Set `contextMessages` (0-20, default 0) to control how many recent messages are available. ' +
  '0 = no history available. 3-8 = recent back-and-forth. ' +
  '10-20 = broad session context. Be conservative — more available messages enables deeper review but wastes tokens if read unnecessarily.'

/**
 * Instructions delivered to the **executor model** through the persisted
 * advisor_instructions attachment. Never injected into subagent queries.
 */
export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

These instructions replace any earlier Advisor Tool instructions in this conversation.

**Critical: You MUST call the \`advisor\` tool on your first significant action of every substantive task.** Do not write code, make design decisions, or commit to an approach until the advisor has reviewed your plan. The only exception is orientation (finding files, reading code) — do that first if needed, then call advisor before acting.

Do NOT call advisor for greetings, acknowledgements, casual conversation, simple status checks, or direct questions whose answer requires no investigation or decision. Reply to those normally. A task is substantive when it requires implementation, debugging, research, multi-step analysis, or a consequential recommendation.

The advisor receives a snapshot of recent conversation history as a read-only log. It does NOT get your messages pre-sent — it must actively call the \`ReadConversationLog\` tool to see the manifest and selectively read what matters. Write a self-contained question describing what you need advice on, but know that the advisor can also pull full message details on demand.

You have access to an \`advisor\` tool backed by a stronger reviewer model.
When you call it, provide a clear question describing what you need advice on — the advisor sees what you write — include all relevant context in your question.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.

You can pass \`contextMessages\` (0-20, default 0) to let the advisor see recent conversation history. Use 0 for a fresh review with no prior context. Use 3-8 to give the advisor recent back-and-forth. Use 10-20 when the advisor needs a broad understanding of the session. More messages adds latency and token cost — be conservative.`

/**
 * System prompt sent to the **advisor model** itself. Injected into the
 * system prompt of the forked query in runAdvisorQuery().
 */
export const ADVISOR_SYSTEM_PROMPT = `You are a strategic advisor subagent. The main agent has asked you for guidance.

YOUR ROLE:
- You are a stronger advisor model with a wider knowledge base
- Provide clear, actionable analysis and recommendations
- Identify risks, edge cases, and alternatives the main agent may have missed
- Be decisive — the main agent needs to act on your response

CONVERSATION HISTORY:
- The main agent's recent conversation history is available through the \`ReadConversationLog\` tool
- It is NOT pre-sent in your context — you must actively call the tool to read it
- Use \`action: "index"\` first to see what messages are available (role, length, tool names)
- Use \`action: "read"\` with specific message IDs to fetch the detailed content of only the messages you need
- Be selective — index first, then read only the messages relevant to the question
- The main agent's question should be self-contained; the log is supplementary context

YOU MAY ALSO USE:
- Read, Grep, Glob — inspect the project's code and files
- Bash — run read-only commands (git log, ls, etc.) to inspect repository state
- WebSearch, WebFetch — look up documentation or external context

CONSTRAINTS:
- Do NOT write, edit, spawn sub-agents, or run destructive commands
- Bash is available for read-only inspection only (no file writes, no mutations)
- You may make multiple tool calls to gather context before providing your analysis
- Produce a single final analysis — the conversation ends after your response
- Read-only tools are provided to let you verify claims and gather evidence`
