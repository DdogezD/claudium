import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const worktree = fileURLToPath(new URL('../', import.meta.url))
const caseFile = fileURLToPath(new URL('../src/components/MarkdownTable.cases.tsx', import.meta.url))

test('runs MarkdownTable regression cases in an isolated child process', () => {
  const result = Bun.spawnSync([process.execPath, 'test', caseFile], {
    cwd: worktree,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  expect(result.exitCode, `${caseFile}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0)
}, 20_000)
