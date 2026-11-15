// SUPPORTKULCS1109 (Dani's review of #2788 (2), Samu 78723): a sub-agent may not READ the narrow support token
// (~/.marveen/support/support-access.token), whatever spelling of its folder leads to it; the rest of the folder stays
// readable. Decisions only: nothing here reads a token. HOME points at a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs module, no types
import { gateDecision, DENY_MSG, SUPPORT_TOKEN_NAME, supportTokenPaths } from '../../scripts/hooks/mxd-path-gate.mjs'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let savedHome: string | undefined
const CWD = () => join(base, 'ClaudeClaw', 'agents', 'samu')
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'support-token-read-')))
  home = join(base, 'home')
  mkdirSync(join(home, '.marveen', 'support', 'kit'), { recursive: true })
  mkdirSync(join(home, '.marveen', 'support', 'support-access.spool'), { recursive: true })
  writeFileSync(join(home, '.marveen', 'support', SUPPORT_TOKEN_NAME), 'TEST ONLY\n')
  mkdirSync(CWD(), { recursive: true })
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

type V = { deny: boolean, reason?: string }
const bash = (command: string): V => gateDecision('Bash', { command }, { cwd: CWD() })
const tool = (name: string, input: Record<string, unknown>): V => gateDecision(name, input, { cwd: CWD() })
const S = () => join(home, '.marveen', 'support')

describe('the token file', () => {
  it('is the one file under the login user\'s home', () => {
    expect(supportTokenPaths()).toEqual([join(home, '.marveen', 'support', 'support-access.token')])
  })
})

describe('DENY: the token, by any spelling of its folder', () => {
  it.each([
    () => `cat ${S()}/support-access.token`,
    () => `cat ~/.marveen/support/support-access.token`,
    () => `cat "$HOME/.marveen/support/support-access.token"`,
    // A relative path from an ancestor directory: the file name decides here.
    () => `cd ~ && cat .marveen/support/support-access.token`,
    () => `cd / && cat ${S().slice(1)}/support-access.token`,
    () => `D=~/.marveen; cat "$D/support/support-access.token"`,
    () => `cat ~/.marveen/support/support-access.tok'en'`,
    () => `head -c 20 ~/.marveen/support/support-access.token | base64`,
    () => `python3 -c "print(open('${S()}/support-access.token').read())"`,
  ])('%s', (c) => {
    expect(bash(c())).toEqual({ deny: true, reason: 'support-token' })
  })

  it.each([
    () => `cat ${S()}/*`,
    () => `cat ~/.marveen/support/support-access.*`,
    () => `cat ~/.marveen/support/*.token`,
    () => `cd ${S()} && cat *`,
    () => `cd ~/.marveen/support && cat support-acc*`,
  ])('a glob that reaches it: %s', (c) => {
    expect(bash(c())).toMatchObject({ deny: true })
  })

  it.each([
    () => `grep -r mst_ ${S()}`,
    () => `grep -r mst_ ~/.marveen`,
    () => `tar czf /tmp/x.tgz ~/.marveen`,
    () => `cp -r ~/.marveen/support /tmp/copy`,
  ])('a recursive reader on the folder or an ancestor: %s', (c) => {
    expect(bash(c())).toMatchObject({ deny: true })
  })

  it('the native tools: Read of the token by any path, Grep on the folder or an ancestor', () => {
    expect(tool('Read', { file_path: join(S(), 'support-access.token') })).toEqual({ deny: true, reason: 'support-token' })
    expect(tool('Read', { file_path: join(home, '.marveen', 'x', '..', 'support', 'support-access.token') })).toMatchObject({ deny: true })
    expect(tool('Grep', { pattern: 'mst_', path: S() })).toMatchObject({ deny: true })
    expect(tool('Grep', { pattern: 'mst_', path: join(home, '.marveen') })).toMatchObject({ deny: true, reason: 'support-ancestor' })
    expect(tool('Glob', { pattern: '**/support-access.token', path: home })).toMatchObject({ deny: true })
  })

  it('an MCP tool naming it', () => {
    expect(tool('mcp__fs__read_file', { path: join(S(), 'support-access.token') })).toMatchObject({ deny: true })
  })

  // Where the folder cannot be resolved from the text, the FILE NAME alone decides (Samu 78723: any spelling).
  it.each([
    'cd "$SOMEWHERE" && cat support-access.token',
    'cd "$(cat /tmp/where)" && cat support-access.token',
    'cd "$SOMEWHERE" && cat Support-Access.TOKEN',
    'cd "$SOMEWHERE" && cat support-access.tok"en"',
    'cd "$SOMEWHERE" && cat support-access.tok\\en',
  ])('the file name alone, where the folder is unknown: %s', (c) => {
    expect(bash(c)).toEqual({ deny: true, reason: 'support-token' })
  })

  it('the file name in a native or MCP tool\'s input, where no path resolves', () => {
    expect(tool('Read', { file_path: 'support-access.token' })).toEqual({ deny: true, reason: 'support-token' })
    expect(tool('mcp__shell__run', { command: 'cat support-access.token' })).toEqual({ deny: true, reason: 'support-token' })
  })

  it('the deny says what is still open', () => {
    expect(DENY_MSG['support-token']).toContain('support-standby.mjs status')
    expect(DENY_MSG['support-ancestor']).toContain('rekurziv')
  })
})

describe('PASS: the rest of the folder stays readable', () => {
  it.each([
    () => `ls -la ${S()}`,
    () => `ls -d ~/.marveen/support 2>&1 | head -1`,
    () => `cat ${S()}/kit/manifest`,
    () => `cat ~/.marveen/support/support-access.group`,
    () => `ls ${S()}/support-access.spool`,
    () => `grep -c evt ${S()}/support-access.spool/1.evt`,
    () => `node scripts/support-standby.mjs status`,
  ])('%s', (c) => {
    expect(bash(c())).toEqual({ deny: false })
  })

  it('the native tools on another file of the folder', () => {
    expect(tool('Read', { file_path: join(S(), 'kit', 'manifest') })).toEqual({ deny: false })
    expect(tool('Read', { file_path: join(S(), 'support-access.group') })).toEqual({ deny: false })
    expect(tool('Grep', { pattern: 'x', path: join(S(), 'kit') })).toEqual({ deny: false })
  })

  it('the usual work elsewhere', () => {
    expect(bash('grep -rn support src/ | head')).toEqual({ deny: false })
    expect(tool('Grep', { pattern: 'support', path: CWD() })).toEqual({ deny: false })
    expect(tool('Read', { file_path: join(CWD(), 'notes.md') })).toEqual({ deny: false })
  })
})
