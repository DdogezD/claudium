/**
 * Resolve vendored seccomp binaries for the compiled single-file binary.
 *
 * @anthropic-ai/sandbox-runtime locates vendor/seccomp/{arch}/unix-block.bpf
 * and apply-seccomp relative to its own module URL. Inside a
 * `bun build --compile` binary the module URL points into $bunfs, so the
 * vendor directory can never be found and Linux sandbox loses its
 * unix-socket restriction (and possibly fails entirely if apply-seccomp
 * is also unavailable).
 *
 * This helper mirrors the runtime's own search (package-root paths keep
 * working for `bun run dev` / source checkouts) and additionally probes
 * `vendor/seccomp/<arch>/` next to the executable, which is where the
 * installer ships the vendored files. When nothing is found it returns
 * undefined so the runtime's own fallbacks still apply.
 */

import { existsSync } from 'fs'
import { dirname, join } from 'path'

export type ResolvedSeccompPaths = {
  bpfPath: string
  applyPath: string
}

function vendorArch(): string | null {
  switch (process.arch) {
    case 'x64':
    case 'x86_64':
      return 'x64'
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    default:
      return null
  }
}

/**
 * Paths to the vendored seccomp files, or undefined when they are not
 * available next to the executable. In source/dev runs the sandbox-runtime
 * package resolves them on its own, so no override is needed there.
 */
export function resolveVendoredSeccompPaths():
  | ResolvedSeccompPaths
  | undefined {
  try {
    // Inside `bun run dev` the executable is bun itself; the runtime's own
    // package-relative lookup is correct there.
    if (!process.execPath || /(^|\/)bun$/.test(process.execPath)) {
      return undefined
    }
    const arch = vendorArch()
    if (!arch) {
      return undefined
    }
    const dir = join(
      dirname(process.execPath),
      'vendor',
      'seccomp',
      arch,
    )
    const bpfPath = join(dir, 'unix-block.bpf')
    const applyPath = join(dir, 'apply-seccomp')
    if (existsSync(bpfPath) && existsSync(applyPath)) {
      return { bpfPath, applyPath }
    }
    return undefined
  } catch {
    return undefined
  }
}
