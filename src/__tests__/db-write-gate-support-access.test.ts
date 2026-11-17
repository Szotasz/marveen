// SUPPORTKULCS1109, D5 (terv-v7 3.9): the support state of this machine (one folder, ~/.marveen/support) and the two
// support tables (support_consents, support_password_state) are written by the routine and the dashboard only, never
// by a tool call of any agent, the main agent included. Reads stay free. HOME points at a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'support-d5-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  mkdirSync(join(home, '.marveen', 'support', 'kit'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const o = (subAgent: boolean) => ({ root, cwd: root, subAgent, projectDir: root, configDir: null })
const bash = (c: string, subAgent = false) => gateDecision('Bash', { command: c }, o(subAgent))
const write = (p: string, subAgent = false) => gateDecision('Write', { file_path: p, content: 'x' }, o(subAgent))
const S = () => join(home, '.marveen', 'support')

describe('D5: the support tables are security tables', () => {
  it.each([
    `sqlite3 store/claudeclaw.db "DELETE FROM support_consents"`,
    `sqlite3 store/claudeclaw.db "UPDATE support_consents SET revoked_at = NULL"`,
    `sqlite3 store/claudeclaw.db "INSERT INTO support_consents (grant_id) VALUES ('x')"`,
    `sqlite3 store/claudeclaw.db "DELETE FROM support_password_state"`,
    `sqlite3 store/claudeclaw.db "UPDATE main.support_password_state SET state = '{}'"`,
    `python3 -c "import sqlite3; sqlite3.connect('store/claudeclaw.db').execute('DROP TABLE support_password_state')"`,
  ])('denies %s, for the main agent too', (c) => {
    expect(bash(c)).toMatchObject({ deny: true, reason: 'db' })
    expect(bash(c, true)).toMatchObject({ deny: true })
  })

  it('a read of them passes', () => {
    expect(bash(`sqlite3 store/claudeclaw.db "SELECT * FROM support_consents"`)).toEqual({ deny: false })
    expect(bash(`sqlite3 -readonly store/claudeclaw.db "SELECT state FROM support_password_state"`)).toEqual({ deny: false })
  })
})

describe('D5: the support folder is protected for every agent', () => {
  it.each([
    ['the token', () => join(S(), 'support-access.token')],
    ['the group record', () => join(S(), 'support-access.group')],
    ['the dispatcher in the kit', () => join(S(), 'kit', 'support-dispatch.sh')],
    ['the kit manifest', () => join(S(), 'kit', 'manifest')],
    ['a spool event', () => join(S(), 'support-access.spool', '1.2.0.evt')],
  ])('the Write tool on %s is denied, the main agent included', (_label, p) => {
    expect(write(p())).toMatchObject({ deny: true })
    expect(write(p(), true)).toMatchObject({ deny: true })
  })

  it.each([
    () => `rm -rf ${S()}`,
    () => `echo mst_x > ${S()}/support-access.token`,
    () => `cp /tmp/evil.sh ${S()}/kit/support-dispatch.sh`,
    () => `rm -rf ~/.marveen/support`,
    () => `mv ~/.marveen/support/kit ~/.marveen/support/kit.old`,
  ])('a shell write is denied: %s', (c) => {
    expect(bash(c())).toMatchObject({ deny: true })
  })

  it.each([
    () => `ls -la ${S()}`,
    () => `cat ${S()}/kit/manifest`,
    () => `ls -d ~/.marveen/support 2>&1 | head -1`,
    () => `grep -c evt ${S()}/support-access.spool/1.evt`,
  ])('a read passes: %s', (c) => {
    expect(bash(c())).toEqual({ deny: false })
  })

  it('another folder next to it stays free', () => {
    expect(write(join(home, '.marveen', 'other', 'x.txt'))).toEqual({ deny: false })
    expect(bash(`echo x > ${join(home, '.marveen', 'support-notes.txt')}`)).toEqual({ deny: false })
  })
})
