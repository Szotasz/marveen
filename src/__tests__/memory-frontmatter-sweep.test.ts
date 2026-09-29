import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// KAPUEGYUT918 PR2: the at-rest sweep reads every fleet memory file with the
// shared parser and REPORTS (never repairs). What these tests pin: a symlinked
// agent projects dir is counted once; the message to Marveen goes out only
// when the broken set changes (new or repaired), not every day; seeing no file
// at all is an instrument error (exit 2), not a clean fleet; a failed message
// is exit 3 and does not advance the state, so the next run retries.

const ROOT = join(__dirname, '..', '..')
const SWEEP = join(ROOT, 'scripts', 'memory-frontmatter-sweep.py')
const GOOD = '---\nname: x\ndescription: "Jo: idezojelben"\nmetadata:\n  type: reference\n---\nbody\n'
const BROKEN = '---\nname: x\ndescription: Rossz: idezojel nelkul\nmetadata:\n  type: reference\n---\nbody\n'

let S: string, HOME: string, REPO: string, MEM: string, STATE: string, SENT: string, MSG: string

function notifier(ok: boolean) {
  MSG = join(S, ok ? 'msg-ok.sh' : 'msg-fail.sh')
  writeFileSync(MSG, ok
    ? `#!/bin/bash\necho "$1 -> $2" >> "${SENT}"\ncat >> "${SENT}"\necho "---" >> "${SENT}"\necho "OK id=1"\n`
    : '#!/bin/bash\necho "FAIL http=500"\nexit 1\n')
  chmodSync(MSG, 0o755)
}

beforeEach(() => {
  S = mkdtempSync(join(tmpdir(), 'memfm-sweep-'))
  HOME = join(S, 'home')
  MEM = join(HOME, '.claude', 'projects', '-Users-x-ClaudeClaw', 'memory')
  mkdirSync(MEM, { recursive: true })
  REPO = join(S, 'repo')
  // An agent whose .claude-config/projects is a symlink to the shared projects dir.
  mkdirSync(join(REPO, 'agents', 'geri', '.claude-config'), { recursive: true })
  symlinkSync(join(HOME, '.claude', 'projects'), join(REPO, 'agents', 'geri', '.claude-config', 'projects'))
  STATE = join(S, 'state.json')
  SENT = join(S, 'sent.txt')
  notifier(true)
  writeFileSync(join(MEM, 'reference_a.md'), GOOD)
  writeFileSync(join(MEM, 'MEMORY.md'), 'index, no frontmatter')
})

function sweep() {
  const r = spawnSync('python3', [SWEEP, '--home', HOME, '--repo', REPO, '--state', STATE, '--notify', '--agent-msg', MSG], { encoding: 'utf8', timeout: 15_000 })
  return { code: r.status, out: r.stdout }
}
const sent = () => (existsSync(SENT) ? readFileSync(SENT, 'utf8') : '')

describe('memory-frontmatter-sweep', () => {
  it('a clean fleet: exit 0, no message; the symlinked agent dir is counted once; MEMORY.md is skipped', () => {
    const r = sweep()
    expect(r.code).toBe(0)
    expect(r.out).toContain('memoriafajl: 1 ')
    expect(sent()).toBe('')
  })

  it('a new broken file: exit 1 and ONE message to Marveen (from heartbeat) naming it', () => {
    writeFileSync(join(MEM, 'feedback_b.md'), BROKEN)
    const r = sweep()
    expect(r.code).toBe(1)
    expect(sent()).toContain('heartbeat -> marveen')
    expect(sent()).toContain('UJ: ')
    expect(sent()).toContain('feedback_b.md')
  })

  it('the same broken set the next day: exit 1, but no repeated message', () => {
    writeFileSync(join(MEM, 'feedback_b.md'), BROKEN)
    sweep()
    const before = sent()
    const r = sweep()
    expect(r.code).toBe(1)
    expect(sent()).toBe(before)
  })

  it('a repaired file: exit 0 and a message saying what was repaired', () => {
    writeFileSync(join(MEM, 'feedback_b.md'), BROKEN)
    sweep()
    writeFileSync(join(MEM, 'feedback_b.md'), GOOD)
    const r = sweep()
    expect(r.code).toBe(0)
    expect(sent()).toContain('javult: ')
  })

  it('no memory file at all is an instrument error (exit 2), not a clean fleet', () => {
    const r = spawnSync('python3', [SWEEP, '--home', join(S, 'empty'), '--repo', join(S, 'empty'), '--state', STATE], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('MUSZER-HIBA')
  })

  it('a source that yields nothing is exit 2 even when the other one does (a glob skips a blind directory silently)', () => {
    // agent config dirs exist, but their projects link points nowhere readable
    const blind = join(S, 'repo2')
    mkdirSync(join(blind, 'agents', 'geri', '.claude-config', 'projects'), { recursive: true })
    const r = spawnSync('python3', [SWEEP, '--home', HOME, '--repo', blind, '--state', STATE], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('felig vak')
    // and the home tree alone missing, with a readable agent tree
    const r2 = spawnSync('python3', [SWEEP, '--home', join(S, 'nohome'), '--repo', REPO, '--state', STATE], { encoding: 'utf8' })
    expect(r2.status).toBe(2)
  })

  it('a repo without agent config dirs is not blind (a host with no sub-agents)', () => {
    const r = spawnSync('python3', [SWEEP, '--home', HOME, '--repo', join(S, 'noagents'), '--state', STATE], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('a failed message: exit 3, the state does not advance, the next run sends it', () => {
    writeFileSync(join(MEM, 'feedback_b.md'), BROKEN)
    notifier(false)
    expect(sweep().code).toBe(3)
    expect(existsSync(STATE)).toBe(false)
    notifier(true)
    expect(sweep().code).toBe(1)
    expect(sent()).toContain('feedback_b.md')
  })

  it('never writes to a memory file (report only)', () => {
    writeFileSync(join(MEM, 'feedback_b.md'), BROKEN)
    sweep()
    expect(readFileSync(join(MEM, 'feedback_b.md'), 'utf8')).toBe(BROKEN)
  })
})
