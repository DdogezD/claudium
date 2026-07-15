/**
 * Monotonically increasing version that increments every time the user
 * commits a settings change through /config.  UI components frozen in
 * scrollback (via OffscreenFreeze) subscribe to this to know when to
 * invalidate their cache and pick up fresh data.
 */
let version = 0
const listeners = new Set<() => void>()

export function bumpSettingsVersion(): void {
  version++
  for (const l of listeners) l()
}

export function subscribeSettingsVersion(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

export function getSettingsVersion(): number {
  return version
}
