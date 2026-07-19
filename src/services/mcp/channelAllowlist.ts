/**
 * Local channel relay gate. The actual trust boundary is the explicit
 * `--channels` entry, plus capability and plugin-source checks in
 * `channelNotification.ts`.
 */
export function isChannelsEnabled(): boolean {
  return true
}
