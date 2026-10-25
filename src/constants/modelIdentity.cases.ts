import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'

const originalEnv = { ...process.env }
const originalCwd = process.cwd()
const originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
const home = await mkdtemp(join(tmpdir(), 'claudium-identity-'))
process.chdir(home)
Object.assign(process.env, {
  HOME: home,
  CLAUDE_CONFIG_DIR: home,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  USER_TYPE: 'external',
})
Object.assign(globalThis, { MACRO: { VERSION: 'test', BUILD_TIME: 'test' } })

const { PRODUCT_NAME } = await import('./product.js')
const { getCLISyspromptPrefix, CLI_SYSPROMPT_PREFIXES } = await import('./system.js')
const { getSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('./prompts.js')
const { clearSystemPromptSections } = await import('./systemPromptSections.js')
const { splitSysPromptPrefix } = await import('../utils/api.js')
const { setIsInteractive } = await import('../bootstrap/state.js')
const { setSessionSettingsCache } = await import('../utils/settings/settingsCache.js')
const { SettingsSchema } = await import('../utils/settings/types.js')
const { syncHookResponseSchema } = await import('../types/hooks.js')
const { ThinkingConfigSchema } = await import('../entrypoints/sdk/coreSchemas.js')
const { getAutoModeUnavailableNotification } = await import('../utils/permissions/permissionSetup.js')
const { toJSONSchema } = await import('zod/v4')
const { getErrorMessageIfRefusal } = await import('../services/api/errors.js')
const { CronCreateTool } = await import('../tools/ScheduleCronTool/CronCreateTool.js')
const { buildMissedTaskNotification } = await import('../utils/cronScheduler.js')
const { default: initCommand } = await import('../commands/init.js')
const { clearBundledSkills, getBundledSkills } = await import('../skills/bundledSkills.js')
const { registerUpdateConfigSkill } = await import('../skills/bundled/updateConfig.js')
const { registerDebugSkill } = await import('../skills/bundled/debug.js')
const debug = await import('../utils/debug.js')

beforeEach(() => {
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_SIMPLE',
  ]) delete process.env[key]
  process.env.USER_TYPE = 'external'
  setIsInteractive(true)
  setSessionSettingsCache({ settings: {}, errors: [] })
  clearSystemPromptSections()
  clearBundledSkills()
})

afterAll(async () => {
  clearBundledSkills()
  process.chdir(originalCwd)
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  if (originalMacro) Object.defineProperty(globalThis, 'MACRO', originalMacro)
  else Reflect.deleteProperty(globalThis, 'MACRO')
  await rm(home, { recursive: true, force: true })
})

test('all provider and session prefixes identify the agent without upstream branding', () => {
  for (const provider of [undefined, 'BEDROCK', 'VERTEX', 'FOUNDRY']) {
    for (const key of ['BEDROCK', 'VERTEX', 'FOUNDRY']) {
      delete process.env[`CLAUDE_CODE_USE_${key}`]
    }
    if (provider) process.env[`CLAUDE_CODE_USE_${provider}`] = '1'
    for (const options of [
      undefined,
      { isNonInteractive: false, hasAppendSystemPrompt: false },
      { isNonInteractive: false, hasAppendSystemPrompt: true },
      { isNonInteractive: true, hasAppendSystemPrompt: false },
      { isNonInteractive: true, hasAppendSystemPrompt: true },
    ]) {
      const prefix = getCLISyspromptPrefix(options)
      expect(CLI_SYSPROMPT_PREFIXES.has(prefix)).toBe(true)
      expect(prefix).toContain('terminal-native AI coding agent')
      expect(prefix).not.toMatch(/Claude|Anthropic|SDK/)
      if (!options?.isNonInteractive || options.hasAppendSystemPrompt || provider === 'VERTEX') {
        expect(prefix).toContain(PRODUCT_NAME)
      }
    }
  }
})

