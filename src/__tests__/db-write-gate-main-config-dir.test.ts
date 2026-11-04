// Samu 68206/68210: the MAIN agent's isolated config dir (<root>/.channels-config, MAIN_AGENT_ISOLATED_CONFIG) is on the
// db-write-gate's SUB-AGENT list as a directory. Its real files (settings.json with env/permissions/enabledPlugins, a
// settings.local.json created there, the plugin registries) are loaded at the main agent's next start; a sub-agent
// writes none of them, the main agent does. Its symlinked entries resolve into ~/.claude and are judged there (real
// path), so they are not denied by this entry. The decision function only reads paths: nothing is written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let chcfg: string
let elsewhere: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'main-config-dir-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  chcfg = join(root, '.channels-config')
  elsewhere = join(base, 'shared-claude', 'projects')
  mkdirSync(agent, { recursive: true })
  mkdirSync(join(chcfg, 'plugins'), { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(chcfg, 'settings.json'), '{}')
  writeFileSync(join(chcfg, 'plugins', 'installed_plugins.json'), '{}')
  // a symlinked entry, as on a real install (projects -> ~/.claude/projects)
  symlinkSync(elsewhere, join(chcfg, 'projects'))
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const SUB = { deny: true, reason: 'subagent-file' }
const sub = (tool: string, input: Record<string, unknown>) => gateDecision(tool, input, { cwd: agent, root, subAgent: true, projectDir: agent })
const main = (tool: string, input: Record<string, unknown>) => gateDecision(tool, input, { cwd: root, root, subAgent: false, projectDir: root })

describe('a sub-agent may not write the main agent\'s isolated config dir', () => {
  it.each(['settings.json', 'settings.local.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json', 'CLAUDE.md'])(
    'Write / Edit: %s (an existing file and one created there)', (f) => {
      expect(sub('Write', { file_path: join(chcfg, f), content: '{"hooks":{}}' })).toEqual(SUB)
      expect(sub('Edit', { file_path: join(chcfg, f), old_string: '{}', new_string: '{"env":{}}' })).toEqual(SUB)
    })
  it.each([
    'echo x > @C/settings.json',
    'echo x >| @C/settings.local.json',
    'echo x >> @C/settings.json',
    'cp /tmp/evil.json @C/settings.json',
    'mv /tmp/evil.json @C/settings.local.json',
    'rm @C/settings.json',
    "sed -i '' 's/a/b/' @C/settings.json",
    'echo x > ../../.channels-config/settings.json',
    'mv @C @C.old',
  ])('Bash: %s', (command) => {
    expect(sub('Bash', { command: command.replaceAll('@C', chcfg) })).toEqual(SUB)
  })
})

describe('what stays free', () => {
  it('the main agent writes its own config dir', () => {
    expect(main('Write', { file_path: join(chcfg, 'settings.json'), content: '{}' })).toEqual({ deny: false })
    expect(main('Bash', { command: `echo x > ${join(chcfg, 'settings.local.json')}` }).deny).toBe(false)
  })
  it('a read by a sub-agent', () => {
    expect(sub('Bash', { command: `jq -r 'keys' ${join(chcfg, 'settings.json')}` }).deny).toBe(false)
    expect(sub('Bash', { command: `cat ${join(chcfg, 'plugins', 'installed_plugins.json')}` }).deny).toBe(false)
  })
  it('a symlinked entry is judged where it lands (here: a free directory), not as the config dir', () => {
    expect(sub('Write', { file_path: join(chcfg, 'projects', 'x', 'memory', 'note.md'), content: 'x' })).toEqual({ deny: false })
  })
  it('a look-alike directory elsewhere, and an agent\'s own config dir name', () => {
    expect(sub('Write', { file_path: join(agent, '.channels-config', 'settings.json'), content: '{}' })).toEqual({ deny: false })
  })
})

describe('the hook end to end', () => {
  it('a sub-agent caller writing the live install\'s main config settings gets the ENVRELAXGATE1104 message', () => {
    const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
    const installRoot = join(__dirname, '..', '..')
    const e = { ...process.env }
    delete e.CLAUDE_CONFIG_DIR
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(installRoot, '.channels-config', 'settings.json'), content: '{}' }, cwd: join(installRoot, 'agents', 'samu') }),
      encoding: 'utf-8', env: { ...e, CLAUDE_PROJECT_DIR: join(installRoot, 'agents', 'samu') },
    })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('.channels-config')
  })
})
