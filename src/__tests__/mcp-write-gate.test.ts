// MCPWRITEGATE1104: the path gates judge an MCP tool's path arguments on their own engines. A written file is judged
// as the native Write's file_path; a mover's path and a directory a file lands in under a name the call does not fix
// are also denied as a protected path's ANCESTOR. An unknown MCP writer (a name the gates have never seen) is
// covered by its tool-name class (Dani 68004 (3): it must not pass). The decision functions only read paths.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as dbGate, INSTALL_ROOT } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as paceGate } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'

let base: string
let root: string
let agent: string
let store: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-write-gate-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'samu')
  store = join(root, 'store')
  for (const d of [join(agent, '.claude'), join(agent, 'work'), store, join(root, '.claude'), join(root, 'scripts', 'hooks'), join(root, 'local-hooks')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), '{}')
  writeFileSync(join(store, 'extra-hooks.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

type O = { subAgent?: boolean; cwd?: string; projectDir?: string | null }
const opts = (o: O = {}) => ({ root, cwd: o.cwd ?? agent, subAgent: o.subAgent ?? true, projectDir: o.projectDir === undefined ? agent : o.projectDir,
  storeDir: store, allowlistPath: join(store, 'egress-allowlist.json') })
const db = (tool: string, input: Record<string, unknown>, o?: O) => dbGate(tool, input, opts(o))
const pace = (tool: string, input: Record<string, unknown>, o?: O) => paceGate(tool, input, opts(o))
const denied = (r: { deny: boolean }) => r.deny === true

describe('db-write-gate: an MCP write onto a protected path is denied, a free path passes', () => {
  it.each(['mcp__Filesystem__write_file', 'mcp__Filesystem__edit_file', 'mcp__Filesystem__create_directory'])('%s', (tool) => {
    expect(db(tool, { path: join(root, '.claude', 'settings.json'), content: 'x' })).toEqual({ deny: true, reason: 'mcp-install-file' })
    expect(db(tool, { path: join(root, 'scripts', 'hooks', 'x.mjs'), content: 'x' })).toEqual({ deny: true, reason: 'mcp-install-file' })
    expect(db(tool, { path: join(agent, 'work', 'notes.md'), content: 'x' })).toEqual({ deny: false })
  })
  it('the database file by name, anywhere', () => {
    expect(db('mcp__Filesystem__write_file', { path: join(store, 'claudeclaw.db'), content: 'x' })).toEqual({ deny: true, reason: 'db' })
  })
  it('a relative path is measured against the payload cwd AND the project dir', () => {
    // the Bash cwd moved to work/, the MCP server still resolves against the project dir
    expect(denied(db('mcp__Filesystem__write_file', { path: '../../.claude/settings.json', content: 'x' }, { cwd: join(agent, 'work') }))).toBe(true)
    expect(denied(db('mcp__Filesystem__write_file', { path: '../../.claude/settings.json', content: 'x' }, { cwd: join(agent, 'work'), projectDir: null }))).toBe(false)
  })
})

describe('db-write-gate: a mover denies a protected path AND its ancestors, on both ends', () => {
  it.each([
    [() => ({ source: join(root, 'store'), destination: '/tmp/s' })],
    [() => ({ source: '/tmp/s', destination: join(root, 'scripts') })],
    [() => ({ source: join(root, '.claude'), destination: '/tmp/c' })],
    [() => ({ source: '/tmp/r', destination: root })],
    [() => ({ source: join(root, '.claude', 'settings.json'), destination: '/tmp/x' })],
  ])('move_file %#', (input) => {
    expect(db('mcp__Filesystem__move_file', input())).toEqual({ deny: true, reason: 'mcp-install-file' })
  })
  it('a move between two free paths passes', () => {
    expect(db('mcp__Filesystem__move_file', { source: join(agent, 'work', 'a'), destination: join(agent, 'work', 'b') })).toEqual({ deny: false })
  })
  it('the ancestor rule reaches the home targets too (~/.gitconfig, ~/.claude.json)', () => {
    expect(denied(db('mcp__x__rename_path', { from: '/tmp/a', to: homedir() }))).toBe(true)
  })
})

describe('db-write-gate: a download whose file name the call does not fix', () => {
  const dl = (input: Record<string, unknown>) => db('mcp__server-gmail-autoauth-mcp__download_attachment', { messageId: '1', attachmentId: '2', ...input })
  it('into a protected directory or above one: denied; the sender picks the name', () => {
    expect(denied(dl({ savePath: store }))).toBe(true)
    expect(denied(dl({ savePath: join(root, '.claude') }))).toBe(true)
    expect(denied(dl({ savePath: agent }))).toBe(true) // agents/<n>/.mcp.json is protected (sub-agent list)
    expect(denied(dl({ savePath: homedir() }))).toBe(true)
  })
  it('a name with ../ is resolved, not trusted', () => {
    expect(denied(dl({ savePath: join(agent, 'work'), filename: '../../../store/extra-hooks.json' }))).toBe(true)
  })
  it('into a free directory: passes, with or without a name', () => {
    expect(dl({ savePath: join(agent, 'work') })).toEqual({ deny: false })
    expect(dl({ savePath: join(agent, 'work'), filename: 'invoice.pdf' })).toEqual({ deny: false })
  })
  it('no savePath at all (the server would use its own cwd): denied', () => {
    expect(dl({})).toEqual({ deny: true, reason: 'mcp-path' })
  })
})

describe('an UNKNOWN MCP writer: its tool-name class decides, not its server (Dani 68004 (3))', () => {
  it.each([
    ['mcp__foo__write_file_v2', () => ({ target: { p: join(store, 'extra-hooks.json') } })],
    ['mcp__plugin_x_disk__saveDocument', () => ({ out: join(root, '.claude', 'settings.json') })],
    ['mcp__whatever__export', () => ({ dest: [join(root, 'scripts', 'hooks', 'a.mjs')] })],
    ['mcp__whatever__copy', () => ({ a: '/tmp/x', b: join(root, 'scripts') })],
  ])('%s onto a protected path: denied', (tool, input) => {
    expect(denied(db(tool, input()))).toBe(true)
  })
  it('a known writer too deeply nested to read in full is denied, not passed', () => {
    let deep: Record<string, unknown> = { p: '/tmp/x' }
    for (let i = 0; i < 10; i++) deep = { d: deep }
    expect(db('mcp__x__write_a', deep)).toEqual({ deny: true, reason: 'mcp-path' })
  })
})

describe('what stays free', () => {
  it.each([
    ['mcp__server-gmail-autoauth-mcp__search_emails', { query: 'from:x subject:y' }],
    ['mcp__server-google-calendar-mcp__create-event', { summary: 'meeting', start: '2026-11-05T10:00' }],
    ['mcp__plugin_telegram_telegram__reply', { chat_id: '1', text: 'kész, a store/extra-hooks.json nem változott' }],
    ['mcp__google-drive__search', { query: 'a/b' }],
  ])('%s', (tool, input) => {
    expect(db(tool, input)).toEqual({ deny: false })
    expect(pace(tool, input)).toEqual({ deny: false })
  })
})

describe('D1 (Samu 68033): the other class (read, send) with a protected path is judged for a SUB-AGENT only', () => {
  const send = () => ({ chat_id: '1', text: 'x', files: [join(root, '.claude', 'settings.json')] })
  it('a sub-agent sending a protected file: denied', () => {
    expect(denied(db('mcp__plugin_telegram_telegram__reply', send()))).toBe(true)
  })
  it('the main agent: passes (it reads its own install legitimately)', () => {
    expect(db('mcp__plugin_telegram_telegram__reply', send(), { subAgent: false, cwd: root, projectDir: root })).toEqual({ deny: false })
  })
  it('the main agent still may not WRITE a protected path through MCP (common list)', () => {
    expect(db('mcp__Filesystem__write_file', { path: join(root, '.claude', 'settings.json'), content: 'x' }, { subAgent: false, cwd: root, projectDir: root }))
      .toEqual({ deny: true, reason: 'mcp-install-file' })
  })
  it('the main agent writes the install .env through MCP; a sub-agent gets the sub-agent message', () => {
    writeFileSync(join(root, '.env'), 'X=1')
    expect(db('mcp__Filesystem__write_file', { path: join(root, '.env'), content: 'x' }, { subAgent: false, cwd: root, projectDir: root })).toEqual({ deny: false })
    expect(db('mcp__Filesystem__write_file', { path: join(root, '.env'), content: 'x' })).toEqual({ deny: true, reason: 'mcp-subagent-file' })
  })
})

describe('self-pace-gate: the same MCP paths against its own protected set', () => {
  it('the egress allowlist, extra-hooks, local-hooks, a protected store file, the schedule store', () => {
    expect(pace('mcp__Filesystem__write_file', { path: join(store, 'egress-allowlist.json'), content: '[]' })).toEqual({ deny: true, reason: 'mcp-egress-allowlist' })
    expect(denied(pace('mcp__Filesystem__write_file', { path: join(store, 'extra-hooks.json'), content: '{}' }))).toBe(true)
    expect(denied(pace('mcp__x__write_a', { p: join(root, 'local-hooks', 'h.py') }))).toBe(true)
    expect(pace('mcp__Filesystem__write_file', { path: join(store, 'config-overrides.json'), content: '{}' })).toEqual({ deny: true, reason: 'mcp-protected-store-file' })
    expect(denied(pace('mcp__Filesystem__write_file', { path: join(homedir(), '.claude', 'scheduled_tasks.json'), content: '[]' }))).toBe(true)
  })
  it('a download with an unknown name into a guarded directory, or a mover above one', () => {
    const dl = (savePath: string) => pace('mcp__server-gmail-autoauth-mcp__download_attachment', { messageId: '1', attachmentId: '2', savePath })
    for (const d of [store, join(root, 'local-hooks'), join(homedir(), '.claude'), join(agent, '.claude-config'), join(homedir(), '.claude', 'scheduled-tasks')]) {
      expect(denied(dl(d))).toBe(true)
    }
    expect(dl(join(agent, 'work'))).toEqual({ deny: false })
    expect(pace('mcp__Filesystem__move_file', { source: store, destination: '/tmp/s' })).toEqual({ deny: true, reason: 'mcp-dir' })
    expect(denied(pace('mcp__Filesystem__move_file', { source: '/tmp/l', destination: join(root, 'local-hooks') }))).toBe(true)
  })
  it('a known writer with no path: denied here too', () => {
    expect(pace('mcp__meshy__meshy_download_model', { task_id: 't' })).toEqual({ deny: true, reason: 'mcp-path' })
  })
})

describe('the hooks end to end', () => {
  const run = (hook: string, tool_name: string, tool_input: Record<string, unknown>, env: Record<string, string>) => {
    const e = { ...process.env }
    delete e.CLAUDE_CONFIG_DIR; delete e.CLAUDE_PROJECT_DIR
    return spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name, tool_input, cwd: env.CLAUDE_PROJECT_DIR }), encoding: 'utf-8', env: { ...e, ...env } })
  }
  const dbHook = join(__dirname, '..', '..', 'scripts', 'hooks', 'db-write-gate.mjs')
  const paceHook = join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
  const subEnv = () => ({ CLAUDE_PROJECT_DIR: join(INSTALL_ROOT, 'agents', 'samu') })
  it('db-write-gate: an MCP write onto this install\'s hook wiring is denied with the MCP message', () => {
    const r = run(dbHook, 'mcp__Filesystem__write_file', { path: join(INSTALL_ROOT, '.claude', 'settings.json'), content: '{}' }, subEnv())
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('MCPWRITEGATE1104')
  })
  it('self-pace-gate: an unknown-name download into the store is denied with the MCP message', () => {
    const r = run(paceHook, 'mcp__x__download_attachment', { messageId: '1', attachmentId: '2', savePath: join(INSTALL_ROOT, 'store') }, subEnv())
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('MCPWRITEGATE1104')
  })
  it('the fast path: an MCP call naming no path passes both hooks, clean', () => {
    for (const hook of [dbHook, paceHook]) {
      const r = run(hook, 'mcp__plugin_telegram_telegram__reply', { chat_id: '1', text: 'szia' }, subEnv())
      expect(r.stdout).toBe('')
      expect(r.status).toBe(0)
    }
  })
})
