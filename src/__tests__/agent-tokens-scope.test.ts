// Per-agent dashboard tokens (AGENT_TOKENS) and the server-side sub-agent
// scope. Policy example: only the main agent creates, modifies or deletes
// schedules. Without a per-agent credential that is enforced only by a
// text-parsing PreToolUse hook, which a sub-agent can step around (python
// urllib instead of curl), so the final guard sits in the dashboard itself.
//
// The HTTP half drives the exact gate web.ts runs (gateRequest) in front of the
// real route handlers, over a real socket, with HOME pointed at a scratch dir
// so the schedule writes never touch the operator's ~/.claude/scheduled-tasks.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

// HOME must be redirected BEFORE any module computes homedir() at load time
// (scheduled-tasks-io resolves SCHEDULED_TASKS_DIR once, on import), hence the
// dynamic imports below: only node builtins are imported statically.
// The kanban claim lock is opt-in (KANBAN_CLAIM_LOCK, default off: /claim
// answers 404); the identity-binding cases below exercise /claim, so the
// settings layer reports it on here. AGENT_TOKENS is read through the same
// layer and follows `agentTokensSwitch`.
const agentTokensSwitch = { value: '1' }
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...real,
    getEffectiveSettingValue: (key: string) =>
      key === 'KANBAN_CLAIM_LOCK' ? '1'
        : key === 'AGENT_TOKENS' ? agentTokensSwitch.value
          : real.getEffectiveSettingValue(key),
  }
})
// The approvals route notifies the owner on Telegram. Never from a test: no bot
// token, and the sender is a spy.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, TELEGRAM_BOT_TOKEN: '' }
})
// The vault route would read the worktree's store/vault.json + key. A stub:
// 'teszt-*' ids exist, and the listing carries names only, like listSecrets().
vi.mock('../web/vault.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/vault.js')>()
  return {
    ...real,
    getSecret: (id: string) => (id.startsWith('teszt-') ? `ertek-${id}` : null),
    listSecrets: () => [{ id: 'teszt-sajat', label: 'sajat', createdAt: '', updatedAt: '' }, { id: 'teszt-masik', label: 'masik', createdAt: '', updatedAt: '' }],
  }
})
// The vault ACL (store/vault-acl.json) the ROUTE reads: the same table the gate
// is handed below, so route and gate judge one file.
const ACL = { value: {} as Record<string, string[]> }
vi.mock('../web/vault-acl.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/vault-acl.js')>()
  return { ...real, readVaultAcl: () => ACL.value }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => null) }
})

const scratch = (() => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tokens-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.NODE_ENV = 'test'
  return { root, home }
})()

