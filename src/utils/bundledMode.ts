/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 *
 * Bun build --compile embeds source as bytecode, NOT as embedded files.
 * Bun.embeddedFiles only lists assets embedded via --asset or import.meta.resolve.
 * In compiled binaries, all module URLs use the virtual /$bunfs/ filesystem.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') return false
  // Assets embedded via --asset / import.meta.resolve
  if (Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0) return true
  // Source bytecode in a compiled binary — virtual /$bunfs/ filesystem
  return import.meta.url.includes('/$bunfs/')
}
