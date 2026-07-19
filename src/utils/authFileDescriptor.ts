import {
  getApiKeyFromFd,
  setApiKeyFromFd,
} from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Reads an API key from a descriptor supplied by a local CI or provider
 * launcher. The descriptor is consumed once and is never persisted to disk or
 * exposed through a remote-session-specific well-known path.
 */
export function getApiKeyFromFileDescriptor(): string | null {
  const cached = getApiKeyFromFd()
  if (cached !== undefined) {
    return cached
  }

  const fdEnv = process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  if (!fdEnv) {
    setApiKeyFromFd(null)
    return null
  }

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    setApiKeyFromFd(null)
    return null
  }

  try {
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`
    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging('File descriptor contained an empty API key', {
        level: 'error',
      })
      setApiKeyFromFd(null)
      return null
    }
    logForDebugging(`Successfully read API key from file descriptor ${fd}`)
    setApiKeyFromFd(token)
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read API key from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    setApiKeyFromFd(null)
    return null
  }
}
