/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { getAPIProvider } from '../../utils/model/providers.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// Stubbed: all OAuth-based auth removed. Only ANTHROPIC_API_KEY supported.

export async function installOAuthTokens(...args: any[]): Promise<void> {
  // Stubbed: no OAuth
}

export async function authLogin({
  email,
  sso,
  console: useConsole,
  claudeai,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  claudeai?: boolean
}): Promise<void> {
  process.stderr.write(
    'Login via OAuth is not available in this build.\n' +
      'Set the ANTHROPIC_API_KEY environment variable instead.\n',
  )
  process.exit(1)
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY

  if (opts.text) {
    if (hasApiKey) {
      process.stdout.write('API key: ANTHROPIC_API_KEY\n')
    } else {
      process.stdout.write(
        'Not logged in. Set ANTHROPIC_API_KEY environment variable.\n',
      )
    }
  } else {
    const output: Record<string, string | boolean | null> = {
      loggedIn: hasApiKey,
      authMethod: hasApiKey ? 'api_key' : 'none',
      apiProvider: getAPIProvider(),
    }
    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(hasApiKey ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  process.stdout.write(
    'Logout is not applicable when using ANTHROPIC_API_KEY.\n',
  )
  process.exit(0)
}
