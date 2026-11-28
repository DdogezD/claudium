/**
 * Constants for Anthropic-official marketplaces bundled with Claudium.
 *
 * The default set is implicitly declared (see getDeclaredMarketplaces), so
 * these marketplaces are materialized on first startup without the user
 * adding them. `sourceIsFallback` means a pre-existing materialization under
 * any source is left alone.
 */

import type { MarketplaceSource } from './schemas.js'

/**
 * Source configuration for the official Anthropic plugins marketplace.
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

/**
 * Source configuration for the Anthropic example-skills marketplace.
 */
export const ANTHROPIC_SKILLS_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/skills',
} as const satisfies MarketplaceSource

/**
 * Display name for the official marketplace.
 * This is the name under which the marketplace will be registered
 * in the known_marketplaces.json file.
 */
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'

/**
 * Display name declared by anthropics/skills' own marketplace.json.
 */
export const ANTHROPIC_SKILLS_MARKETPLACE_NAME = 'anthropic-agent-skills'

/**
 * Sources that are implicitly declared on every startup.
 */
export const DEFAULT_OFFICIAL_MARKETPLACES: ReadonlyArray<{
  name: string
  source: MarketplaceSource
}> = [
  { name: OFFICIAL_MARKETPLACE_NAME, source: OFFICIAL_MARKETPLACE_SOURCE },
  {
    name: ANTHROPIC_SKILLS_MARKETPLACE_NAME,
    source: ANTHROPIC_SKILLS_MARKETPLACE_SOURCE,
  },
]

/**
 * Whether a marketplace name belongs to the Anthropic-official set that
 * ships with Claudium. Used to render the official (✻) badge in the UI.
 */
export function isOfficialMarketplaceName(name: string): boolean {
  return DEFAULT_OFFICIAL_MARKETPLACES.some(entry => entry.name === name)
}
