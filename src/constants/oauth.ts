import { isEnvTruthy } from 'src/utils/envUtils.js'

type OauthConfigType = 'prod' | 'staging' | 'local'

function getOauthConfigType(): OauthConfigType {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) return 'local'
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) return 'staging'
  }
  return 'prod'
}

export function fileSuffixForOauthConfig(): string {
  switch (getOauthConfigType()) {
    case 'local': return '-local-oauth'
    case 'staging': return '-staging-oauth'
    case 'prod': return ''
  }
}

export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const
export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

type OauthConfig = {
  BASE_API_URL: string
}

const PROD_OAUTH_CONFIG = {
  BASE_API_URL: 'https://api.anthropic.com',
} as const

export function getOauthConfig(): OauthConfig {
  return PROD_OAUTH_CONFIG
}
