import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const worktree = fileURLToPath(new URL('../', import.meta.url))
const caseFiles = [
  'src/services/api/client.cases.ts',
  'src/utils/model/modelOptions.cases.ts',
  'src/utils/model/modelDiscoveryRuntime.cases.ts',
  'src/hooks/useTypeahead.cases.tsx',
].map(file => `${worktree}/${file}`)

test('runs isolated model and hook test cases in child processes', () => {
  for (const caseFile of caseFiles) {
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
  }
})
