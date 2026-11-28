import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const loader = fileURLToPath(new URL('./loadPluginCommands.ts', import.meta.url))

const cases = [
  {
    label: 'loads only the skills declared by a marketplace entry without plugin.json',
    skills: ['./skills/selected'],
    expected: ['bundle:selected'],
  },
  {
    label: 'discovers the default skills directory when the entry omits skills',
    skills: undefined,
    expected: ['bundle:selected', 'bundle:sibling'],
  },
]

for (const { label, skills, expected } of cases) {
  test(label, async () => {
    const root = await mkdtemp(join(tmpdir(), 'claudium-plugin-skills-'))
    try {
      const marketplace = join(root, 'marketplace')
      const config = join(root, 'config')
      const plugins = join(config, 'plugins')
      await mkdir(plugins, { recursive: true })
      await mkdir(join(marketplace, '.claude-plugin'), { recursive: true })
      for (const name of ['selected', 'sibling']) {
        const dir = join(marketplace, 'skills', name)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'SKILL.md'), '---\ndescription: Fixture skill\n---\nFixture.\n')
      }
      await writeFile(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'fixture-marketplace',
        owner: { name: 'Fixture' },
        plugins: [
          { name: 'bundle', source: './', strict: false, skills },
          { name: 'other', source: './', strict: false, skills: ['./skills/sibling'] },
        ],
      }))
      await writeFile(join(config, 'settings.json'), JSON.stringify({
        enabledPlugins: { 'bundle@fixture-marketplace': true },
      }))
      await writeFile(join(plugins, 'known_marketplaces.json'), JSON.stringify({
        'fixture-marketplace': {
          source: { source: 'directory', path: marketplace },
          installLocation: marketplace,
          lastUpdated: '2026-01-01T00:00:00Z',
        },
      }))

      const result = Bun.spawnSync([
        process.execPath, '--eval',
        `import { getPluginSkills } from ${JSON.stringify(loader)};
         console.log(JSON.stringify((await getPluginSkills()).map(skill => skill.name).sort()));`,
      ], {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: config,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5_000,
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