const { initDatabase, createAgentMessage, saveAgentMemory, getAgentMessage, getDb, listApprovals, closeMessageAsRecipient, createApproval, resolveApproval, getApproval, listDashboardUsers } = await import('../db.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { logger } = await import('../logger.js')
const {
  resolveAuth, gateRequest, isScheduleWrite, agentScopeDenial, AGENT_TOKEN_ALLOWLIST, isAgentVaultReadAllowed,
} = await import('../web/auth-gate.js')
const {
  ensureAgentToken, createAgentTokenResolver, dashboardTokenPathFor, matchAgentToken,
  migrateAgentClaudeMdTokenRefs, revertAgentClaudeMdTokenRefs, syncAgentTokenOnStart, loadAgentTokens, agentTokenPath, mainTokenPath,
} = await import('../web/agent-tokens.js')
const { mayIssueCredentials } = await import('../web/routes/auth.js')
const { vaultReadRefused, principalOf } = await import('../web/vault-acl.js')
const { tryHandleSchedules } = await import('../web/routes/schedules.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { tryHandleSecurity } = await import('../web/routes/security.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')
const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { tryHandleMemories } = await import('../web/routes/memories.js')
const { tryHandleDailyLog } = await import('../web/routes/daily-log.js')
const { tryHandleAgentTaskState } = await import('../web/routes/agent-taskstate.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { SCHEDULED_TASKS_DIR } = await import('../web/scheduled-tasks-io.js')

const MAIN_TOKEN = 'f'.repeat(64)
const AGENT = 'alfa'
// A second fleet name that never gets a token in these suites.
const OTHER = 'masik-ugynok'

function mkReq(headers: Record<string, string | undefined> = {}, body?: unknown): http.IncomingMessage {
  // A real Readable, so the gate's body read (identity binding) completes.
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(r as unknown as { headers: Record<string, string | undefined> }).headers = headers
  return r
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(scratch.root, { recursive: true, force: true }) })

function mode(p: string): number {
  return lstatSync(p).mode & 0o777
}

describe('isScheduleWrite / agentScopeDenial (pure policy)', () => {
  it('treats every non-GET method on /api/schedules and below as a write', () => {
    expect(isScheduleWrite('/api/schedules', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'PUT')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'PATCH')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'DELETE')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x/toggle', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x/run', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/pending/3', 'DELETE')).toBe(true)
    // spelling variants are caught too (the router would 404 them anyway)
    expect(isScheduleWrite('/API/Schedules', 'post')).toBe(true)
    expect(isScheduleWrite('//api//schedules', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/%73chedules', 'POST')).toBe(true)
  })
  it('leaves reads and unrelated paths alone', () => {
    expect(isScheduleWrite('/api/schedules', 'GET')).toBe(false)
    expect(isScheduleWrite('/api/schedules/summary', 'GET')).toBe(false)
    expect(isScheduleWrite('/api/schedules', 'HEAD')).toBe(false)
    expect(isScheduleWrite('/api/schedulesx', 'POST')).toBe(false)
    expect(isScheduleWrite('/api/messages', 'POST')).toBe(false)
    expect(isScheduleWrite('/api/kanban', 'POST')).toBe(false)
  })
  it('restricts ONLY a sub-agent token principal; a shared-token X-Agent-Id claim is not restricted', () => {
    expect(agentScopeDenial({ kind: 'token' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    // the shared token with a self-asserted name: the typed header must not restrict the main lane
    expect(agentScopeDenial({ kind: 'token', agent: AGENT }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    expect(agentScopeDenial({ kind: 'session', user: 'op' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    expect(agentScopeDenial({ kind: 'device', device: 'd', deviceId: 1, scope: 'full' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    const d = agentScopeDenial({ kind: 'token', agent: AGENT, tokenAgent: AGENT }, '/api/schedules', 'POST', MAIN_AGENT_ID)
    expect(d?.status).toBe(403)
    expect(d?.body.error).toBe(`only the main agent writes schedules; send the request to ${MAIN_AGENT_ID} via /api/messages`)
    expect(agentScopeDenial({ kind: 'token', agent: AGENT, tokenAgent: AGENT }, '/api/schedules', 'GET', MAIN_AGENT_ID)).toBeNull()
  })
  it('a sub-agent token is never the owner: mayIssueCredentials is false for it, unchanged for the shared token', () => {
    // no dashboard user exists yet in this DB, so the bare shared token IS the owner credential
    expect(listDashboardUsers()).toHaveLength(0)
    expect(mayIssueCredentials({ kind: 'token' })).toBe(true)
    expect(mayIssueCredentials({ kind: 'token', agent: AGENT })).toBe(true)
    expect(mayIssueCredentials({ kind: 'token', agent: AGENT, tokenAgent: AGENT })).toBe(false)
  })
})

describe('token provisioning (ensureAgentToken)', () => {
  const base = join(scratch.root, 'prov', 'agents')
  beforeAll(() => { mkdirSync(join(base, AGENT), { recursive: true }) })

  it('creates the token file with mode 0600', () => {
    const r = ensureAgentToken(AGENT, base)
    expect(r?.created).toBe(true)
    const p = agentTokenPath(AGENT, base)
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent: a second call keeps the same token and writes nothing new', () => {
    const p = agentTokenPath(AGENT, base)
    const before = readFileSync(p, 'utf-8')
    const r = ensureAgentToken(AGENT, base)
    expect(r?.created).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(before)
    expect(mode(p)).toBe(0o600)
  })

  it('tightens a drifted mode back to 0600 without rotating the token', () => {
    const p = agentTokenPath(AGENT, base)
    const before = readFileSync(p, 'utf-8')
    chmodSync(p, 0o644)
    expect(ensureAgentToken(AGENT, base)?.created).toBe(false)
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('replaces a symlink (e.g. to the main token) with a fresh regular file', () => {
    mkdirSync(join(base, 'beta'), { recursive: true })
    const main = join(scratch.root, 'main-token')
    writeFileSync(main, MAIN_TOKEN)
    symlinkSync(main, agentTokenPath('beta', base))
    // the loader never trusts the link
    expect(loadAgentTokens(base).has('beta')).toBe(false)
    const r = ensureAgentToken('beta', base)
    expect(r?.created).toBe(true)
    const p = agentTokenPath('beta', base)
    expect(lstatSync(p).isFile()).toBe(true)
    expect(readFileSync(p, 'utf-8')).not.toBe(MAIN_TOKEN)
    expect(readFileSync(main, 'utf-8')).toBe(MAIN_TOKEN)
  })

  it('never provisions the main agent, a missing dir or an implausible name', () => {
    mkdirSync(join(base, MAIN_AGENT_ID), { recursive: true })
    expect(ensureAgentToken(MAIN_AGENT_ID, base)).toBeNull()
    expect(existsSync(agentTokenPath(MAIN_AGENT_ID, base))).toBe(false)
    expect(ensureAgentToken('nincs-ilyen', base)).toBeNull()
    expect(ensureAgentToken('..', base)).toBeNull()
  })

  it('dashboardTokenPathFor: main -> shared file; sub-agent -> own file only once it exists, and only with the switch on', () => {
    expect(dashboardTokenPathFor(MAIN_AGENT_ID, base, true)).toBe(mainTokenPath())
    expect(dashboardTokenPathFor(AGENT, base, true)).toBe(agentTokenPath(AGENT, base))
    mkdirSync(join(base, 'gamma'), { recursive: true })
    expect(dashboardTokenPathFor('gamma', base, true)).toBe(mainTokenPath())
    // AGENT_TOKENS off: the shared path, even though the agent's file exists
    expect(dashboardTokenPathFor(AGENT, base, false)).toBe(mainTokenPath())
  })

  it('migrates the literal shared-token path in the agent CLAUDE.md, idempotently', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const main = '/opt/x/store/.dashboard-token'
    writeFileSync(md, `a token a ${main} fájlban\ncurl -H "Authorization: Bearer $(cat ${main})" u\nrelative store/.dashboard-token stays\nbackup: ${main}.bak and ${main}-old and ${main}/x\n`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    const after = readFileSync(md, 'utf-8')
    expect(after).not.toContain(`${main} `)
    expect(after).not.toContain(`${main})`)
    expect(after.split(agentTokenPath(AGENT, base)).length - 1).toBe(2)
    expect(after).toContain('relative store/.dashboard-token stays')
    // anchored: a longer path that merely STARTS with the token path is left alone
    expect(after).toContain(`backup: ${main}.bak and ${main}-old and ${main}/x`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(false)
    // no per-agent token yet -> no rewrite
    writeFileSync(join(base, 'gamma', 'CLAUDE.md'), `$(cat ${main})`)
    expect(migrateAgentClaudeMdTokenRefs('gamma', base, main)).toBe(false)
  })

  it('migration re-anchors the agent\'s own token path left under an OLD install root (host move)', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const main = '/opt/x/store/.dashboard-token'
    writeFileSync(md, `curl -H "Authorization: Bearer $(cat /old/home/inst/agents/${AGENT}/.dashboard-token)" u\nother agent: /old/home/inst/agents/beta/.dashboard-token\n`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    const after = readFileSync(md, 'utf-8')
    expect(after).toContain(`$(cat ${agentTokenPath(AGENT, base)})`)
    expect(after).not.toContain(`/old/home/inst/agents/${AGENT}/`)
    // only THIS agent's file is its business
    expect(after).toContain('/old/home/inst/agents/beta/.dashboard-token')
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(false)
  })

  it('revert (switch off): every reference to the agent\'s own token file, under any root, becomes the shared path', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const main = '/opt/x/store/.dashboard-token'
    const own = agentTokenPath(AGENT, base)
    writeFileSync(md, `$(cat ${own})\n$(cat /old/root/agents/${AGENT}/.dashboard-token)\nkeep ${own}.bak\n`)
    expect(revertAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    expect(readFileSync(md, 'utf-8')).toBe(`$(cat ${main})\n$(cat ${main})\nkeep ${own}.bak\n`)
    expect(revertAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(false)
  })

  it('syncAgentTokenOnStart: on = provision + migrate, off = revert and provision nothing; main and heartbeat untouched', () => {
    const main = '/opt/z/store/.dashboard-token'
    mkdirSync(join(base, 'kappa'), { recursive: true })
    const md = join(base, 'kappa', 'CLAUDE.md')
    writeFileSync(md, `$(cat ${main})\n`)
    // off first: nothing happens on a shared-token install
    expect(syncAgentTokenOnStart('kappa', { enabled: false, baseDir: base, mainTokenPath: main })).toEqual({ provisioned: false, rewritten: false })
    expect(existsSync(agentTokenPath('kappa', base))).toBe(false)
    expect(readFileSync(md, 'utf-8')).toBe(`$(cat ${main})\n`)
    // on
    expect(syncAgentTokenOnStart('kappa', { enabled: true, baseDir: base, mainTokenPath: main })).toEqual({ provisioned: true, rewritten: true })
    expect(readFileSync(md, 'utf-8')).toBe(`$(cat ${agentTokenPath('kappa', base)})\n`)
    // on again: idempotent
    expect(syncAgentTokenOnStart('kappa', { enabled: true, baseDir: base, mainTokenPath: main })).toEqual({ provisioned: false, rewritten: false })
    // off again: back to the shared token (the file stays until deleted by hand)
    expect(syncAgentTokenOnStart('kappa', { enabled: false, baseDir: base, mainTokenPath: main })).toEqual({ provisioned: false, rewritten: true })
    expect(readFileSync(md, 'utf-8')).toBe(`$(cat ${main})\n`)
    for (const n of [MAIN_AGENT_ID, 'heartbeat']) {
      expect(syncAgentTokenOnStart(n, { enabled: true, baseDir: base, mainTokenPath: main })).toEqual({ provisioned: false, rewritten: false })
    }
  })

  it('migration keeps the CLAUDE.md file mode and never rewrites a symlinked CLAUDE.md', () => {
    const main = '/opt/y/store/.dashboard-token'
    const md = join(base, AGENT, 'CLAUDE.md')
    writeFileSync(md, `curl -H "Authorization: Bearer $(cat ${main})" u\n`)
    chmodSync(md, 0o640)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    expect(mode(md)).toBe(0o640)
    // symlinked CLAUDE.md: left as a link, target untouched
    mkdirSync(join(base, 'zeta'), { recursive: true })
    ensureAgentToken('zeta', base)
    const target = join(scratch.root, 'zeta-claude.md')
    writeFileSync(target, `$(cat ${main})`)
    symlinkSync(target, join(base, 'zeta', 'CLAUDE.md'))
    expect(migrateAgentClaudeMdTokenRefs('zeta', base, main)).toBe(false)
    expect(lstatSync(join(base, 'zeta', 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe(`$(cat ${main})`)
  })

  it('an agent token file holding a COPY of the main token is rotated, and ignored by the loader until then', () => {
    mkdirSync(join(base, 'eta'), { recursive: true })
    const p = agentTokenPath('eta', base)
    writeFileSync(p, MAIN_TOKEN, { mode: 0o600 })
    expect(loadAgentTokens(base, MAIN_TOKEN).has('eta')).toBe(false)
    const r = ensureAgentToken('eta', base, MAIN_TOKEN)
    expect(r?.created).toBe(true)
    const fresh = readFileSync(p, 'utf-8')
    expect(fresh).not.toBe(MAIN_TOKEN)
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect(loadAgentTokens(base, MAIN_TOKEN).get('eta')).toBe(fresh)
  })

  it('a failing readdir of the agents dir is warned about, not silent', () => {
    const spy = vi.spyOn(logger, 'warn')
    try {
      expect(loadAgentTokens(join(scratch.root, 'nincs-ilyen-konyvtar'), MAIN_TOKEN).size).toBe(0)
      expect(spy.mock.calls.some((c) => String(c[1] ?? '').includes('cannot list the agents directory'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveAuth with agent tokens', () => {
  const base = join(scratch.root, 'resolve', 'agents')
  let agentTok = ''
  beforeAll(() => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
  })

  it('main token -> plain token principal, no tokenAgent (unchanged)', () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    const url = new URL('http://127.0.0.1/api/memories')
    const r = resolveAuth(mkReq({ authorization: `Bearer ${MAIN_TOKEN}` }), url, url.pathname, 'GET', MAIN_TOKEN, resolver)
    expect(r).toEqual({ kind: 'token' })
    expect((r as { tokenAgent?: string }).tokenAgent).toBeUndefined()
  })

  it('agent token -> token principal with agent AND tokenAgent; an X-Agent-Id header cannot rename it', () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    const url = new URL('http://127.0.0.1/api/memories')
    expect(resolveAuth(mkReq({ authorization: `Bearer ${agentTok}` }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'token', agent: AGENT, tokenAgent: AGENT })
    expect(resolveAuth(mkReq({ authorization: `Bearer ${agentTok}`, 'x-agent-id': MAIN_AGENT_ID }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'token', agent: AGENT, tokenAgent: AGENT })
  })

  it('unknown token -> none; timing-safe matcher handles any length', () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    const url = new URL('http://127.0.0.1/api/memories')
    expect(resolveAuth(mkReq({ authorization: 'Bearer nope' }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'none' })
    expect(matchAgentToken('', new Map([[AGENT, agentTok]]))).toBeNull()
    expect(matchAgentToken('x'.repeat(500), new Map([[AGENT, agentTok]]))).toBeNull()
  })

  it('a token provisioned in-process is accepted IMMEDIATELY (cache invalidated on created=true)', () => {
    const t = 0
    const resolver = createAgentTokenResolver({ baseDir: base, ttlMs: 60_000, now: () => t })
    expect(resolver('0'.repeat(64))).toBeNull() // primes the cache
    mkdirSync(join(base, 'delta'), { recursive: true })
    expect(ensureAgentToken('delta', base)?.created).toBe(true)
    const tok = readFileSync(agentTokenPath('delta', base), 'utf-8')
    expect(resolver(tok)).toBe('delta')
  })

  it('a token file dropped in by hand is picked up after the cache TTL, not before', () => {
    let t = 0
    const resolver = createAgentTokenResolver({ baseDir: base, ttlMs: 1000, now: () => t })
    expect(resolver('0'.repeat(64))).toBeNull() // primes the cache
    mkdirSync(join(base, 'epsilon'), { recursive: true })
    const tok = 'e'.repeat(64)
    writeFileSync(agentTokenPath('epsilon', base), tok, { mode: 0o600 })
    t = 500
    expect(resolver(tok)).toBeNull()
    t = 1000
    expect(resolver(tok)).toBe('epsilon')
  })
})

describe('vault reads by a sub-agent token follow store/vault-acl.json', () => {
  it('isAgentVaultReadAllowed: listed for the caller -> yes; another agent, unlisted, SSH, sub-resource -> no', () => {
    const acl = { 'teszt-sajat': [AGENT], 'teszt-masik': [OTHER], 'ssh-key-x': [AGENT], bindings: [AGENT] }
    expect(isAgentVaultReadAllowed(AGENT, 'teszt-sajat', acl)).toBe(true)
    expect(isAgentVaultReadAllowed(AGENT, 'teszt-masik', acl)).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, 'teszt-nincs', acl)).toBe(false)
    // the floor holds even where the file lists the caller
    expect(isAgentVaultReadAllowed(AGENT, 'ssh-key-x', acl)).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, '%73sh-key-x', acl)).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, 'bindings', acl)).toBe(false)
    // an empty file (the default) lets a sub-agent token read no value
    expect(isAgentVaultReadAllowed(AGENT, 'teszt-sajat', {})).toBe(false)
  })

  it('a prototype-member id or agent answers false, it does not throw; a non-array entry is refused', () => {
    const acl = { 'teszt-sajat': [AGENT] }
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(() => isAgentVaultReadAllowed(AGENT, id, acl), id).not.toThrow()
      expect(isAgentVaultReadAllowed(AGENT, id, acl), id).toBe(false)
    }
    expect(isAgentVaultReadAllowed('__proto__', 'teszt-sajat', acl)).toBe(false)
    const odd = { 'teszt-sajat': AGENT } as unknown as Record<string, string[]>
    expect(isAgentVaultReadAllowed(AGENT, 'teszt-sajat', odd)).toBe(false)
  })

  it('route rule (vaultReadRefused): a sub-agent token is held to the ACL in EVERY mode; the shared lane keeps the mode', () => {
    const acl = { 'teszt-sajat': [AGENT] }
    const own = { kind: 'token' as const, agent: AGENT, tokenAgent: AGENT }
    expect(vaultReadRefused('teszt-sajat', own, acl, 'audit')).toBe(false)
    expect(vaultReadRefused('teszt-masik', own, acl, 'audit')).toBe(true)
    expect(vaultReadRefused('teszt-masik', own, acl, 'enforce')).toBe(true)
    // shared token claiming the same name: audit lets it through, enforce does not (unchanged)
    expect(vaultReadRefused('teszt-masik', { kind: 'token', agent: AGENT }, acl, 'audit')).toBe(false)
    expect(vaultReadRefused('teszt-masik', { kind: 'token', agent: AGENT }, acl, 'enforce')).toBe(true)
    expect(vaultReadRefused('teszt-masik', { kind: 'token' }, acl, 'enforce')).toBe(false)
    // audit rows name the authenticated agent as an 'agent' principal
    expect(principalOf(own)).toEqual({ kind: 'agent', principal: AGENT })
    expect(principalOf({ kind: 'token', agent: AGENT })).toEqual({ kind: 'token', principal: 'token' })
  })
})

describe('HTTP: the dashboard gate in front of the real routes', () => {
  // The messages route accepts only a REGISTERED sender (agents/<id>/ under
  // PROJECT_ROOT -- here the checkout, never a live install). So this block's
  // agent is a real, uniquely named dir, removed again in afterAll together
  // with the task-state files it writes.
  const AGENT = `agtok${process.pid}`
  const base = join(PROJECT_ROOT, 'agents')
  const createdAgentsDir = !existsSync(base)
  const taskStateDir = join(PROJECT_ROOT, 'store', 'agent-taskstate')
  let server: http.Server
  let origin = ''
  let agentTok = ''

  beforeAll(async () => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
    ACL.value = { 'teszt-sajat': [AGENT], 'teszt-masik': [OTHER] }
    const resolveAgentToken = createAgentTokenResolver({ baseDir: base })
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method || 'GET'
      const auth = await gateRequest(req, res, url, path, method, {
        dashboardToken: MAIN_TOKEN, resolveAgentToken, mainAgentId: MAIN_AGENT_ID, agentVaultAcl: () => ACL.value,
      })
      if (auth === null) return
      // ctx.auth exactly as web.ts builds it
      const ctx = {
        req, res, path, method, url, fedPeer: null,
        auth: auth.kind === 'token' ? { kind: 'token' as const, agent: auth.agent, ...(auth.tokenAgent ? { tokenAgent: auth.tokenAgent } : {}) } : undefined,
      }
      try {
        // same relative order as web.ts
        if (await tryHandleAuth(ctx)) return
        if (await tryHandleSecurity(ctx)) return
        if (await tryHandleMessages(ctx)) return
        if (await tryHandleDailyLog(ctx)) return
        if (await tryHandleMemories(ctx)) return
        if (await tryHandleKanban(ctx)) return
        if (await tryHandleSchedules(ctx)) return
        if (await tryHandleAgentTerminal(ctx)) return
        if (await tryHandleAgentTaskState(ctx)) return
        if (await tryHandleApprovals(ctx)) return
        if (await tryHandleConnectors(ctx)) return
        if (await tryHandleFleet(ctx)) return
        res.writeHead(404); res.end('Not found')
      } catch (err) {
        res.writeHead(500); res.end(String(err))
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(join(base, AGENT), { recursive: true, force: true })
    if (createdAgentsDir) rmSync(base, { recursive: true, force: true })
    for (const n of [AGENT, 'agtok-masik']) rmSync(join(taskStateDir, `${n}.json`), { force: true })
  })

  async function call(method: string, path: string, token: string | null, body?: unknown) {
    const headers: Record<string, string> = {}
    if (token !== null) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    return { status: r.status, json }
  }

  const sched = (name: string) => ({ name, description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: MAIN_AGENT_ID, type: 'task' })

  it('sanity: schedule writes land in the scratch HOME, never the real one', () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(scratch.home)).toBe(true)
  })

  it('main token: schedule create / update / delete -> 2xx', async () => {
    const c = await call('POST', '/api/schedules', MAIN_TOKEN, sched('fo-agens-teszt'))
    expect(c.status, JSON.stringify(c.json)).toBe(200)
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'fo-agens-teszt', 'task-config.json'))).toBe(true)
    expect((await call('PUT', '/api/schedules/fo-agens-teszt', MAIN_TOKEN, { description: 'u' })).status).toBe(200)
    expect((await call('DELETE', '/api/schedules/fo-agens-teszt', MAIN_TOKEN)).status).toBe(200)
  })

  it('sub-agent token: every schedule write -> 403 naming the rule, nothing written', async () => {
    // a target that exists, so a 403 cannot be confused with a 404
    expect((await call('POST', '/api/schedules', MAIN_TOKEN, sched('letezo'))).status).toBe(200)
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/api/schedules', sched('al-agens-teszt')],
      ['PUT', '/api/schedules/letezo', { prompt: 'atirva' }],
      ['PATCH', '/api/schedules/letezo', { prompt: 'atirva' }],
      ['DELETE', '/api/schedules/letezo'],
      ['POST', '/api/schedules/letezo/toggle'],
      ['POST', '/api/schedules/letezo/run'],
    ]
    for (const [method, path, body] of cases) {
      const r = await call(method, path, agentTok, body)
      expect(r.status, `${method} ${path}`).toBe(403)
      expect(r.json.error).toBe(`only the main agent writes schedules; send the request to ${MAIN_AGENT_ID} via /api/messages`)
      expect(r.json.rule).toBe('schedule-writes-main-agent-only')
      expect(r.json.agent).toBe(AGENT)
      expect(r.json.main_agent).toBe(MAIN_AGENT_ID)
    }
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'al-agens-teszt'))).toBe(false)
    expect(readFileSync(join(SCHEDULED_TASKS_DIR, 'letezo', 'SKILL.md'), 'utf-8')).not.toContain('atirva')
  })

  it('sub-agent token: GET schedules, POST messages and POST kanban -> 2xx', async () => {
    const g = await call('GET', '/api/schedules', agentTok)
    expect(g.status).toBe(200)
    expect((await call('GET', '/api/schedules/summary', agentTok)).status).toBe(200)
    const m = await call('POST', '/api/messages', agentTok, { from: AGENT, to: MAIN_AGENT_ID, content: 'agent token teszt' })
    expect(m.status, JSON.stringify(m.json)).toBe(200)
    expect(typeof m.json.id).toBe('number')
    const k = await call('POST', '/api/kanban', agentTok, { title: 'agent token teszt-kartya' })
    expect(k.status, JSON.stringify(k.json)).toBe(200)
    expect(k.json.ok).toBe(true)
  })

  // Runs BEFORE the dashboard-user creation below (the last bypass case): with no
  // login yet, the bare main token is the owner credential (mayIssueCredentials),
  // so the main lane still creates a born-approved row, and the agent token is
  // still refused by the binding.
  it('approvals: before any dashboard user exists, the main token creates a born-approved row; the agent token cannot', async () => {
    expect(listDashboardUsers()).toHaveLength(0)
    const hash = 'b'.repeat(64)
    const agent = await call('POST', '/api/approvals', agentTok, {
      agent_id: AGENT, category: 'email_send', action_description: 'x', content_hash: hash, owner_approved_message_id: 3,
    })
    expect(agent.status, JSON.stringify(agent.json)).toBe(403)
    expect(agent.json.rule).toBe('agent-identity-binding')
    const main = await call('POST', '/api/approvals', MAIN_TOKEN, {
      agent_id: MAIN_AGENT_ID, category: 'email_send', action_description: 'x', content_hash: hash, owner_approved_message_id: 3,
    })
    expect(main.status, JSON.stringify(main.json)).toBe(201)
    expect(main.json.status).toBe('approved')
  })

  // The denylist draft's bypasses. Each must be 403 'agent-token-scope' for a
  // sub-agent token AND still reach its handler with the main token (the
  // main-token calls use bodies that stop at the handler's own validation, or
  // write only the in-memory DB).
  const bypasses: Array<{ what: string; method: string; path: string; agentBody: unknown; mainBody: unknown; mainStatus: number }> = [
    { what: 'fleet import writes the schedule store', method: 'POST', path: '/api/fleet/import?apply=true',
      agentBody: { schemaVersion: 1, agents: [], scheduledTasks: [{ dirName: 'letezo', skillMd: 'x', config: {} }] },
      mainBody: {}, mainStatus: 400 },
    { what: 'device-key minting', method: 'POST', path: '/api/auth/device-keys', agentBody: { name: 'lopott-kulcs' }, mainBody: { name: 'fo-kulcs' }, mainStatus: 201 },
    { what: 'bridge enrollment (mints a key)', method: 'POST', path: '/api/security/bridge-enroll', agentBody: { key_line: 'ssh-ed25519 AAAA x', name: 'lopott' }, mainBody: {}, mainStatus: 400 },
    { what: 'terminal-input toggle', method: 'POST', path: '/api/terminal-input', agentBody: { enabled: true }, mainBody: {}, mainStatus: 400 },
    // LAST on purpose: once a dashboard user exists, the bare main token no
    // longer issues credentials or approves, so every main-token call above
    // runs while there is still no login.
    { what: 'dashboard user creation', method: 'POST', path: '/api/auth/users',
      agentBody: { username: 'lopott', password: 'Hosszu-jelszo-2026' }, mainBody: { username: 'fo-felhasznalo', password: 'Hosszu-jelszo-2026' }, mainStatus: 201 },
  ]

  for (const b of bypasses) {
    it(`denylist bypass closed: ${b.what} (${b.method} ${b.path}) -> 403 for the agent token, handler reached for the main token`, async () => {
      const a = await call(b.method, b.path, agentTok, b.agentBody)
      expect(a.status).toBe(403)
      expect(a.json.rule).toBe('agent-token-scope')
      expect(a.json.agent).toBe(AGENT)
      expect(a.json.main_agent).toBe(MAIN_AGENT_ID)
      expect(String(a.json.error)).toContain('via /api/messages')
      const m = await call(b.method, b.path, MAIN_TOKEN, b.mainBody)
      expect(m.status, JSON.stringify(m.json)).toBe(b.mainStatus)
    })
  }

  it('the refused agent calls minted nothing: only the main-token device key and user exist', async () => {
    const keys = await call('GET', '/api/auth/device-keys', MAIN_TOKEN)
    expect(keys.status).toBe(200)
    const names = (keys.json.keys as Array<{ name: string }>).map((k) => k.name)
    expect(names).toContain('fo-kulcs')
    expect(names).not.toContain('lopott-kulcs')
    const unames = listDashboardUsers().map((u) => u.username)
    expect(unames).toContain('fo-felhasznalo')
    expect(unames).not.toContain('lopott')
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'letezo', 'task-config.json'))).toBe(true)
    expect(readFileSync(join(SCHEDULED_TASKS_DIR, 'letezo', 'SKILL.md'), 'utf-8')).not.toBe('x')
    // and an agent token cannot even LIST them
    expect((await call('GET', '/api/auth/device-keys', agentTok)).status).toBe(403)
  })

  it('public probes stay public for an agent token (scope applies to gated paths only)', async () => {
    const r = await call('GET', '/api/auth/status', agentTok)
    expect(r.status).toBe(200)
  })

  // ---- identity binding: one 403 per binding, main token unchanged
  function expectBinding403(r: { status: number; json: Record<string, unknown> }, what: string): void {
    expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(403)
    expect(r.json.rule, what).toBe('agent-identity-binding')
    expect(r.json.agent, what).toBe(AGENT)
    expect(r.json.main_agent, what).toBe(MAIN_AGENT_ID)
  }
  const HASH = 'a'.repeat(64)

  it('approvals: an agent token cannot create a born-approved row or file in another name; a pending own request is fine', async () => {
    const approvedBefore = listApprovals({ status: 'approved', limit: 500 }).length
    // the laundering body: agent_id=<main> + owner_approved_message_id
    expectBinding403(await call('POST', '/api/approvals', agentTok, {
      agent_id: MAIN_AGENT_ID, category: 'email_send', action_description: 'x', content_hash: HASH, owner_approved_message_id: 1,
    }), 'launder as main')
    // own agent_id does not unlock the owner-lane field either
    expectBinding403(await call('POST', '/api/approvals', agentTok, {
      agent_id: AGENT, category: 'email_send', action_description: 'x', content_hash: HASH, owner_approved_message_id: 1,
    }), 'owner field with own agent_id')
    // and a request filed in someone else's name
    expectBinding403(await call('POST', '/api/approvals', agentTok, { agent_id: OTHER, category: 'email_send', action_description: 'x' }), 'foreign agent_id')
    expect(listApprovals({ status: 'approved', limit: 500 }).length).toBe(approvedBefore)
    // legit: a pending request in its own name
    const own = await call('POST', '/api/approvals', agentTok, { agent_id: AGENT, category: 'email_send', action_description: 'sajat kerelem', content_hash: HASH })
    expect(own.status, JSON.stringify(own.json)).toBe(201)
    expect(own.json.status).toBe('pending')
    // main token: past the agent binding; with a dashboard user present a
    // born-approved row takes the owner's session, so the bare main token is
    // refused by the ROUTE with owner_session_required, not by the agent gate.
    const main = await call('POST', '/api/approvals', MAIN_TOKEN, {
      agent_id: MAIN_AGENT_ID, category: 'email_send', action_description: 'x', content_hash: HASH, owner_approved_message_id: 7,
    })
    expect(main.status, JSON.stringify(main.json)).toBe(403)
    expect(main.json.code).toBe('owner_session_required')
    expect(main.json.rule).toBeUndefined()
  })

  it('approvals consume: the agent token consumes its OWN owner-approved row once; another agent\'s row and a missing id are 403', async () => {
    const CAT = 'teszt_kategoria'
    const mine = createApproval({ id: 'agtok-own', agent_id: AGENT, category: CAT, action_description: 'x', content_hash: HASH })
    resolveApproval(mine.id, 'approved', 'tulajdonos', null)
    const theirs = createApproval({ id: 'agtok-foreign', agent_id: OTHER, category: CAT, action_description: 'x', content_hash: HASH })
    resolveApproval(theirs.id, 'approved', 'tulajdonos', null)
    const body = { category: CAT, content_hash: HASH, consumer: 'teszt-eszkoz', ref: 'r1' }
    expectBinding403(await call('POST', `/api/approvals/${theirs.id}/consume`, agentTok, body), 'foreign row')
    expect(getApproval(theirs.id)!.consumed_at).toBeNull()
    expectBinding403(await call('POST', '/api/approvals/agtok-nincs-ilyen/consume', agentTok, body), 'missing row')
    const ok = await call('POST', `/api/approvals/${mine.id}/consume`, agentTok, body)
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(getApproval(mine.id)!.consumed_by).toBe('teszt-eszkoz')
    expect((await call('POST', `/api/approvals/${mine.id}/consume`, agentTok, body)).status).toBe(409)
    // the main token consumes anyone's row, as before
    expect((await call('POST', `/api/approvals/${theirs.id}/consume`, MAIN_TOKEN, body)).status).toBe(200)
  })

  it('messages POST: from must be the calling agent; the main token unchanged', async () => {
    expectBinding403(await call('POST', '/api/messages', agentTok, { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'hamis' }), 'from=main')
    const ok = await call('POST', '/api/messages', agentTok, { from: AGENT, to: MAIN_AGENT_ID, content: 'sajat' })
    expect(ok.status).toBe(200)
    expect(ok.json.from_agent).toBe(AGENT)
    expect((await call('POST', '/api/messages', MAIN_TOKEN, { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'fo' })).status).toBe(200)
  })

  it('messages PUT: only a message addressed to the caller can be closed by it; the main token unchanged', async () => {
    const toMain = createAgentMessage(MAIN_AGENT_ID, MAIN_AGENT_ID, 'direktiva-szeru')
    const toSelf = createAgentMessage(MAIN_AGENT_ID, AGENT, 'neked szol')
    expectBinding403(await call('PUT', `/api/messages/${toMain.id}`, agentTok, { status: 'failed', result: 'x', notify: false }), 'close foreign')
    expect(getAgentMessage(toMain.id)?.status).toBe('pending')
    expect((await call('PUT', `/api/messages/${toSelf.id}`, agentTok, { status: 'done', result: 'kesz', notify: false })).status).toBe(200)
    expect((await call('PUT', `/api/messages/${toMain.id}`, MAIN_TOKEN, { status: 'done', result: 'kesz', notify: false })).status).toBe(200)
  })

  // ---- the PUT /api/messages/:id check-then-act race
  function nextMessageId(): number {
    const seq = getDb().prepare("SELECT seq FROM sqlite_sequence WHERE name = 'agent_messages'").get() as { seq: number } | undefined
    const max = (getDb().prepare('SELECT MAX(id) AS m FROM agent_messages').get() as { m: number | null }).m ?? 0
    return Math.max(seq?.seq ?? 0, max) + 1
  }

  it('race: a PUT pre-armed on the NEXT message id cannot close the message later created there for another agent', async () => {
    const nextId = nextMessageId()
    let victimId = -1
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request(`${origin}/api/messages/${nextId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${agentTok}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      }, (res) => {
        let b = ''
        res.on('data', (c) => { b += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
      })
      r.on('error', reject)
      // headers + first chunk now: a gate that looked the row up at this point would find nothing
      r.write('{"status":"done",')
      setTimeout(() => {
        // ...then the message the caller waited for is created, at exactly the pre-armed id
        victimId = createAgentMessage(MAIN_AGENT_ID, OTHER, 'bizalmas feladat a masik ugynoknek').id
        r.end('"result":"hamisitott eredmeny","notify":true}')
      }, 250)
    })
    expect(victimId).toBe(nextId) // the race really hit the pre-armed id
    expect(reply.status, reply.body).toBe(403)
    expect(JSON.parse(reply.body).rule).toBe('agent-identity-binding')
    expect(JSON.parse(reply.body).main_agent).toBe(MAIN_AGENT_ID)
    const row = getAgentMessage(victimId)
    expect(row?.status).toBe('pending')
    expect(row?.result).toBeNull()
    const forged = getDb().prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE content LIKE ?").get(`%msg_id:${victimId} %`) as { n: number }
    expect(forged.n).toBe(0)
  })

  it('a PUT on a message id that does not exist is refused for an agent token (not deferred to 404)', async () => {
    const r = await call('PUT', `/api/messages/${nextMessageId() + 50}`, agentTok, { status: 'done', result: 'x' })
    expectBinding403(r, 'missing row')
    expect(String(r.json.error)).toContain('does not exist')
  })

  it('guarded close (closeMessageAsRecipient): only the recipient, only from an open status, in one UPDATE', () => {
    const m = createAgentMessage(MAIN_AGENT_ID, 'alfa-cimzett', 'x')
    expect(closeMessageAsRecipient(m.id, 'beta-mas', 'done', 'r')).toBe(false)
    expect(getAgentMessage(m.id)?.status).toBe('pending')
    expect(closeMessageAsRecipient(m.id, 'alfa-cimzett', 'done', 'kesz')).toBe(true)
    const done = getAgentMessage(m.id)!
    expect(done.status).toBe('done')
    expect(done.result).toBe('kesz')
    expect(done.delivered_at).not.toBeNull()
    expect(closeMessageAsRecipient(m.id, 'alfa-cimzett', 'failed', 'ujra')).toBe(false) // final stays final
    expect(getAgentMessage(m.id)?.result).toBe('kesz')
    const f = createAgentMessage(MAIN_AGENT_ID, 'alfa-cimzett', 'y')
    expect(closeMessageAsRecipient(f.id, 'alfa-cimzett', 'failed', 'hiba')).toBe(true)
    expect(getAgentMessage(f.id)?.status).toBe('failed')
    expect(getAgentMessage(f.id)?.delivered_at).toBeNull()
    expect(closeMessageAsRecipient(999_999, 'alfa-cimzett', 'done')).toBe(false)
  })

  it('agent token re-closing its own finished message gets 409 and no second report', async () => {
    const m = createAgentMessage(MAIN_AGENT_ID, AGENT, 'egyszer zarhato')
    expect((await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'done', result: 'elso', notify: false })).status).toBe(200)
    const again = await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'failed', result: 'masodik' })
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('Message already closed')
    expect(getAgentMessage(m.id)?.result).toBe('elso')
  })

  it('main token PUT /api/messages/:id: any recipient, completion report sent; a re-close is 409', async () => {
    const m = createAgentMessage(MAIN_AGENT_ID, OTHER, 'feladat')
    const r = await call('PUT', `/api/messages/${m.id}`, MAIN_TOKEN, { status: 'done', result: 'fo zarta' })
    expect(r.status).toBe(200)
    expect(getAgentMessage(m.id)?.status).toBe('done')
    const report = getDb().prepare("SELECT from_agent, to_agent FROM agent_messages WHERE content LIKE ?").get(`%msg_id:${m.id} %`) as { from_agent: string; to_agent: string } | undefined
    expect(report).toEqual({ from_agent: OTHER, to_agent: MAIN_AGENT_ID })
    expect((await call('PUT', `/api/messages/${m.id}`, MAIN_TOKEN, { status: 'failed', result: 'mégsem', notify: false })).status).toBe(409)
    expect(getAgentMessage(m.id)?.status).toBe('done')
    // a missing row is still the plain 404 for the main token
    expect((await call('PUT', `/api/messages/${nextMessageId() + 99}`, MAIN_TOKEN, { status: 'done' })).status).toBe(404)
  })

  it('exact identity match: a padded name is refused; tool-log and skill-usage agent_id are bound', async () => {
    expectBinding403(await call('POST', '/api/memories', agentTok, { agent_id: ` ${AGENT} `, content: 'parnazott' }), 'padded agent_id')
    expectBinding403(await call('POST', '/api/tool-log', agentTok, { session_id: 's', tool_name: 'Bash', agent_id: MAIN_AGENT_ID }), 'tool-log as main')
    expectBinding403(await call('POST', '/api/skill-usage', agentTok, { agent_id: MAIN_AGENT_ID, skill_name: 'x', trigger_type: 'tool_call' }), 'skill-usage as main')
  })

  it('vault: an id the ACL lists for the caller 200; another agent\'s id, an unlisted id, ssh 403; listing names only; the main token unchanged', async () => {
    const own = await call('GET', '/api/vault/teszt-sajat', agentTok)
    expect(own.status, JSON.stringify(own.json)).toBe(200)
    expect(own.json.value).toBe('ertek-teszt-sajat')
    for (const p of ['/api/vault/teszt-masik', '/api/vault/ssh-key-abc', '/api/vault/%73sh-key-abc', '/api/vault/ssh-keys', '/api/vault/bindings', '/api/vault/teszt-nincs-listazva']) {
      const r = await call('GET', p, agentTok)
      expect(r.status, p).toBe(403)
      expect(r.json.rule, p).toBe('agent-token-scope')
      expect(r.json.main_agent, p).toBe(MAIN_AGENT_ID)
    }
    const list = await call('GET', '/api/vault', agentTok)
    expect(list.status).toBe(200)
    const secrets = list.json.secrets as Array<Record<string, unknown>>
    expect(secrets.map((x) => x.id)).toEqual(['teszt-sajat', 'teszt-masik'])
    expect(secrets.every((x) => !('value' in x) && !('encrypted' in x))).toBe(true)
    // main token: any ordinary id, as before (VAULT_ACL_MODE audit by default)
    expect((await call('GET', '/api/vault/teszt-masik', MAIN_TOKEN)).status).toBe(200)
    expect((await call('GET', '/api/vault/nincs-ilyen-titok', MAIN_TOKEN)).status).toBe(404)
  })

  it('vault resolve: the route holds an agent token to the ACL per id (any mode); the main token resolves both', async () => {
    const r = await call('POST', '/api/vault/resolve', agentTok, { ids: ['teszt-sajat', 'teszt-masik'] })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.values).toEqual({ 'teszt-sajat': 'ertek-teszt-sajat' })
    expect(r.json.refused).toEqual([{ id: 'teszt-masik', reason: 'acl' }])
    const m = await call('POST', '/api/vault/resolve', MAIN_TOKEN, { ids: ['teszt-sajat', 'teszt-masik'] })
    expect(m.status).toBe(200)
    expect(Object.keys(m.json.values as object).sort()).toEqual(['teszt-masik', 'teszt-sajat'])
  })

  it('agent-taskstate: the path agent must be the caller; the main token unchanged', async () => {
    const st = { summary: 's', doneSteps: [], alreadyDelegated: [], nextAction: 'n' }
    expectBinding403(await call('POST', '/api/agent-taskstate/agtok-masik', agentTok, st), 'foreign path agent')
    expectBinding403(await call('POST', `/api/agent-taskstate/${MAIN_AGENT_ID}/consume`, agentTok, {}), 'consume main')
    expectBinding403(await call('GET', `/api/agent-taskstate/${MAIN_AGENT_ID}/replay`, agentTok), 'replay main')
    expect(existsSync(join(taskStateDir, 'agtok-masik.json'))).toBe(false)
    expect((await call('POST', `/api/agent-taskstate/${AGENT}`, agentTok, st)).status).toBe(200)
    expect((await call('POST', '/api/agent-taskstate/agtok-masik', MAIN_TOKEN, st)).status).toBe(200)
  })

  it('memories POST: agent_id must be the caller (absent = main, refused); the main token unchanged', async () => {
    expectBinding403(await call('POST', '/api/memories', agentTok, { agent_id: MAIN_AGENT_ID, content: 'hamis' }), 'agent_id=main')
    expectBinding403(await call('POST', '/api/memories', agentTok, { content: 'nincs agent_id' }), 'agent_id absent')
    expect((await call('POST', '/api/memories', agentTok, { agent_id: AGENT, content: 'sajat emlek' })).status).toBe(200)
    expect((await call('POST', '/api/memories', MAIN_TOKEN, { content: 'fo emlek, agent_id nelkul' })).status).toBe(200)
  })

  it('memories PUT/PATCH: only own rows, never reassigned, updated_by is the caller; the main token unchanged', async () => {
    const foreign = saveAgentMemory('beta-ugynok', 'masik emleke', 'hot').id
    const own = saveAgentMemory(AGENT, 'sajat emlek', 'hot').id
    expectBinding403(await call('PATCH', `/api/memories/${foreign}`, agentTok, { category: 'cold' }), 'foreign row')
    expectBinding403(await call('PUT', `/api/memories/${foreign}`, agentTok, { content: 'atirva' }), 'foreign row PUT')
    expectBinding403(await call('PATCH', `/api/memories/${own}`, agentTok, { agent_id: 'beta-ugynok' }), 'reassign own row')
    expectBinding403(await call('PATCH', `/api/memories/${own}`, agentTok, { category: 'cold', updated_by: MAIN_AGENT_ID }), 'updated_by=main')
    const row = getDb().prepare('SELECT agent_id, content, category FROM memories WHERE id = ?').get(foreign) as { agent_id: string; content: string; category: string }
    expect(row).toEqual({ agent_id: 'beta-ugynok', content: 'masik emleke', category: 'hot' })
    expect((await call('PATCH', `/api/memories/${own}`, agentTok, { category: 'cold', updated_by: AGENT })).status).toBe(200)
    expect((await call('PATCH', `/api/memories/${foreign}`, MAIN_TOKEN, { category: 'cold', updated_by: MAIN_AGENT_ID })).status).toBe(200)
  })

  it('daily-log POST: agent_id must be the caller (absent = main, refused); the main token unchanged', async () => {
    expectBinding403(await call('POST', '/api/daily-log', agentTok, { content: '## x' }), 'absent')
    expectBinding403(await call('POST', '/api/daily-log', agentTok, { agent_id: MAIN_AGENT_ID, content: '## x' }), 'main')
    expect((await call('POST', '/api/daily-log', agentTok, { agent_id: AGENT, content: '## sajat' })).status).toBe(200)
    expect((await call('POST', '/api/daily-log', MAIN_TOKEN, { content: '## fo' })).status).toBe(200)
  })

  it('kanban: release force is the operator lane; claim/release/move/comment identities are the caller; the main token unchanged', async () => {
    const card = await call('POST', '/api/kanban', MAIN_TOKEN, { title: 'binding kartya' })
    const id = String(card.json.id)
    expectBinding403(await call('POST', `/api/kanban/${id}/claim`, agentTok, { agent: MAIN_AGENT_ID }), 'claim as main')
    expect((await call('POST', `/api/kanban/${id}/claim`, agentTok, { agent: AGENT })).status).toBe(200)
    expectBinding403(await call('POST', `/api/kanban/${id}/release`, agentTok, { agent: AGENT, force: true }), 'force release')
    expectBinding403(await call('POST', `/api/kanban/${id}/comments`, agentTok, { author: MAIN_AGENT_ID, content: 'hamis' }), 'comment as main')
    expectBinding403(await call('POST', `/api/kanban/${id}/move`, agentTok, { status: 'in_progress', actor: MAIN_AGENT_ID }), 'move as main')
    expectBinding403(await call('PUT', `/api/kanban/${id}`, agentTok, { title: 'x', actor: MAIN_AGENT_ID }), 'PUT as main')
    expect((await call('POST', `/api/kanban/${id}/comments`, agentTok, { author: AGENT, content: 'sajat' })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/move`, agentTok, { status: 'in_progress', actor: AGENT })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/release`, agentTok, { agent: AGENT })).status).toBe(200)
    // main token: force release and foreign authorship still pass the gate
    expect((await call('POST', `/api/kanban/${id}/claim`, MAIN_TOKEN, { agent: AGENT })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/release`, MAIN_TOKEN, { agent: MAIN_AGENT_ID, force: true })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/comments`, MAIN_TOKEN, { author: AGENT, content: 'fo irja' })).status).toBe(200)
  })

  it('unknown or missing token -> 401, exactly as before', async () => {
    for (const tok of ['nope', '0'.repeat(64), null]) {
      for (const [method, path] of [['GET', '/api/schedules'], ['POST', '/api/schedules'], ['POST', '/api/messages']] as const) {
        const r = await call(method, path, tok, method === 'POST' ? {} : undefined)
        expect(r.status, `${method} ${path} tok=${tok === null ? 'none' : 'bad'}`).toBe(401)
        expect(r.json).toEqual({ error: 'Unauthorized' })
      }
    }
  })
})

// ---- Allowlist coverage + measured replay ------------------------------------

// Drive gateRequest with a minimal res double: the gate either writes 401/403
// or returns the principal (the route would then run).
// A body that names the calling agent in every identity field the bindings know.
const selfBody = (agent: string): Record<string, unknown> => ({ from: agent, agent_id: agent, author: agent, actor: agent, agent, updated_by: agent })

async function gateStatus(method: string, path: string, token: string, resolver: (t: string) => string | null, body?: unknown, acl?: Record<string, string[]>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; auth?: unknown }> {
  const out: { status: number; body: Record<string, unknown>; auth?: unknown } = { status: 0, body: {} }
  const res = {
    writeHead(code: number) { out.status = code; return res },
    end(data?: unknown) { try { out.body = JSON.parse(String(data ?? '{}')) } catch { /* non-JSON */ } },
    setHeader() { return res },
  } as unknown as http.ServerResponse
  const url = new URL(`http://127.0.0.1${path}`)
  const auth = await gateRequest(mkReq({ authorization: `Bearer ${token}`, ...headers }, body), res, url, url.pathname, method, {
    dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID,
    ...(acl ? { agentVaultAcl: () => acl } : {}),
  })
  if (auth !== null) { out.status = 200; out.auth = auth } // passed the gate; the route decides from here
  return out
}

// One concrete request per allowlist entry. The coverage test fails if an entry
// is added without a sample, so this list cannot silently rot.
const ALLOWLIST_SAMPLES: Array<[string, string]> = [
  ['GET', '/api/schedules'], ['GET', '/api/schedules/summary'], ['HEAD', '/api/schedules'],
  ['POST', '/api/messages'], ['GET', '/api/messages'], ['GET', '/api/messages/42'], ['PUT', '/api/messages/42'],
  ['GET', '/api/kanban'], ['GET', '/api/kanban/abc123'], ['GET', '/api/kanban/abc123/comments'],
  ['GET', '/api/kanban-projects'], ['POST', '/api/kanban'], ['PUT', '/api/kanban/abc123'],
  ['POST', '/api/kanban/abc123/claim'], ['POST', '/api/kanban/abc123/release'], ['POST', '/api/kanban/abc123/move'],
  ['POST', '/api/kanban/abc123/comments'], ['POST', '/api/kanban/abc123/archive'], ['POST', '/api/kanban/abc123/unarchive'],
  ['POST', '/api/kanban/abc123/labels'], ['POST', '/api/kanban/abc123/blockers'],
  ['GET', '/api/memories'], ['GET', '/api/memories/42'], ['POST', '/api/memories'], ['PATCH', '/api/memories/42'], ['PUT', '/api/memories/42'],
  ['GET', '/api/daily-log'], ['GET', '/api/daily-log/dates'], ['POST', '/api/daily-log'],
  ['GET', '/api/approvals'], ['GET', '/api/approvals/abc-123'], ['POST', '/api/approvals'], ['POST', '/api/approvals/abc-123/consume'],
  ['GET', '/api/agents'],
  ['GET', '/api/vault'], ['GET', '/api/vault/teszt-sajat'], ['POST', '/api/vault/resolve'],
  ['POST', '/api/agent-taskstate/alfa'], ['GET', '/api/agent-taskstate/alfa'], ['GET', '/api/agent-taskstate/alfa/replay'], ['POST', '/api/agent-taskstate/alfa/consume'],
  ['POST', '/api/skill-usage'], ['POST', '/api/tool-log'], ['GET', '/api/voice/directive'],
]

// MEASURED on one production fleet: every dashboard call five sub-agents issued
// in 7 days (replay of their Claude Code transcripts; method inferred per call
// site). 918 calls, 29 distinct pairs in the raw count. ':id' stands for any
// concrete id. Two calls whose URL suffix was built at runtime were resolved by
// reading the call site -- one /move, one /comments -- and folded in.
const MEASURED_SUBAGENT_CALLS: Array<{ method: string; path: string; count: number }> = [
  { method: 'GET', path: '/api/agents', count: 3 },
  { method: 'GET', path: '/api/approvals', count: 2 },
  { method: 'POST', path: '/api/approvals', count: 1 },
  { method: 'GET', path: '/api/approvals/:id', count: 4 },
  { method: 'PATCH', path: '/api/approvals/:id', count: 1 },
  { method: 'GET', path: '/api/daily-log', count: 1 },
  { method: 'POST', path: '/api/daily-log', count: 26 },
  { method: 'GET', path: '/api/kanban', count: 97 },
  { method: 'POST', path: '/api/kanban', count: 40 },
  { method: 'GET', path: '/api/kanban/:id', count: 15 },
  { method: 'PUT', path: '/api/kanban/:id', count: 18 },
  { method: 'POST', path: '/api/kanban/:id/archive', count: 1 },
  { method: 'POST', path: '/api/kanban/:id/claim', count: 20 },
  { method: 'GET', path: '/api/kanban/:id/comments', count: 35 },
  { method: 'POST', path: '/api/kanban/:id/comments', count: 220 },
  { method: 'POST', path: '/api/kanban/:id/move', count: 72 },
  { method: 'POST', path: '/api/kanban/:id/release', count: 4 },
  { method: 'GET', path: '/api/memories', count: 24 },
  { method: 'POST', path: '/api/memories', count: 61 },
  { method: 'GET', path: '/api/memories/:id', count: 3 },
  { method: 'PATCH', path: '/api/memories/:id', count: 12 },
  { method: 'GET', path: '/api/messages', count: 36 },
  { method: 'POST', path: '/api/messages', count: 11 },
  { method: 'GET', path: '/api/messages/:id', count: 113 },
  { method: 'GET', path: '/api/schedules', count: 4 },
  { method: 'POST', path: '/api/schedules', count: 7 },
  { method: 'GET', path: '/api/vault', count: 1 },
  { method: 'GET', path: '/api/vault/:id', count: 86 },
]

// Not in the transcripts but called on a sub-agent's behalf: agent-msg.sh,
// the PreCompact prompt, the hooks and the message router's write-back
// contract (PUT /api/messages/:id).
const INDIRECT_SUBAGENT_CALLS: Array<[string, string]> = [
  ['POST', '/api/messages'], ['GET', '/api/messages'], ['PUT', '/api/messages/42'],
  ['POST', '/api/memories'], ['POST', '/api/daily-log'], ['POST', '/api/agent-taskstate/alfa'],
  ['GET', '/api/agent-taskstate/alfa/replay'], ['POST', '/api/agent-taskstate/alfa/consume'],
  ['POST', '/api/skill-usage'], ['POST', '/api/tool-log'], ['GET', '/api/voice/directive'],
]

describe('allowlist coverage and the measured replay', () => {
  const base = join(scratch.root, 'allow', 'agents')
  let agentTok = ''
  let resolver: (t: string) => string | null = () => null
  // A rowOwner route with a MISSING row is refused for an agent token, so the
  // samples for those routes point at a row the agent really owns.
  let ownMsg = 0
  let ownMem = 0
  const ownApproval = 'allow-own'
  const TEST_ACL = { 'teszt-sajat': [AGENT] }
  const own = (m: string, p: string): string =>
    m === 'PUT' && p === '/api/messages/42' ? `/api/messages/${ownMsg}`
      : (m === 'PUT' || m === 'PATCH') && p === '/api/memories/42' ? `/api/memories/${ownMem}`
        : m === 'POST' && p === '/api/approvals/abc-123/consume' ? `/api/approvals/${ownApproval}/consume`
          : p
  beforeAll(() => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
    resolver = createAgentTokenResolver({ baseDir: base })
    ownMsg = createAgentMessage(MAIN_AGENT_ID, AGENT, 'sajat uzenet').id
    ownMem = saveAgentMemory(AGENT, 'sajat emlek', 'hot').id
    createApproval({ id: ownApproval, agent_id: AGENT, category: 'teszt_kategoria', action_description: 'x' })
  })

  it('every allowlist entry has a sample, and every sample passes the gate for an agent token', async () => {
    for (const e of AGENT_TOKEN_ALLOWLIST) {
      const covered = ALLOWLIST_SAMPLES.some(([m, p]) => (e.methods.includes(m) || (m === 'HEAD' && e.methods.includes('GET'))) && e.pattern.test(p))
      expect(covered, `no sample for ${e.methods.join('|')} ${e.pattern}`).toBe(true)
    }
    for (const [m, p] of ALLOWLIST_SAMPLES) {
      const r = await gateStatus(m, own(m, p), agentTok, resolver, m === 'GET' || m === 'HEAD' ? undefined : selfBody(AGENT), TEST_ACL)
      expect(r.status, `${m} ${p} -> ${JSON.stringify(r.body)}`).toBe(200)
    }
  })

  it('replay: of the measured sub-agent calls only the named ones become 403, each under its rule', async () => {
    const denied: string[] = []
    let deniedCalls = 0
    for (const c of MEASURED_SUBAGENT_CALLS) {
      // every recovered body in the replay named its caller (0 mismatches), so the calls carry a self body
      const concrete = c.path === '/api/vault/:id' ? '/api/vault/teszt-sajat' : c.path.replace(':id', '42')
      const r = await gateStatus(c.method, own(c.method, concrete), agentTok, resolver, c.method === 'GET' ? undefined : selfBody(AGENT), TEST_ACL)
      if (r.status === 403) { denied.push(`${c.method} ${c.path} [${String(r.body.rule)}] x${c.count}`); deniedCalls += c.count } else expect(r.status, `${c.method} ${c.path}`).toBe(200)
    }
    expect(denied).toEqual([
      // resolving a level-2 approval is the main agent's / owner's lane (1 call: an agent withdrew its own request)
      'PATCH /api/approvals/:id [agent-token-scope] x1',
      // the policy this guard exists for
      'POST /api/schedules [schedule-writes-main-agent-only] x7',
    ])
    expect(deniedCalls).toBe(8)
    expect(MEASURED_SUBAGENT_CALLS.reduce((n, c) => n + c.count, 0)).toBe(918)
  })

  it('replay: every indirect call (scripts, hooks, PreCompact prompt) passes the gate', async () => {
    for (const [m, p] of INDIRECT_SUBAGENT_CALLS) {
      expect((await gateStatus(m, own(m, p), agentTok, resolver, m === 'GET' ? undefined : selfBody(AGENT))).status, `${m} ${p}`).toBe(200)
    }
  })

  it('outside the allowlist is 403 agent-token-scope; the main token passes the same requests', async () => {
    const outside: Array<[string, string]> = [
      ['POST', '/api/fleet/import'], ['GET', '/api/fleet/export'], ['POST', '/api/auth/device-keys'], ['POST', '/api/auth/users'],
      ['POST', '/api/security/bridge-enroll'], ['POST', '/api/terminal-input'], ['POST', '/api/agents/main/keys'],
      ['POST', '/api/agents/other/restart'], ['PUT', '/api/settings'], ['DELETE', '/api/memories/42'],
      ['POST', '/api/vault'], ['POST', '/api/vault/bindings'], ['DELETE', '/api/kanban/abc123'], ['PATCH', '/api/approvals/abc'],
      ['GET', '/api/agents/main/pane/stream'], ['GET', '/.well-known/fleetq'], ['GET', '/api/network-info'],
      // vault narrowed -- no sub-resources and no SSH material, decoded spellings included
      ['GET', '/api/vault/bindings'], ['GET', '/api/vault/scan'], ['GET', '/api/vault/ssh-keys'], ['GET', '/api/vault/ssh-servers'],
      ['GET', '/api/vault/ssh-key-abc123'], ['GET', '/api/vault/%73sh-key-abc123'], ['GET', '/api/vault/SSH-KEY-abc'], ['GET', '/api/vault/%62indings'],
      ['GET', '/api/vault/ssh-keys/abc'], ['GET', '/api/vault/ssh-servers/1'],
      // and an id the ACL does not list for the caller (the default: an empty file)
      ['GET', '/api/vault/teszt-sajat'],
    ]
    for (const [m, p] of outside) {
      const r = await gateStatus(m, p, agentTok, resolver, undefined, {})
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.body.rule).toBe('agent-token-scope')
      expect(r.body.main_agent).toBe(MAIN_AGENT_ID)
      expect((await gateStatus(m, p, MAIN_TOKEN, resolver, undefined, {})).status, `main ${m} ${p}`).toBe(200)
    }
  })
})

// ---- Backward compatibility: an install that only has the shared token --------

describe('shared-token-only install (AGENT_TOKENS off, no agent token on disk) is unchanged', () => {
  const base = join(scratch.root, 'compat', 'agents')
  beforeAll(() => {
    // a sub-agent dir WITHOUT a token file, the state every install starts in
    mkdirSync(join(base, AGENT), { recursive: true })
    writeFileSync(join(base, AGENT, 'CLAUDE.md'), `curl -H "Authorization: Bearer $(cat ${mainTokenPath()})" u\n`)
  })
  afterAll(() => { agentTokensSwitch.value = '1' })

  // Every request shape the suites above exercise, plus the ones only the main
  // lane ever makes. The shared token must get EXACTLY what resolveAuth +
  // the old inline 401 gave it: the same principal, no 403, no body read.
  const SHAPES: Array<[string, string, unknown?]> = [
    ...ALLOWLIST_SAMPLES.map(([m, p]) => [m, p, m === 'GET' || m === 'HEAD' ? undefined : { from: OTHER, agent_id: OTHER, actor: MAIN_AGENT_ID }] as [string, string, unknown?]),
    ['POST', '/api/schedules', { name: 'x' }], ['DELETE', '/api/schedules/x'], ['POST', '/api/fleet/import'], ['POST', '/api/auth/device-keys'],
    ['PATCH', '/api/approvals/abc'], ['DELETE', '/api/memories/42'], ['GET', '/api/vault/ssh-key-abc'], ['PUT', '/api/settings'],
    ['POST', '/api/approvals', { agent_id: MAIN_AGENT_ID, owner_approved_message_id: 1 }],
    ['POST', '/api/kanban/abc/release', { agent: OTHER, force: true }],
  ]

  it('the switch reads off when the setting is 0, and syncAgentTokenOnStart then writes nothing', () => {
    agentTokensSwitch.value = '0'
    expect(syncAgentTokenOnStart(AGENT, { baseDir: base })).toEqual({ provisioned: false, rewritten: false })
    expect(existsSync(agentTokenPath(AGENT, base))).toBe(false)
    expect(readFileSync(join(base, AGENT, 'CLAUDE.md'), 'utf-8')).toBe(`curl -H "Authorization: Bearer $(cat ${mainTokenPath()})" u\n`)
    expect(dashboardTokenPathFor(AGENT, base)).toBe(mainTokenPath())
  })

  it('every request with the shared token (with and without X-Agent-Id) passes the gate with the same principal resolveAuth gives', async () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    for (const [m, p, body] of SHAPES) {
      for (const headers of [{}, { 'x-agent-id': MAIN_AGENT_ID }] as Array<Record<string, string>>) {
        const r = await gateStatus(m, p, MAIN_TOKEN, resolver, body, {}, headers)
        expect(r.status, `${m} ${p} ${JSON.stringify(headers)}`).toBe(200)
        const url = new URL(`http://127.0.0.1${p}`)
        const plain = resolveAuth(mkReq({ authorization: `Bearer ${MAIN_TOKEN}`, ...headers }), url, url.pathname, m, MAIN_TOKEN)
        expect(r.auth, `${m} ${p}`).toStrictEqual(plain)
        expect((r.auth as { tokenAgent?: string }).tokenAgent).toBeUndefined()
      }
    }
  })

  it('the gate leaves the body unread for the shared token, so the route reads it as before', async () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    const req = mkReq({ authorization: `Bearer ${MAIN_TOKEN}` }, { from: MAIN_AGENT_ID, to: OTHER, content: 'x' })
    const res = { writeHead() { throw new Error('the gate must not answer') }, end() { throw new Error('the gate must not answer') } } as unknown as http.ServerResponse
    const url = new URL('http://127.0.0.1/api/messages')
    expect(await gateRequest(req, res, url, url.pathname, 'POST', { dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID })).toEqual({ kind: 'token' })
    const { readBody } = await import('../web/http-helpers.js')
    expect(JSON.parse((await readBody(req)).toString())).toEqual({ from: MAIN_AGENT_ID, to: OTHER, content: 'x' })
  })

  it('an unknown bearer is still the plain 401, and a public probe still needs nothing', async () => {
    const resolver = createAgentTokenResolver({ baseDir: base })
    expect((await gateStatus('GET', '/api/memories', 'nope', resolver)).status).toBe(401)
    const out = { status: 0 }
    const res = { writeHead(c: number) { out.status = c; return res }, end() { /* */ } } as unknown as http.ServerResponse
    const url = new URL('http://127.0.0.1/api/auth/status')
    expect(await gateRequest(mkReq({}), res, url, url.pathname, 'GET', { dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID })).toEqual({ kind: 'none' })
    expect(out.status).toBe(0)
  })
})
