// WORKERCFGDIR1104 (Dani 68629, Samu 68631): the two background workers' config dirs
// (~/.marveen-worker{,-fast}/.claude-config) are on the db-write-gate's sub-agent list as whole directories, like
// .channels-config. The worker itself already could not write its own settings (callerSettingsEntries); another
// sub-agent could, and a hooks entry in the worker's settings.json would stay. A renamed install's worker homes
// (~/.<MAIN_AGENT_ID>-worker{,-fast}) are added per call from the install's settings. The decision functions only read
// paths; HOME points at a temp dir for every test, so nothing here touches the real home directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, workerConfigEntries } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let agent: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-config-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  mkdirSync(join(agent, '.claude-config'), { recursive: true })
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  for (const w of ['.marveen-worker', '.marveen-worker-fast']) {
    const cfg = join(home, w, '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'settings.json'), '{}')
    symlinkSync(join(home, '.claude', 'projects'), join(cfg, 'projects'))
  }
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const SUB = { deny: true, reason: 'subagent-file' }
const FREE = { deny: false }
const o = (subAgent = true) => ({ root, cwd: agent, subAgent, projectDir: subAgent ? agent : root, configDir: subAgent ? join(agent, '.claude-config') : null })
const write = (p: string, subAgent = true) => gateDecision('Write', { file_path: p, content: '{"hooks":{}}' }, o(subAgent))
const bash = (c: string, subAgent = true) => gateDecision('Bash', { command: c }, o(subAgent))
const cfg = (w = '.marveen-worker') => join(home, w, '.claude-config')

describe('another sub-agent may not write a worker\'s config dir', () => {
  const files = ['settings.json', 'settings.local.json', '.claude.json', 'worker-mcp.json', '.credentials.json', 'state/new.json']
  it.each(['.marveen-worker', '.marveen-worker-fast'])('native Write and Edit, every real file in %s, a new one too', (w) => {
    for (const f of files) {
      expect(write(join(cfg(w), f))).toEqual(SUB)
      expect(gateDecision('Edit', { file_path: join(cfg(w), f), old_string: '{}', new_string: '{"hooks":{}}' }, o())).toEqual(SUB)
    }
  })
  it('the shell forms: >, >>, tee, cp, mv, rm, and the directory itself', () => {
    const s = join(cfg(), 'settings.json')
    expect(bash(`echo '{"hooks":{}}' > ${s}`)).toEqual(SUB)
    expect(bash(`echo x >> ${join(cfg('.marveen-worker-fast'), 'settings.json')}`)).toEqual(SUB)
    expect(bash(`echo x | tee ${join(cfg(), 'worker-mcp.json')}`)).toEqual(SUB)
    expect(bash(`cp /etc/hosts ${join(cfg(), '.claude.json')}`)).toEqual(SUB)
    expect(bash(`mv ${join(base, 'x')} ${cfg()}/settings.json`)).toEqual(SUB)
    // removing the whole dir is denied (the common list may already catch it first, by its own reason)
    expect(bash(`rm -rf ${cfg()}`).deny).toBe(true)
    expect(bash('echo x > ~/.marveen-worker/.claude-config/settings.json')).toEqual(SUB)
  })
  it('through a symlink under another name (the real path is compared)', () => {
    symlinkSync(cfg(), join(agent, 'innocent'))
    expect(write(join(agent, 'innocent', 'settings.json'))).toEqual(SUB)
  })
  it('the parent home is not listed: a file next to the config dir stays free', () => {
    expect(write(join(home, '.marveen-worker', 'notes.txt'))).toEqual(FREE)
  })
  it('a symlinked entry is judged where it lands: projects -> ~/.claude/projects stays free', () => {
    expect(write(join(cfg(), 'projects', 'x', 'memory', 'a.md'))).toEqual(FREE)
  })
  it('reads stay free', () => {
    expect(bash(`cat ${join(cfg(), 'settings.json')}`)).toEqual(FREE)
  })
  it('the main agent is not on the sub-agent list', () => {
    expect(write(join(cfg(), 'settings.json'), false)).toEqual(FREE)
    expect(bash(`echo x > ${join(cfg('.marveen-worker-fast'), 'settings.json')}`, false)).toEqual(FREE)
  })
})

describe('a renamed install (MAIN_AGENT_ID): its workers\' homes, per call', () => {
  it('from the .env: both dirs denied, the default homes still are', () => {
    writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=gromzo\n')
    expect(workerConfigEntries(root).map((e: { rel: string }) => e.rel)).toEqual(['.gromzo-worker/.claude-config', '.gromzo-worker-fast/.claude-config'])
    expect(write(join(home, '.gromzo-worker', '.claude-config', 'settings.json'))).toEqual(SUB)
    expect(write(join(home, '.gromzo-worker-fast', '.claude-config', '.claude.json'))).toEqual(SUB)
    expect(write(join(cfg(), 'settings.json'))).toEqual(SUB)
  })
  it('the overrides file wins over the .env', () => {
    writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=gromzo\n')
    mkdirSync(join(root, 'store'), { recursive: true })
    writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify({ MAIN_AGENT_ID: 'boti' }))
    expect(workerConfigEntries(root).map((e: { rel: string }) => e.rel)).toEqual(['.boti-worker/.claude-config', '.boti-worker-fast/.claude-config'])
  })
  it('no id, the default id, or an id that is not a plain name adds nothing', () => {
    expect(workerConfigEntries(root)).toEqual([])
    for (const id of ['marveen', '../x', 'a/b', 'a b', '']) {
      writeFileSync(join(root, '.env'), `MAIN_AGENT_ID=${id}\n`)
      expect(workerConfigEntries(root)).toEqual([])
    }
    writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=gromzo\n')
    expect(write(join(home, '.other-worker', '.claude-config', 'settings.json'))).toEqual(FREE)
  })
})
