// ENVRELAXGATE1104 (Samu 67818, Marveen 67806): the two workers (marveen-worker, marveen-worker-fast) carried ONE
// PreToolUse hook, the fleet-freeze gate. They now also get the db-write-gate (the sub-agents' generator) and the
// outgoing-copy gate on Bash and the email tools (as the main agent's tracked settings carry it), written on every
// worker boot. Then a harness, NOT live: with the worker's identity (project dir = its own home outside the install,
// config dir = its .claude-config) the db-write-gate lets the reads such a run makes through and stops the writes the
// sub-agent list names; the copy gate lets a plain Bash read through.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { withWorkerGates, WORKER_FREEZE_GATE_CMD, WORKER_MAIL_GATE_MATCHER } from '../web/agent-worker.js'
import { DB_WRITE_GATE_MATCHER, EMAIL_GATE_MATCHER, TELEGRAM_COPY_GATE_MATCHER } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isSubAgentCaller, INSTALL_ROOT } from '../../scripts/hooks/db-write-gate.mjs'

type Entry = { matcher?: string; hooks: Array<{ command: string }> }
const pre = (s: Record<string, unknown>) => ((s.hooks as Record<string, unknown>).PreToolUse as Entry[])
const withScript = (s: Record<string, unknown>, script: string) => pre(s).filter((e) => JSON.stringify(e).includes(script))

describe('withWorkerGates: what the worker\'s settings carry', () => {
  it('the fleet-freeze gate stays FIRST; the db-write-gate, the hard email-send-gate and the copy gate follow', () => {
    const s = withWorkerGates({})
    expect(pre(s)[0].hooks[0].command).toBe(WORKER_FREEZE_GATE_CMD)
    expect(withScript(s, 'db-write-gate.mjs').map((e) => e.matcher)).toEqual([DB_WRITE_GATE_MATCHER])
    // ONE entry per mail gate: EMAIL_GATE_MATCHER already starts with Bash|, so a second Bash entry would run it twice
    expect(withScript(s, 'outgoing-copy-gate.py').map((e) => e.matcher)).toEqual([WORKER_MAIL_GATE_MATCHER])
    expect(withScript(s, 'email-send-gate.mjs').map((e) => e.matcher)).toEqual([EMAIL_GATE_MATCHER])
    // NOT the main agent's approval gate (Samu 67900, Dani 67895)
    expect(withScript(s, 'email-approval-gate.py')).toEqual([])
    expect(WORKER_MAIL_GATE_MATCHER).toBe(EMAIL_GATE_MATCHER)
    expect(EMAIL_GATE_MATCHER.startsWith('Bash|')).toBe(true)
  })
  it('no Telegram/Discord copy entry: the worker has every channel plugin disabled', () => {
    expect(withScript(withWorkerGates({}), 'outgoing-copy-gate.py').some((e) => e.matcher === TELEGRAM_COPY_GATE_MATCHER)).toBe(false)
  })
  it('the commands are absolute into the install, not $CLAUDE_PROJECT_DIR (that is the worker\'s own home there)', () => {
    for (const script of ['db-write-gate.mjs', 'email-send-gate.mjs', 'outgoing-copy-gate.py']) {
      for (const e of withScript(withWorkerGates({}), script)) {
        expect(e.hooks[0].command).toContain(join(PROJECT_ROOT, 'scripts'))
        expect(e.hooks[0].command).not.toContain('$CLAUDE_PROJECT_DIR')
      }
    }
  })
  it('a copy-gate entry under ANOTHER matcher is kept: only this script under these matchers is replaced', () => {
    const other = { matcher: 'mcp__plugin_discord_discord__reply', hooks: [{ type: 'command', command: 'python3 /x/scripts/hooks/outgoing-copy-gate.py' }] }
    expect(pre(withWorkerGates({ hooks: { PreToolUse: [other] } }))).toContainEqual(other)
  })
  it('idempotent on every boot, and every other entry and hook event is kept', () => {
    const foreign = { matcher: 'Read', hooks: [{ type: 'command', command: 'echo x' }] }
    const once = withWorkerGates({ hooks: { PreToolUse: [foreign], Stop: [{ hooks: [] }] }, model: 'y' })
    const twice = withWorkerGates(once)
    expect(pre(twice)).toHaveLength(pre(once).length)
    expect(pre(twice)).toContainEqual(foreign)
    expect((twice.hooks as Record<string, unknown>).Stop).toEqual([{ hooks: [] }])
    expect(twice.model).toBe('y')
  })
})