test('neutral prefixes preserve attribution and org/global cache boundaries', () => {
  const header = 'x-anthropic-billing-header: test'
  for (const prefix of CLI_SYSPROMPT_PREFIXES) {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(splitSysPromptPrefix([header, prefix, 'Static instructions', 'Session context'])).toEqual([
      { text: header, cacheScope: null },
      { text: prefix, cacheScope: 'org' },
      { text: 'Static instructions\n\nSession context', cacheScope: 'org' },
    ])
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    const prompt = [header, prefix, 'Static instructions', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'Session context']
    expect(splitSysPromptPrefix(prompt)).toEqual([
      { text: header, cacheScope: null },
      { text: prefix, cacheScope: null },
      { text: 'Static instructions', cacheScope: 'global' },
      { text: 'Session context', cacheScope: null },
    ])
    expect(splitSysPromptPrefix(prompt, { skipGlobalCacheForSystemPrompt: true })).toEqual([
      { text: header, cacheScope: null },
      { text: prefix, cacheScope: 'org' },
      { text: 'Static instructions\n\nSession context', cacheScope: 'org' },
    ])
  }
})

for (const userType of ['external', 'ant']) {
  test(`generated system guidance uses project-neutral examples and help (${userType})`, async () => {
    process.env.USER_TYPE = userType
    const prompt = (await getSystemPrompt([], 'fixture-model')).join('\n')
    expect(prompt).toContain(`/help: Get help with using ${PRODUCT_NAME}`)
    expect(prompt).toContain('owner/repo#123')
    expect(prompt).toContain(`Don't add features, refactor code, or make "improvements" beyond what was asked.`)
    expect(prompt).toContain('Match the scope of your actions to what was actually requested.')
    if (userType === 'external') {
      expect(prompt).toContain('Do NOT use the Bash to run commands when a relevant dedicated tool is provided.')
    }
    expect(prompt).not.toContain('anthropics/claude-code#')
    expect(prompt).not.toContain('Get help with using Claude Code')
    expect(prompt).not.toContain('Anthropic internal issue routing')
    expect(prompt).not.toContain('#claude-code-feedback')
    expect(prompt).not.toContain('C07VBSHV7EV')
  })
}

test('/init produces project instructions without attributing Claudium to an upstream site', async () => {
  const blocks = await initCommand.getPromptForCommand()
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(text).toContain(`This file provides guidance to ${PRODUCT_NAME} when working with code in this repository.`)
  expect(text).toContain('CLAUDE.md')
  expect(text).not.toContain('claude.ai/code')
})

