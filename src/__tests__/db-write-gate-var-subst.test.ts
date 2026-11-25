// DBGATESUBST1125 -- a quoted command substitution with a variable inside, next to a READ of the dashboard database,
// was denied as a DB write (Marveen's kanban audit, memory 5737, reproduced on develop 506deef8a: all four reads
// below were a deny). The fix lets a variable into a flat substitution only when its command is a pure formatter
// (date, basename, dirname). Every write stays denied, and every other substitution with an expansion stays as it was.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'

// Spelled in two pieces so this file's own text is not a database reference.
const D = 'store/claude' + 'claw.db'
const decide = (command: string) => gateDecision('Bash', { command }, { cwd: '/tmp', root: '/nonexistent-install' })
const ALLOW = { deny: false }
const DENY_DB = { deny: true, reason: 'db' }

describe('a read next to a quoted formatter substitution with a variable passes', () => {
  it.each([
    ['the 5737 shape: LAST=$(jq), "$(date -r $LAST)", two reads with $LAST',
      `LAST=$(jq -r '.last' s.json); echo "utolso: $(date -r $LAST)"; sqlite3 ${D} "SELECT id FROM kanban_cards WHERE updated_at > $LAST"; sqlite3 ${D} "SELECT count(*) FROM kanban_comments WHERE created_at > $LAST"`],
    ['"$(date -r $X)" then a read', `echo "$(date -r $X)"; sqlite3 ${D} "SELECT 1"`],
    ['a read then "$(date -r $X)"', `sqlite3 ${D} "SELECT 1"; echo "$(date -r $X)"`],
    ['${NAME} form', `echo "$(date -r \${LAST})"; sqlite3 ${D} "SELECT 1"`],
    ['basename and dirname', `echo "$(basename $F) $(dirname $F)"; sqlite3 ${D} "SELECT 1"`],
    ['the literal form (control, already allowed)', `echo "$(date -r 1)"; sqlite3 ${D} "SELECT 1"`],
  ])('%s', (_name, command) => {
    expect(decide(command)).toEqual(ALLOW)
  })
})

describe('the gate does not loosen: writes and other expansions stay denied', () => {
  it.each([
    ['a security-table write next to it', `echo "$(date -r $X)"; sqlite3 ${D} "UPDATE approvals SET status=1"`],
    ['a write inside the quoted substitution', `echo "$(sqlite3 ${D} "UPDATE approvals SET status=1")"`],
    ['a read inside a quoted substitution (Samu 60400, kept)', `echo "x: $(sqlite3 -readonly ${D} "SELECT count(*) FROM agent_messages")"`],
    ['a write built in a substitution and piped in', `echo "$(printf 'UPDATE approvals SET status=1')" | sqlite3 ${D}`],
    ['a file-level write of the database next to it', `echo "$(date -r $X)"; cp /tmp/x ${D}`],
    ['date with a nested substitution', `echo "$(date -r $(cat f))"; sqlite3 ${D} "UPDATE approvals SET status=1"`],
    ['date with a redirect inside', `echo "$(date -r $X > ${D})"; sqlite3 ${D} "SELECT 1"`],
    ['date with an arithmetic expansion next to a write', `echo "$(date -r $((X+1)))"; sqlite3 ${D} "UPDATE approvals SET status=1"`],
    ['a non-formatter with a variable (cat) next to a write', `echo "$(cat $F)"; sqlite3 ${D} "UPDATE approvals SET status=1"`],
    ['SQL write text inside a formatter substitution stays a reference', `echo "$(date -r $X UPDATE approvals SET status=1)"`],
  ])('%s', (_name, command) => {
    expect(decide(command)).toEqual(DENY_DB)
  })
  it('a variable in a substitution whose command is not a formatter is still not resolved (the read stays denied)', () => {
    // python could write the database itself, stat is simply not on the list
    expect(decide(`echo "$(python3 $S)"; sqlite3 ${D} "SELECT 1"`)).toEqual(DENY_DB)
    expect(decide(`echo "$(stat -f %m $X)"; sqlite3 ${D} "SELECT 1"`)).toEqual(DENY_DB)
  })
  it('only a plain $NAME / ${NAME}: a parameter expansion with an operator is not resolved', () => {
    expect(decide(`echo "$(date -r \${X:-1})"; sqlite3 ${D} "SELECT 1"`)).toEqual(DENY_DB)
  })
  it('a redirect inside the formatter substitution onto the database stays denied', () => {
    expect(decide(`echo "$(date -r $X > ${D})"`)).toEqual(DENY_DB)
  })
})

// The resolved tail made one existing test's command readable (db-write-gate.test.ts, "a hard reset after a cd that does
// not run"), and it showed that the git rule itself let `cd <install>; false && cd /tmp; git reset --hard` through: the
// deny came only from the unreadable "$(date +%s $y)" tail. The git rule now reads the directory before a cd that runs
// on a condition (&&, ||); an unconditional cd to an existing worktree stays open (#2384).
describe('git: a cd that may not run leaves the install possible', () => {
  let base: string
  let root: string
  let other: string
  let inRoot: string
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'dbsubst-git-'))
    root = join(base, 'install')
    other = join(base, 'wt')
    mkdirSync(root)
    mkdirSync(other)
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['init', '-q', other])
    inRoot = join(root, 'sub', 'x')
    mkdirSync(inRoot, { recursive: true })
  })
  afterAll(() => { rmSync(base, { recursive: true, force: true }) })
  const git = (command: string, cwd: string) => gateDecision('Bash', { command }, { cwd, root })
  it.each([
    ['false && cd /tmp; git reset --hard', (r: string) => `cd ${r}; false && cd /tmp; git reset --hard`],
    ['true || cd /tmp; git reset --hard', (r: string) => `cd ${r}; true || cd /tmp; git reset --hard`],
  ])('%s, after a cd into the install, is a deny', (_name, cmd) => {
    expect(git(cmd(root), base)).toEqual({ deny: true, reason: 'git' })
  })
  it('[ -d wt ] && cd wt; git commit, from inside the install, is a deny', () => {
    expect(git(`[ -d ${other} ] && cd ${other}; git commit -m x`, inRoot)).toEqual({ deny: true, reason: 'git' })
  })
  it.each([
    ['an unconditional cd to an existing worktree (#2384)', (o: string) => `cd ${o}; git commit -m x`],
    ['cd wt && git', (o: string) => `cd ${o} && git commit -m x`],
    ['a conditional cd followed by an unconditional one', (o: string) => `false && cd /tmp; cd ${o}; git commit -m x`],
    ['git -C wt', (o: string) => `git -C ${o} commit -m x`],
  ])('%s, from inside the install, stays open', (_name, cmd) => {
    expect(git(cmd(other), inRoot)).toEqual({ deny: false })
  })
})