describe('the harness: a worker\'s identity through the db-write-gate (decision function only, nothing is written)', () => {
  const workerHome = join(homedir(), '.marveen-worker')
  const workerCfg = join(workerHome, '.claude-config')
  const asWorker = (tool: string, input: Record<string, unknown>) =>
    gateDecision(tool, input, { cwd: workerHome, root: INSTALL_ROOT, subAgent: isSubAgentCaller(workerHome, INSTALL_ROOT, workerCfg), projectDir: workerHome, configDir: workerCfg })

  it('the worker counts as a sub-agent (its project dir is its own home, outside the install)', () => {
    expect(isSubAgentCaller(workerHome, INSTALL_ROOT, workerCfg)).toBe(true)
  })
  it.each([
    `cat ${join(INSTALL_ROOT, 'store', 'config-overrides.json')}`,
    `grep -c x ${join(INSTALL_ROOT, '.env')}`,
    `sqlite3 -readonly ${join(INSTALL_ROOT, 'store', 'claude' + 'claw.db')} "SELECT count(*) FROM kanban_cards"`,
    'curl -s http://localhost:3420/api/health',
    `ls ${join(INSTALL_ROOT, 'agents')}`,
    'echo "osszefoglalo" > /tmp/worker-out.txt',
  ])('a read or its own scratch write passes: %s', (command) => {
    expect(asWorker('Bash', { command }).deny).toBe(false)
  })
  it.each([
    [`echo SUDO_AGENTS=x >> ${join(INSTALL_ROOT, '.env')}`, 'subagent-file'],
    [`echo '{"disableAllHooks": true}' > ${join(workerCfg, 'settings.json')}`, 'subagent-file'],
    [`echo '{}' > ${join(INSTALL_ROOT, 'store', 'config-overrides.json')}`, 'install-file'],
    [`echo x > ${join(INSTALL_ROOT, 'agents', 'samu', '.claude', 'settings.json')}`, 'install-file'],
  ])('a write the lists name is denied: %s', (command, reason) => {
    expect(asWorker('Bash', { command })).toEqual({ deny: true, reason })
  })
})

describe('the harness: the outgoing-copy gate lets a worker\'s plain Bash read through', () => {
  const hook = join(__dirname, '..', '..', 'scripts', 'hooks', 'outgoing-copy-gate.py')
  it('a read-only Bash call passes the copy gate (exit 0, no deny)', () => {
    const r = spawnSync('python3', [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl -s http://localhost:3420/api/health' } }),
      encoding: 'utf-8', timeout: 20000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })
})

// Samu 67900 (Dani 67895): the sub-agents' HARD email-send-gate on the worker, not the approval gate. The harness runs
// the REAL gate on a disposable copy of its two files with its own ledger (the repo's store is never touched): a send
// is refused from Bash and from an email tool, a draft is held to the ledger (a known address passes, an unknown one
// does not), a read passes. The 7 measured runAgent prompts send no letter, so no legitimate worker run is caught.
describe('the harness: the hard email-send-gate on a worker (real run, disposable copy and ledger)', () => {
  const SCRIPTS = join(__dirname, '..', '..', 'scripts')
  const KNOWN = 'known@example.com'
  const UNKNOWN = 'nobody@example.invalid'
  const denied = (stdout: string) => !!stdout && JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny'
  it('send refused (Bash and email tool), draft per the ledger, a read passes', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-sendgate-')))
    try {
      const dir = join(base, 'scripts'); mkdirSync(dir, { recursive: true }); mkdirSync(join(base, 'store'))
      for (const f of ['email-send-gate.mjs', 'recipient-ledger.mjs']) copyFileSync(join(SCRIPTS, f), join(dir, f))
      const add = spawnSync(process.execPath, [join(dir, 'recipient-ledger.mjs'), 'add', KNOWN, '--source', 'owner', '--note', 'worker-gates test'], { encoding: 'utf-8', timeout: 15000 })
      expect(add.status).toBe(0)
      const run = (payload: unknown) => spawnSync(process.execPath, [join(dir, 'email-send-gate.mjs')], {
        input: JSON.stringify({ ...(payload as object), cwd: join(homedir(), '.marveen-worker') }), encoding: 'utf-8', timeout: 15000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: join(homedir(), '.marveen-worker') },
      })
      expect(denied(run({ tool_name: 'mcp__server-gmail-autoauth-mcp__send_email', tool_input: { to: [KNOWN], subject: 's', body: 'b' } }).stdout)).toBe(true)
      expect(denied(run({ tool_name: 'Bash', tool_input: { command: `sendmail ${KNOWN}` } }).stdout)).toBe(true)
      expect(denied(run({ tool_name: 'mcp__server-gmail-autoauth-mcp__draft_email', tool_input: { to: [KNOWN], subject: 's', body: 'b' } }).stdout)).toBe(false)
      expect(denied(run({ tool_name: 'mcp__server-gmail-autoauth-mcp__draft_email', tool_input: { to: [UNKNOWN], subject: 's', body: 'b' } }).stdout)).toBe(true)
      expect(denied(run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }).stdout)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
