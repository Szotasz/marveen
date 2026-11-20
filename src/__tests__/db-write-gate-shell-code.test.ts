// Refs #2974, #2975: the code a command hands to a shell (sh/bash -c, eval, a shell reading a heredoc or a here-string
// on stdin, a nested -c) is judged as a command of its own, with the same rules as the top level. Before this, the
// file-level database rule did not reach a `-c` code (#2974: `bash -c 'rm <db>'` passed while `rm <db>` was denied),
// and a `cd $X` (an unknown directory, read as the install) did not carry into it (#2975: in a sub-agent's context
// `bash -c 'cd $X && echo x > scripts/hooks/f'` passed while the same without `bash -c` was denied). Decisions only;
// nothing is executed, the root is a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-shell-code-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'probe')
  for (const d of ['.claude', 'scripts/hooks', 'store', 'agents/probe']) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const main = (c: string) => gateDecision('Bash', { command: c.replaceAll('@R@', root) }, { root, cwd: root })
const sub = (c: string) => gateDecision('Bash', { command: c.replaceAll('@R@', root) }, { root, cwd: agent, subAgent: true, projectDir: agent })
const DB = { deny: true, reason: 'db' }
const ALLOW = { deny: false }

describe('#2974: a file-level database write as shell code is denied, as the same write at the top level', () => {
  it.each([
    ['rm, bash -c', "bash -c 'rm store/claudeclaw.db'"],
    ['a redirect, sh -c in double quotes', 'sh -c "echo x > store/claudeclaw.db"'],
    ['cp to the absolute path, behind timeout', "timeout 5 bash -c 'cp /tmp/x.db @R@/store/claudeclaw.db'"],
    ['the -wal file', "bash -c 'rm -f store/claudeclaw.db-wal'"],
    ['mv, bash -lc', "bash -lc 'mv /tmp/x.db store/claudeclaw.db'"],
    ['eval', "eval 'rm store/claudeclaw.db'"],
    ['a -c inside a -c', `bash -c "sh -c 'rm store/claudeclaw.db'"`],
    ['a shell reading a heredoc', "sh <<'EOF'\nrm store/claudeclaw.db\nEOF"],
    ['a shell reading a here-string', "bash <<< 'rm store/claudeclaw.db'"],
  ])('%s: denied for the main agent and a sub-agent', (_, cmd) => {
    expect(main(cmd)).toEqual(DB)
    expect(sub(cmd)).toEqual(DB)
  })
  it('the top-level forms stay denied (the reference rows)', () => {
    expect(main('rm store/claudeclaw.db')).toEqual(DB)
    expect(sub('echo x > store/claudeclaw.db')).toEqual(DB)
  })
  it('a read of the database as shell code still passes', () => {
    expect(main("bash -c 'ls -l store/claudeclaw.db'")).toEqual(ALLOW)
    expect(sub(`bash -c "sqlite3 -readonly store/claudeclaw.db 'SELECT 1'"`)).toEqual(ALLOW)
  })
  it('shell code that names no protected path passes', () => {
    expect(main("bash -c 'rm /tmp/x.db && echo done'")).toEqual(ALLOW)
  })
  it('a heredoc that is a script file\'s stdin is data, not shell code: passes; with -s the shell reads it as code: denied', () => {
    expect(main("bash /tmp/x.sh <<'E'\nrm store/claudeclaw.db\nE")).toEqual(ALLOW)
    expect(main("bash -s <<'E'\nrm store/claudeclaw.db\nE")).toEqual(DB)
    expect(main("bash -s arg1 <<'E'\nrm store/claudeclaw.db\nE")).toEqual(DB)
  })
  it('shell code nested deeper than the reading goes is denied (fail closed)', () => {
    let cmd = 'echo ok'
    for (let i = 0; i < 9; i++) cmd = `bash -c ${JSON.stringify(cmd)}`
    expect(main(cmd).deny).toBe(true)
    let shallow = 'echo ok'
    for (let i = 0; i < 3; i++) shallow = `bash -c ${JSON.stringify(shallow)}`
    expect(main(shallow)).toEqual(ALLOW)
  })
})

describe('#2975: a cd to an unknown directory carries into shell code', () => {
  const INSTALL = { deny: true, reason: 'install-file' }
  it.each([
    ['bash -c, single quotes', "bash -c 'cd $X && echo x > scripts/hooks/f.mjs'"],
    ['bash -c, double quotes', 'bash -c "cd $X && echo x > scripts/hooks/f.mjs"'],
    ['sh -c, a quoted variable and ;', `sh -c 'cd "$X"; echo x > scripts/hooks/f.mjs'`],
    ['a -c inside a -c', `bash -c "sh -c 'cd \\$X && echo x > scripts/hooks/f.mjs'"`],
  ])('%s: denied for a sub-agent, as the top-level form is', (_, cmd) => {
    expect(sub('cd $X && echo x > scripts/hooks/f.mjs')).toEqual(INSTALL)
    expect(sub(cmd)).toEqual(INSTALL)
  })
  it('the shell code is judged in the caller\'s own context: a write only a sub-agent may not do is denied for it, not for the main agent', () => {
    expect(sub('echo X=1 >> @R@/.env')).toEqual({ deny: true, reason: 'subagent-file' })
    expect(sub("bash -c 'echo X=1 >> @R@/.env'")).toEqual({ deny: true, reason: 'subagent-file' })
    expect(main("bash -c 'echo X=1 >> @R@/.env'")).toEqual(ALLOW)
    // only the inner reading with the caller's context decides this one (mutant K5): the unknown directory is the
    // install, whose .env only a sub-agent may not write
    expect(sub('cd $X && echo A=1 >> .env')).toEqual({ deny: true, reason: 'subagent-file' })
    expect(sub("bash -c 'cd $X && echo A=1 >> .env'")).toEqual({ deny: true, reason: 'subagent-file' })
    expect(main("bash -c 'cd $X && echo A=1 >> .env'")).toEqual(ALLOW)
  })
  it('a cd to a known directory outside the install, as shell code: passes', () => {
    expect(sub("bash -c 'cd /tmp && echo x > scripts/hooks/f.mjs'")).toEqual(ALLOW)
  })
})
