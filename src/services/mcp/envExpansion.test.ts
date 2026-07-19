import { expect, test } from 'bun:test'
import { expandEnvVarsInString } from './envExpansion.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

test('blocks session ingress token expansion case-insensitively', () => {
  const previousToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'test-session-token'
  try {
    for (const key of [
      'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
      'claude_code_session_access_token',
      'Claude_Code_Session_Access_Token',
    ]) {
      const expanded = expandEnvVarsInString(
        `https://\${${key}:-fallback}/mcp`,
      )
      expect(expanded.expanded).toContain(`\${${key}:-fallback}`)
      expect(expanded.missingVars).toContain(key)
    }
  } finally {
    if (previousToken === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
    } else {
      process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = previousToken
    }
  }
})

test('sanitizes protected variables after environment merges', () => {
  const childEnv = subprocessEnv({
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'override-token',
    claude_code_session_access_token: 'lowercase-token',
    Claude_Code_Session_Access_Token: 'mixed-case-token',
  })
  expect(
    Object.keys(childEnv).filter(
      key => key.toUpperCase() === 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
    ),
  ).toEqual([])
})