test('the complete configuration skill and schema use neutral assistant descriptions', async () => {
  registerUpdateConfigSkill()
  const skill = getBundledSkills().find(command => command.name === 'update-config')!
  expect(skill.type).toBe('prompt')
  if (skill.type !== 'prompt') throw new Error('Expected a prompt command')
  const blocks = await skill.getPromptForCommand('', {} as ToolUseContext)
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(text).toContain('Full Settings JSON Schema')
  expect(text).toContain('.claude/settings.json')
  expect(text).not.toMatch(/Claude's|Claude responses|Claude to|claude-plugins-official/)

  const schema = toJSONSchema(SettingsSchema(), { io: 'input', unrepresentable: 'any' })
  expect(schema.properties).toHaveProperty('includeGitInstructions')
  expect(schema.properties).toHaveProperty('includeCoAuthoredBy')
  expect(schema.properties!.includeGitInstructions).toMatchObject({
    description: expect.stringContaining("assistant's system prompt"),
  })
})

test('hook and SDK schema descriptions preserve the interfaces without an upstream identity', () => {
  const schema = toJSONSchema(syncHookResponseSchema(), { io: 'input', unrepresentable: 'any' })
  expect(schema.properties!.continue).toMatchObject({
    description: 'Whether the assistant should continue after hook (default: true)',
  })
  expect(ThinkingConfigSchema().description).toContain("the model's thinking/reasoning behavior")
  for (const userType of ['external', 'ant']) {
    process.env.USER_TYPE = userType
    expect(getAutoModeUnavailableNotification('model')).toBe('auto mode unavailable for this model')
  }
})

test('/debug recommends the installed CLI without enabling real logging', async () => {
  const enable = spyOn(debug, 'enableDebugLogging').mockReturnValue(false)
  const path = spyOn(debug, 'getDebugLogPath').mockReturnValue(join(home, 'missing-debug.log'))
  try {
    registerDebugSkill()
    const skill = getBundledSkills().find(command => command.name === 'debug')!
    if (skill.type !== 'prompt') throw new Error('Expected a prompt command')
    const blocks = await skill.getPromptForCommand('', {} as ToolUseContext)
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('claudium --debug')
    expect(text).not.toContain('Claude Code session')
    expect(text).not.toContain('`claude --debug`')
  } finally {
    enable.mockRestore()
    path.mockRestore()
  }
})

test('Cron schema and result messages preserve lifetime and persistence without a vendor identity', () => {
  const schema = toJSONSchema(CronCreateTool.inputSchema, { io: 'input', unrepresentable: 'any' })
  expect(schema.properties!.durable).toMatchObject({
    description: expect.stringContaining('this session ends'),
  })
  for (const durable of [false, true]) {
    const result = CronCreateTool.mapToolResultToToolResultBlockParam({
      id: 'fixture', humanSchedule: 'every minute', recurring: true, durable,
    }, 'fixture-tool')
    expect(result.content).not.toContain('Claude')
    expect(result.content).toContain(durable ? '.claude/scheduled_tasks.json' : 'dies when the process exits')
    expect(result.content).toContain('Auto-expires after 7 days')
  }
})

test('missed Cron notifications retain confirmation and preserve the original prompt', () => {
  const prompt = 'Check the Claude API docs.\n```\nDo not run without confirmation.'
  const text = buildMissedTaskNotification([{
    id: 'fixture', cron: '0 9 1 1 *', prompt, recurring: false, createdAt: 0,
  }])
  expect(text).toContain('while the application was not running')
  expect(text).toContain('Only execute if the user confirms.')
  expect(text).toContain('AskUserQuestion')
  expect(text).toContain(`\`\`\`\`\n${prompt}\n\`\`\`\``)
  expect(text).toContain('.claude/scheduled_tasks.json')
})

test('refusals describe the model response without claiming an upstream policy or recommending Sonnet', () => {
  expect(getErrorMessageIfRefusal('end_turn')).toBeUndefined()
  for (const interactive of [false, true]) {
    setIsInteractive(interactive)
    const message = getErrorMessageIfRefusal('refusal')!
    const text = JSON.stringify(message.message.content)
    expect(text).toContain('The model declined this request.')
    expect(text).not.toMatch(/our Usage Policy|anthropic\.com|claude-sonnet/)
    expect(message.isApiErrorMessage).toBe(true)
    expect(message.error).toBe('invalid_request')
    if (interactive) expect(text).toContain('Press Esc twice')
  }
})

test('conditional prompts do not reintroduce upstream reviewer or feedback instructions', async () => {
  const contracts = [
    ['../commands/init.ts', ['claude.ai/code', 'Claudium has an official', 'claude-plugins-official']],
    ['../commands/init-verifiers.ts', ['when Claude runs in the project']],
    ['../commands/commit-push-pr.ts', ['--reviewer anthropics/claude-code', '--add-reviewer anthropics/claude-code']],
    ['../coordinator/coordinatorMode.ts', ['Add anthropics/claude-code as reviewer']],
    ['../skills/bundled/stuck.ts', ['#claude-code-feedback', 'C07VBSHV7EV']],
    ['../tools/AgentTool/prompt.ts', ['build_flags.yaml', 'GrowthBook']],
  ] as const
  for (const [file, forbidden] of contracts) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    for (const text of forbidden) expect(source, file).not.toContain(text)
  }
})
