// CHANSTATEWRITE1104 (Marveen 69167, Samu 69174/69201): a sub-agent may not write a channel plugin's trust files
// (who is the owner or an allowed sender, what is paired or approved, which bot identity, an inbound message's
// provenance) under any state root: the shared ~/.claude/channels, the install's .claude/channels and every
// agents/<name>/.claude/channels, its own included. The decision functions only read paths; HOME points at a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let self: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'chan-state-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  self = join(root, 'agents', 'samu')
  for (const d of [join(home, '.claude', 'channels', 'slack'), join(home, '.claude', 'channels', 'teams', 'files'),
    join(root, '.claude', 'channels', 'telegram', 'progress'), join(self, '.claude', 'channels', 'telegram', 'approved'),
    join(root, 'agents', 'geri', '.claude', 'channels', 'slack'), join(self, '.claude-config')]) mkdirSync(d, { recursive: true })
  symlinkSync(join(home, '.claude', 'channels'), join(self, '.claude-config', 'channels'))
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
const o = (subAgent = true) => ({ root, cwd: self, subAgent, projectDir: subAgent ? self : root, configDir: subAgent ? join(self, '.claude-config') : null })
const write = (p: string, subAgent = true) => gateDecision('Write', { file_path: p, content: '{}' }, o(subAgent))
const bash = (c: string) => gateDecision('Bash', { command: c }, o())

const FILES = ['access.json', '.env', 'invites.json', 'inbound-evidence.jsonl', 'inbound-evidence.jsonl.1', 'inbox-pending.jsonl',
  'inbox-draining-4242.jsonl', 'allowlist.json', 'pending.json', 'audit.jsonl', 'own-threads.json', 'bot.pid', 'coordinator.pid',
  'delivered-dms.json', 'delivered-dms.json.tmp.4242']
const roots = () => ({
  'the shared ~/.claude/channels': join(home, '.claude', 'channels', 'slack'),
  "the install's .claude/channels (the main agent's Telegram)": join(root, '.claude', 'channels', 'telegram'),
  "another agent's channels": join(root, 'agents', 'geri', '.claude', 'channels', 'slack'),
  "the caller's OWN channels": join(self, '.claude', 'channels', 'telegram'),
})

describe('every trust file, under every state root: a sub-agent may not write it', () => {
  for (const [label, dir] of Object.entries({ shared: 0, install: 1, other: 2, own: 3 })) {
    it.each(FILES)(`${label}: %s`, (f) => {
      const d = Object.values(roots())[dir]
      expect(write(join(d, f))).toEqual(SUB)
    })
  }
  it('a file inside the trust directories (progress/, approved/)', () => {
    expect(write(join(root, '.claude', 'channels', 'telegram', 'progress', 'x.json'))).toEqual(SUB)
    expect(write(join(self, '.claude', 'channels', 'telegram', 'approved', '123'))).toEqual(SUB)
  })
})

describe('the other routes', () => {
  it("through the agent's config-dir symlink (the real path lands in ~/.claude/channels)", () => {
    expect(write(join(self, '.claude-config', 'channels', 'slack', 'access.json'))).toEqual(SUB)
  })
  it('the shell forms: >, tee, cp into the directory, sed -i', () => {
    expect(bash(`echo '{}' > ${join(home, '.claude', 'channels', 'slack', 'access.json')}`)).toEqual(SUB)
    expect(bash(`echo x | tee ${join(root, 'agents', 'geri', '.claude', 'channels', 'slack', 'invites.json')}`)).toEqual(SUB)
    expect(bash(`cp ${join(base, 'access.json')} ${join(home, '.claude', 'channels', 'slack')}/`).deny).toBe(true)
    expect(bash(`sed -i '' s/a/b/ ${join(self, '.claude', 'channels', 'telegram', 'access.json')}`)).toEqual(SUB)
  })
  it('a bare trust directory name from its parent', () => {
    expect(bash(`cd ${join(root, '.claude', 'channels', 'telegram')} && rm -rf progress`).deny).toBe(true)
    expect(bash(`cd ${join(self, '.claude', 'channels', 'telegram')} && rm -rf approved`).deny).toBe(true)
  })
  it('SLACKOUTDM1007: delivered-dms.json and its temporary name, by the shell and through the config-dir symlink', () => {
    const slack = join(home, '.claude', 'channels', 'slack')
    expect(write(join(self, '.claude-config', 'channels', 'slack', 'delivered-dms.json'))).toEqual(SUB)
    expect(bash(`echo '{}' > ${join(slack, 'delivered-dms.json')}`)).toEqual(SUB)
    expect(bash(`printf x > ${join(slack, 'delivered-dms.json.tmp.1')} && mv ${join(slack, 'delivered-dms.json.tmp.1')} ${join(slack, 'delivered-dms.json')}`).deny).toBe(true)
    expect(bash(`cp ${join(base, 'x.json')} ${join(root, 'agents', 'geri', '.claude', 'channels', 'slack', 'delivered-dms.json')}`).deny).toBe(true)
    expect(bash(`rm ${join(self, '.claude', 'channels', 'telegram', 'delivered-dms.json')}`).deny).toBe(true)
  })
  it('SLACKOUTDM1007: a look-alike name is not the trust file', () => {
    const slack = join(home, '.claude', 'channels', 'slack')
    expect(write(join(slack, 'delivered-dms.json.bak'))).toEqual(FREE)
    expect(write(join(slack, 'delivered-dms.jsonx'))).toEqual(FREE)
    expect(bash(`cat ${join(slack, 'delivered-dms.json')}`)).toEqual(FREE)
  })
  it('a case-folded name', () => {
    expect(write(join(home, '.claude', 'channels', 'slack', 'Access.JSON'))).toEqual(SUB)
  })
})

describe('left free', () => {
  it('the non-trust state: inbox/, sessions/, outbound-gate.log, Teams files/ and outbox/', () => {
    for (const p of [join(home, '.claude', 'channels', 'slack', 'inbox', 'm.json'), join(home, '.claude', 'channels', 'slack', 'sessions', 's.json'),
      join(home, '.claude', 'channels', 'slack', 'outbound-gate.log'), join(home, '.claude', 'channels', 'teams', 'files', 'a.pdf'),
      join(home, '.claude', 'channels', 'teams', 'outbox', 'o.json')]) expect(write(p)).toEqual(FREE)
  })
  it('a file of the same name elsewhere', () => {
    expect(write(join(self, 'work', 'access.json'))).toEqual(FREE)
    expect(write(join(base, 'notes', 'bot.pid'))).toEqual(FREE)
  })
  it('reads stay free', () => {
    expect(bash(`cat ${join(home, '.claude', 'channels', 'slack', 'access.json')}`)).toEqual(FREE)
  })
  it('the main agent is not on the sub-agent list', () => {
    expect(write(join(root, '.claude', 'channels', 'telegram', 'access.json'), false)).toEqual(FREE)
  })
})
