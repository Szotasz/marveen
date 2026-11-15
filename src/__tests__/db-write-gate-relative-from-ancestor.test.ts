// WRITEGATERELPATH1115: a protected path named by a RELATIVE path from an ANCESTOR directory, for the protected paths
// under the home as for those in the install. The write gate follows the directory a command moves to, resolves the
// home spellings of a directory change, and reads a relative word after a change to an unknown directory against every
// protected path's tail (fail closed). Decisions only; HOME and the install root are temp dirs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let savedHome: string | undefined
let savedXdg: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'rel-ancestor-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  mkdirSync(join(home, '.config', 'git'), { recursive: true })
  mkdirSync(join(home, 'projects', 'app'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '')
  mkdirSync(join(root, 'agents', 'samu'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  savedHome = process.env.HOME
  savedXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
  rmSync(base, { recursive: true, force: true })
})

const cwd = () => join(root, 'agents', 'samu')
const bash = (c: string, subAgent = false) => gateDecision('Bash', { command: c }, { root, cwd: cwd(), subAgent, projectDir: subAgent ? cwd() : root, configDir: null })
const DENY = { deny: true, reason: 'install-file' }
const PASS = { deny: false }

// <HOME> and <BASE> are filled in when the test runs (the temp dirs exist only then)
const HOME_SPELLINGS = ['cd ~', 'cd $HOME', 'cd "$HOME"', 'cd ${HOME}', 'cd <HOME>', 'cd', 'cd <BASE> && cd home',
  'pushd ~', 'pushd $HOME', 'pushd <HOME>']
const fill = (c: string) => c.replace('<HOME>', home).replace('<BASE>', base)
const writes = (rel: string) => [`echo x > ${rel}`, `rm -f ${rel}`, `cp /tmp/a ${rel}`, `tee ${rel} < /tmp/a`, `mv /tmp/a ${rel}`]

describe('a relative path from an ancestor directory reaches a protected home path', () => {
  for (const rel of ['.gitconfig', '.config/git/config']) {
    // the test names carry the class only, the spelling is in the assertion message
    it.each(HOME_SPELLINGS.map((c, i) => [i + 1, c] as const))(`ancestor spelling %i: every write of a protected home path is denied`, (_n, cd) => {
      for (const w of writes(rel)) expect(bash(`${fill(cd)} && ${w}`), `${cd} && ${w}`).toEqual(DENY)
    })
  }

  it('also for a sub-agent, and joined by ; as well as &&', () => {
    expect(bash('cd ~ && echo x > .gitconfig', true)).toMatchObject({ deny: true })
    expect(bash('cd ~; echo x > .gitconfig')).toEqual(DENY)
  })

  it('a bare name from a directory that holds the protected path', () => {
    expect(bash('cd ~/.config && rm -rf git')).toEqual(DENY)
    expect(bash(`cd ${join(home, '.config')} && mv git /tmp/old`)).toEqual(DENY)
  })

  it('a directory change to an unknown place: the relative word is read against the protected tails (fail closed)', () => {
    expect(bash('cd "$WHERE" && echo x > .gitconfig')).toEqual(DENY)
    expect(bash('cd - && rm -f .config/git/config')).toEqual(DENY)
    expect(bash('pushd /tmp && popd && echo x > .gitconfig')).toEqual(DENY)
    expect(bash('cd "$(cat /tmp/where)" && echo x > git/config')).toEqual(DENY)
    // a command that sets HOME itself: its ~ is not the real home, so the place is unknown (not the real home, where
    // this relative path would name nothing protected)
    expect(bash('HOME=/tmp/h; cd ~ && echo x > .gitconfig')).toEqual(DENY)
    expect(bash('HOME=/tmp/h; cd ~ && echo x > git/config')).toEqual(DENY)
    // a bare name, too: it may be a directory on the way to a protected path
    expect(bash('cd "$WHERE" && mv git /tmp/old')).toEqual(DENY)
  })
})

describe('positive control: the absolute and the install-root spellings stay denied', () => {
  it.each([
    () => `echo x > ${home}/.gitconfig`,
    () => `rm -f ${home}/.config/git/config`,
    () => 'echo x > ~/.gitconfig',
    () => `cd /tmp && echo x > ${home}/.gitconfig`,
    () => `cd ${root} && echo x > store/autonomy-config.json`,
    () => `echo x > ${root}/store/autonomy-config.json`,
  ])('%s', (c) => {
    expect(bash(c())).toEqual(DENY)
  })
})

describe('no over-blocking from an ancestor or an unknown directory', () => {
  it.each([
    'cd ~ && ls -la',
    'cd ~ && cat .gitconfig',
    'cd ~ && git config --get user.name',
    'cd ~ && echo x > notes.txt',
    'cd ~/projects && rm -rf app/build',
    'cd ~/.config && ls git',
    'cd "$WHERE" && rm -rf build',
    'cd "$WHERE" && echo x > out.txt',
    'cd - && ls',
  ])('%s passes', (c) => {
    expect(bash(c)).toEqual(PASS)
  })
})
