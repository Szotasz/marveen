// Identity binding for a sub-agent token, the guarded message close, and the
// per-agent vault read allowlist (store/vault-acl.json).
//
// With the shared token the identity a request asserts (`from`, `agent_id`,
// `author`, the agent in a task-state path) is a claim nobody can check. A
// sub-agent's own token names the caller, so every such claim is held to it.
// Driven through the real routes behind the real gate, over a real socket.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

// Never notify anyone from a test: the approvals route tells the owner.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => null) }
})
vi.mock('../notify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../notify.js')>()
  return { ...real, sendOwnerMessage: vi.fn(async () => ({ sent: false })) }
})
// The vault route would read the checkout's store/vault.json + key. A stub:
// 'example-*' ids exist, and the listing carries names only, like listSecrets().
vi.mock('../web/vault.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/vault.js')>()
  return {
    ...real,
    getSecret: (id: string) => (id.startsWith('example-') ? `value-of-${id}` : null),
    listSecrets: () => [{ id: 'example-own-key', label: 'own', createdAt: '', updatedAt: '' }, { id: 'example-other-key', label: 'other', createdAt: '', updatedAt: '' }],
  }
})
// POST /api/messages accepts only a registered sender (agents/<id>/ under the
// project root). The test agents are registered here instead of on disk.
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, isKnownAgent: (n: string) => n.startsWith('agent-') || real.isKnownAgent(n) }
})

const scratch = (() => {
  const root = mkdtempSync(join(tmpdir(), 'agent-token-identity-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.NODE_ENV = 'test'
  delete process.env.AGENT_DASHBOARD_TOKENS
  delete process.env.VAULT_ACL_AGENT_MODE
  return { root, home }
})()

const { initDatabase, createAgentMessage, saveAgentMemory, getAgentMessage, getDb, listApprovals, closeMessageAsRecipient } = await import('../db.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { logger } = await import('../logger.js')
const { gateRequest, agentIdentityViolation, AGENT_IDENTITY_BINDINGS, isAgentVaultReadAllowed } = await import('../web/auth-gate.js')
const { ensureAgentToken, createAgentTokenResolver, agentTokenPath } = await import('../web/agent-tokens.js')
const { principalOf, _resetVaultAclAgentModeCacheForTest } = await import('../web/vault-acl.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { tryHandleMemories } = await import('../web/routes/memories.js')
const { tryHandleDailyLog } = await import('../web/routes/daily-log.js')
const { tryHandleAgentTaskState } = await import('../web/routes/agent-taskstate.js')
const { tryHandleToolLog } = await import('../web/routes/tool-log.js')
const { tryHandleSkillUsage } = await import('../web/routes/skill-usage.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')

const MAIN_TOKEN = 'f'.repeat(64)
const AGENT = 'agent-a'
const OTHER = 'agent-b'
const HASH = 'a'.repeat(64)
// The vault reader allowlist the gate consults (store/vault-acl.json in production).
const VAULT_ACL = { 'example-own-key': [AGENT], 'example-other-key': [OTHER] }

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(scratch.root, { recursive: true, force: true }) })
afterEach(() => { setVaultMode(undefined) })

let server: http.Server
let origin = ''
let agentTok = ''
const taskStateDir = join(PROJECT_ROOT, 'store', 'agent-taskstate')

beforeAll(async () => {
  const base = join(scratch.root, 'agents')
  mkdirSync(join(base, AGENT), { recursive: true })
  ensureAgentToken(AGENT, base, MAIN_TOKEN)
  agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
  const resolveAgentToken = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method || 'GET'
    const auth = await gateRequest(req, res, url, path, method, {
      dashboardToken: MAIN_TOKEN, resolveAgentToken, mainAgentId: MAIN_AGENT_ID, vaultAcl: () => VAULT_ACL,
    })
    if (auth === null) return
    const ctx = {
      req, res, path, method, url, fedPeer: null,
      auth: auth.kind === 'token' ? (auth.agent ? { kind: 'token' as const, agent: auth.agent } : { kind: 'token' as const }) : undefined,
    }
    try {
      if (await tryHandleMessages(ctx)) return
      if (await tryHandleDailyLog(ctx)) return
      if (await tryHandleMemories(ctx)) return
      if (await tryHandleKanban(ctx)) return
      if (await tryHandleAgentTaskState(ctx)) return
      if (await tryHandleApprovals(ctx)) return
      if (await tryHandleToolLog(ctx)) return
      if (await tryHandleSkillUsage(ctx)) return
      if (await tryHandleConnectors(ctx)) return
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
  for (const n of [AGENT, OTHER]) rmSync(join(taskStateDir, `${n}.json`), { force: true })
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

function expectBindingRefusal(r: { status: number; json: Record<string, unknown> }, what: string): void {
  expect(r.status, `${what}: ${JSON.stringify(r.json)}`).toBe(403)
  expect(r.json.rule, what).toBe('agent-identity-binding')
  expect(r.json.agent, what).toBe(AGENT)
  expect(r.json.main_agent, what).toBe(MAIN_AGENT_ID)
}

describe('identity binding: one 403 per binding, the main token unchanged', () => {
  it('approvals: filed only in the caller\'s name; the owner-lane field is refused', async () => {
    const before = listApprovals({ limit: 500 }).length
    expectBindingRefusal(await call('POST', '/api/approvals', agentTok, { agent_id: MAIN_AGENT_ID, category: 'email_send', action_description: 'x', content_hash: HASH }), 'as main')
    expectBindingRefusal(await call('POST', '/api/approvals', agentTok, { agent_id: OTHER, category: 'email_send', action_description: 'x' }), 'as another agent')
    // own agent_id does not unlock the born-approved field either
    expectBindingRefusal(await call('POST', '/api/approvals', agentTok, {
      agent_id: AGENT, category: 'email_send', action_description: 'x', content_hash: HASH, owner_approved_message_id: 1,
    }), 'owner-lane field with own agent_id')
    expect(listApprovals({ limit: 500 }).length).toBe(before)
    const own = await call('POST', '/api/approvals', agentTok, { agent_id: AGENT, category: 'email_send', action_description: 'own request', content_hash: HASH })
    expect(own.status, JSON.stringify(own.json)).toBe(201)
    expect(own.json.status).toBe('pending')
    const main = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: OTHER, category: 'email_send', action_description: 'filed by main' })
    expect(main.status, JSON.stringify(main.json)).toBe(201)
  })

  it('messages POST: from must be the calling agent', async () => {
    expectBindingRefusal(await call('POST', '/api/messages', agentTok, { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'forged' }), 'from=main')
    expectBindingRefusal(await call('POST', '/api/messages', agentTok, { from: OTHER, to: MAIN_AGENT_ID, content: 'forged' }), 'from=other')
    const ok = await call('POST', '/api/messages', agentTok, { from: AGENT, to: MAIN_AGENT_ID, content: 'own' })
    expect(ok.status).toBe(200)
    expect(ok.json.from_agent).toBe(AGENT)
    expect((await call('POST', '/api/messages', MAIN_TOKEN, { from: OTHER, to: MAIN_AGENT_ID, content: 'main may' })).status).toBe(200)
  })

  it('messages PUT: only a message addressed to the caller can be closed by it', async () => {
    const toMain = createAgentMessage(OTHER, MAIN_AGENT_ID, 'for main')
    const toSelf = createAgentMessage(MAIN_AGENT_ID, AGENT, 'for the agent')
    expectBindingRefusal(await call('PUT', `/api/messages/${toMain.id}`, agentTok, { status: 'failed', result: 'x', notify: false }), 'close foreign')
    expect(getAgentMessage(toMain.id)?.status).toBe('pending')
    expect((await call('PUT', `/api/messages/${toSelf.id}`, agentTok, { status: 'done', result: 'done', notify: false })).status).toBe(200)
    expect((await call('PUT', `/api/messages/${toMain.id}`, MAIN_TOKEN, { status: 'done', result: 'done', notify: false })).status).toBe(200)
  })

  it('agent-taskstate: the path agent must be the caller', async () => {
    const st = { summary: 's', doneSteps: [], alreadyDelegated: [], nextAction: 'n' }
    expectBindingRefusal(await call('POST', `/api/agent-taskstate/${OTHER}`, agentTok, st), 'foreign path agent')
    expectBindingRefusal(await call('POST', `/api/agent-taskstate/${MAIN_AGENT_ID}/consume`, agentTok, {}), 'consume main')
    expectBindingRefusal(await call('GET', `/api/agent-taskstate/${MAIN_AGENT_ID}/replay`, agentTok), 'replay main')
    expect(existsSync(join(taskStateDir, `${OTHER}.json`))).toBe(false)
    expect((await call('POST', `/api/agent-taskstate/${AGENT}`, agentTok, st)).status).toBe(200)
    expect((await call('POST', `/api/agent-taskstate/${OTHER}`, MAIN_TOKEN, st)).status).toBe(200)
  })

  it('memories POST: agent_id must be the caller (absent = main, refused)', async () => {
    expectBindingRefusal(await call('POST', '/api/memories', agentTok, { agent_id: MAIN_AGENT_ID, content: 'forged' }), 'agent_id=main')
    expectBindingRefusal(await call('POST', '/api/memories', agentTok, { content: 'no agent_id' }), 'agent_id absent')
    expectBindingRefusal(await call('POST', '/api/memories', agentTok, { agent_id: ` ${AGENT} `, content: 'padded' }), 'padded agent_id')
    expect((await call('POST', '/api/memories', agentTok, { agent_id: AGENT, content: 'own memory' })).status).toBe(200)
    expect((await call('POST', '/api/memories', MAIN_TOKEN, { content: 'main memory, no agent_id' })).status).toBe(200)
  })

  it('memories PUT/PATCH: only own rows, never reassigned, updated_by is the caller', async () => {
    const foreign = saveAgentMemory(OTHER, 'another agent\'s memory', 'hot').id
    const own = saveAgentMemory(AGENT, 'own memory', 'hot').id
    expectBindingRefusal(await call('PATCH', `/api/memories/${foreign}`, agentTok, { category: 'cold' }), 'foreign row')
    expectBindingRefusal(await call('PUT', `/api/memories/${foreign}`, agentTok, { content: 'overwritten' }), 'foreign row PUT')
    expectBindingRefusal(await call('PATCH', `/api/memories/${own}`, agentTok, { agent_id: OTHER }), 'reassign own row')
    expectBindingRefusal(await call('PATCH', `/api/memories/${own}`, agentTok, { category: 'cold', updated_by: MAIN_AGENT_ID }), 'updated_by=main')
    expectBindingRefusal(await call('PATCH', '/api/memories/999999', agentTok, { category: 'cold' }), 'missing row')
    const row = getDb().prepare('SELECT agent_id, content, category FROM memories WHERE id = ?').get(foreign) as { agent_id: string; content: string; category: string }
    expect(row).toEqual({ agent_id: OTHER, content: 'another agent\'s memory', category: 'hot' })
    expect((await call('PATCH', `/api/memories/${own}`, agentTok, { category: 'cold', updated_by: AGENT })).status).toBe(200)
    expect((await call('PATCH', `/api/memories/${foreign}`, MAIN_TOKEN, { category: 'cold', updated_by: MAIN_AGENT_ID })).status).toBe(200)
  })

  it('daily-log POST: agent_id must be the caller (absent = main, refused)', async () => {
    expectBindingRefusal(await call('POST', '/api/daily-log', agentTok, { content: '## x' }), 'absent')
    expectBindingRefusal(await call('POST', '/api/daily-log', agentTok, { agent_id: MAIN_AGENT_ID, content: '## x' }), 'main')
    expect((await call('POST', '/api/daily-log', agentTok, { agent_id: AGENT, content: '## own' })).status).toBe(200)
    expect((await call('POST', '/api/daily-log', MAIN_TOKEN, { content: '## main' })).status).toBe(200)
  })

  it('kanban: comment author and move/PUT actor are the caller', async () => {
    const card = await call('POST', '/api/kanban', MAIN_TOKEN, { title: 'binding card' })
    const id = String(card.json.id)
    expectBindingRefusal(await call('POST', '/api/kanban', agentTok, { title: 'x', actor: MAIN_AGENT_ID }), 'create as main')
    expectBindingRefusal(await call('POST', `/api/kanban/${id}/comments`, agentTok, { author: MAIN_AGENT_ID, content: 'forged' }), 'comment as main')
    expectBindingRefusal(await call('POST', `/api/kanban/${id}/move`, agentTok, { status: 'in_progress', actor: MAIN_AGENT_ID }), 'move as main')
    expectBindingRefusal(await call('PUT', `/api/kanban/${id}`, agentTok, { title: 'x', actor: MAIN_AGENT_ID }), 'PUT as main')
    expect((await call('POST', `/api/kanban/${id}/comments`, agentTok, { author: AGENT, content: 'own' })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/move`, agentTok, { status: 'in_progress', actor: AGENT })).status).toBe(200)
    expect((await call('POST', `/api/kanban/${id}/comments`, MAIN_TOKEN, { author: OTHER, content: 'main writes' })).status).toBe(200)
  })

  it('tool-log and skill-usage agent_id are bound', async () => {
    expectBindingRefusal(await call('POST', '/api/tool-log', agentTok, { session_id: 's', tool_name: 'Bash', agent_id: MAIN_AGENT_ID }), 'tool-log as main')
    expectBindingRefusal(await call('POST', '/api/skill-usage', agentTok, { agent_id: MAIN_AGENT_ID, skill_name: 'x', trigger_type: 'tool_call' }), 'skill-usage as main')
    expect((await call('POST', '/api/tool-log', agentTok, { session_id: 's', tool_name: 'Bash', agent_id: AGENT })).status).toBe(200)
  })
})

describe('the PUT /api/messages/:id close is bound in the UPDATE itself', () => {
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
      // headers + the first chunk now: a lookup at this point finds no row
      r.write('{"status":"done",')
      setTimeout(() => {
        // ...then the message the caller waited for is created, at exactly the pre-armed id
        victimId = createAgentMessage(MAIN_AGENT_ID, OTHER, 'a task for another agent').id
        r.end('"result":"forged result","notify":true}')
      }, 250)
    })
    expect(victimId).toBe(nextId) // the race really hit the pre-armed id
    expect(reply.status, reply.body).toBe(403)
    expect(JSON.parse(reply.body).rule).toBe('agent-identity-binding')
    const row = getAgentMessage(victimId)
    expect(row?.status).toBe('pending')
    expect(row?.result).toBeNull()
    const forged = getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE content LIKE ?').get(`%msg_id:${victimId} %`) as { n: number }
    expect(forged.n).toBe(0)
  })

  it('a PUT on a message id that does not exist is refused for an agent token (not deferred to 404)', async () => {
    const r = await call('PUT', `/api/messages/${nextMessageId() + 50}`, agentTok, { status: 'done', result: 'x' })
    expectBindingRefusal(r, 'missing row')
    expect(String(r.json.error)).toContain('does not exist')
  })

  it('closeMessageAsRecipient: only the recipient, only from an open status, in one UPDATE', () => {
    const m = createAgentMessage(MAIN_AGENT_ID, 'agent-recipient', 'x')
    expect(closeMessageAsRecipient(m.id, 'agent-someone-else', 'done', 'r')).toBe(false)
    expect(getAgentMessage(m.id)?.status).toBe('pending')
    expect(closeMessageAsRecipient(m.id, 'agent-recipient', 'done', 'finished')).toBe(true)
    const done = getAgentMessage(m.id)!
    expect(done.status).toBe('done')
    expect(done.result).toBe('finished')
    expect(done.delivered_at).not.toBeNull()
    expect(closeMessageAsRecipient(m.id, 'agent-recipient', 'failed', 'again')).toBe(false) // final stays final
    expect(getAgentMessage(m.id)?.result).toBe('finished')
    const f = createAgentMessage(MAIN_AGENT_ID, 'agent-recipient', 'y')
    expect(closeMessageAsRecipient(f.id, 'agent-recipient', 'failed', 'error')).toBe(true)
    expect(getAgentMessage(f.id)?.status).toBe('failed')
    expect(getAgentMessage(f.id)?.delivered_at).toBeNull()
    // failed is final too, as for every caller since #2011 (closeOpenMessage)
    expect(closeMessageAsRecipient(f.id, 'agent-someone-else', 'done', 'x')).toBe(false)
    expect(closeMessageAsRecipient(f.id, 'agent-recipient', 'done', 'later')).toBe(false)
    expect(getAgentMessage(f.id)?.status).toBe('failed')
    expect(closeMessageAsRecipient(999_999, 'agent-recipient', 'done')).toBe(false)
  })

  it('a message the router marked failed is final for the recipient too (as for every caller since #2011)', async () => {
    const m = createAgentMessage(OTHER, AGENT, 'delivery gave up, the work happened anyway')
    getDb().prepare("UPDATE agent_messages SET status = 'failed', result = 'router: undeliverable' WHERE id = ?").run(m.id)
    expect((await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'failed', result: 'again' })).status).toBe(409)
    const done = await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'done', result: 'finished after all' })
    expect(done.status, JSON.stringify(done.json)).toBe(409)
    expect(getAgentMessage(m.id)?.status).toBe('failed')
    expect(getAgentMessage(m.id)?.result).toBe('router: undeliverable')
    const report = getDb().prepare('SELECT from_agent, to_agent FROM agent_messages WHERE content LIKE ?').get(`%msg_id:${m.id} %`)
    expect(report).toBeUndefined()
    // another agent's failed message stays out of reach
    const foreign = createAgentMessage(MAIN_AGENT_ID, OTHER, 'not yours')
    getDb().prepare("UPDATE agent_messages SET status = 'failed' WHERE id = ?").run(foreign.id)
    expect((await call('PUT', `/api/messages/${foreign.id}`, agentTok, { status: 'done', result: 'x' })).status).toBe(403)
    expect(getAgentMessage(foreign.id)?.status).toBe('failed')
  })

  it('an agent token re-closing its own finished message gets 409 and no second report', async () => {
    const m = createAgentMessage(MAIN_AGENT_ID, AGENT, 'closable once')
    expect((await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'done', result: 'first', notify: false })).status).toBe(200)
    const again = await call('PUT', `/api/messages/${m.id}`, agentTok, { status: 'failed', result: 'second' })
    expect(again.status).toBe(409)
    expect(again.json.main_agent).toBe(MAIN_AGENT_ID)
    expect(getAgentMessage(m.id)?.result).toBe('first')
  })

  it('main token PUT is as on develop: any recipient, completion report sent, a re-close is 409 (#2011), 404 on a missing row', async () => {
    const m = createAgentMessage(MAIN_AGENT_ID, OTHER, 'task')
    expect((await call('PUT', `/api/messages/${m.id}`, MAIN_TOKEN, { status: 'done', result: 'closed by main' })).status).toBe(200)
    expect(getAgentMessage(m.id)?.status).toBe('done')
    const report = getDb().prepare('SELECT from_agent, to_agent FROM agent_messages WHERE content LIKE ?').get(`%msg_id:${m.id} %`) as { from_agent: string; to_agent: string } | undefined
    expect(report).toEqual({ from_agent: OTHER, to_agent: MAIN_AGENT_ID })
    expect((await call('PUT', `/api/messages/${m.id}`, MAIN_TOKEN, { status: 'failed', result: 'after all', notify: false })).status).toBe(409)
    expect(getAgentMessage(m.id)?.status).toBe('done')
    expect((await call('PUT', `/api/messages/${nextMessageId() + 99}`, MAIN_TOKEN, { status: 'done' })).status).toBe(404)
  })
})

function setVaultMode(v: string | undefined): void {
  if (v === undefined) delete process.env.VAULT_ACL_AGENT_MODE
  else process.env.VAULT_ACL_AGENT_MODE = v
  _resetVaultAclAgentModeCacheForTest()
}

describe('vault: per-agent reads through store/vault-acl.json', () => {
  it('default (audit): an unlisted id is served, and the audit row names the AGENT and the verdict', async () => {
    const spy = vi.spyOn(logger, 'info')
    try {
      expect((await call('GET', '/api/vault/example-other-key', agentTok)).status).toBe(200)
      const row = spy.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f?.event === 'vault-read' && f?.id === 'example-other-key')
      expect(row).toMatchObject({ kind: 'agent', principal: AGENT, mode: 'audit', found: true })
    } finally {
      spy.mockRestore()
    }
    // the floor holds in audit mode too
    expect((await call('GET', '/api/vault/ssh-key-abc', agentTok)).status).toBe(403)
    expect((await call('GET', '/api/vault/bindings', agentTok)).status).toBe(403)
  })

  it('VAULT_ACL_AGENT_MODE=enforce: own id 200, another agent\'s or an unlisted id 403, ssh 403, listing names only; the main token unchanged', async () => {
    setVaultMode('enforce')
    const own = await call('GET', '/api/vault/example-own-key', agentTok)
    expect(own.status).toBe(200)
    expect(own.json.value).toBe('value-of-example-own-key')
    for (const p of ['/api/vault/example-other-key', '/api/vault/example-unlisted-key', '/api/vault/ssh-key-abc', '/api/vault/%73sh-key-abc', '/api/vault/ssh-keys', '/api/vault/bindings']) {
      const r = await call('GET', p, agentTok)
      expect(r.status, p).toBe(403)
      expect(r.json.rule, p).toBe('agent-token-scope')
      expect(r.json.main_agent, p).toBe(MAIN_AGENT_ID)
    }
    expect(String((await call('GET', '/api/vault/example-other-key', agentTok)).json.error)).toContain('store/vault-acl.json')
    const list = await call('GET', '/api/vault', agentTok)
    expect(list.status).toBe(200)
    const secrets = list.json.secrets as Array<Record<string, unknown>>
    expect(secrets.map((x) => x.id)).toEqual(['example-own-key', 'example-other-key'])
    expect(secrets.every((x) => !('value' in x) && !('encrypted' in x))).toBe(true)
    // main token: any ordinary id, a missing one is the route's 404, an SSH key the route's own 403
    expect((await call('GET', '/api/vault/example-other-key', MAIN_TOKEN)).status).toBe(200)
    expect((await call('GET', '/api/vault/no-such-secret', MAIN_TOKEN)).status).toBe(404)
    expect((await call('GET', '/api/vault/ssh-key-abc', MAIN_TOKEN)).status).toBe(403)
  })

  it('enforce with an empty file: no file / no entry / an empty list means no sub-agent reads the id', () => {
    setVaultMode('enforce')
    expect(isAgentVaultReadAllowed(AGENT, 'example-own-key', {})).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, 'example-own-key', { 'example-own-key': [] })).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, 'example-own-key', { 'example-own-key': [AGENT] })).toBe(true)
    // the ssh / sub-resource floor holds even when the file lists them
    expect(isAgentVaultReadAllowed(AGENT, 'ssh-key-x', { 'ssh-key-x': [AGENT] })).toBe(false)
    expect(isAgentVaultReadAllowed(AGENT, 'bindings', { bindings: [AGENT] })).toBe(false)
  })

  it('the audit row names the agent principal: kind "agent", never the shared "token"', () => {
    expect(principalOf({ kind: 'token', agent: AGENT })).toEqual({ kind: 'agent', principal: AGENT })
    expect(principalOf({ kind: 'token', claimedAgent: AGENT })).toEqual({ kind: 'token', principal: 'token' })
    expect(principalOf({ kind: 'token' })).toEqual({ kind: 'token', principal: 'token' })
  })
})

describe('gate level: claim/release (the claim lock of open PR #1982) and the binding table', () => {
  // claim/release routes are not on this branch's router; the gate decides first.
  async function gate(method: string, path: string, body: unknown): Promise<number> {
    let status = 0
    const res = { writeHead(c: number) { status = c; return res }, end() { /* */ }, setHeader() { return res } } as unknown as http.ServerResponse
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${agentTok}` }
    const url = new URL(`http://127.0.0.1${path}`)
    const resolver = createAgentTokenResolver({ baseDir: join(scratch.root, 'agents'), mainToken: MAIN_TOKEN })
    const auth = await gateRequest(req, res, url, url.pathname, method, { dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID })
    return auth === null ? status : 200
  }

  it('claim and release as the caller pass; as another agent, or with force, are refused', async () => {
    expect(await gate('POST', '/api/kanban/c1/claim', { agent: AGENT })).toBe(200)
    expect(await gate('POST', '/api/kanban/c1/claim', { agent: MAIN_AGENT_ID })).toBe(403)
    expect(await gate('POST', '/api/kanban/c1/claim', { actor: OTHER })).toBe(403)
    expect(await gate('POST', '/api/kanban/c1/release', { agent: AGENT })).toBe(200)
    expect(await gate('POST', '/api/kanban/c1/release', { agent: AGENT, force: true })).toBe(403)
  })

  it('a body naming the caller in every field passes every body binding', () => {
    const self = { from: AGENT, agent_id: AGENT, author: AGENT, actor: AGENT, agent: AGENT, updated_by: AGENT }
    const lk = { messageRecipient: () => AGENT, memoryOwner: () => AGENT }
    for (const [m, p] of [['POST', '/api/messages'], ['PUT', '/api/messages/1'], ['POST', '/api/memories'], ['PATCH', '/api/memories/1'],
      ['POST', '/api/daily-log'], ['POST', '/api/approvals'], ['POST', '/api/kanban'], ['PUT', '/api/kanban/c1'], ['POST', '/api/kanban/c1/comments'],
      ['POST', '/api/kanban/c1/move'], ['POST', '/api/kanban/c1/labels'], ['POST', '/api/tool-log'], ['POST', '/api/skill-usage'],
      ['POST', `/api/agent-taskstate/${AGENT}`]] as const) {
      expect(agentIdentityViolation(AGENT, m, p, self, MAIN_AGENT_ID, lk), `${m} ${p}`).toBeNull()
    }
    expect(AGENT_IDENTITY_BINDINGS.every((b) => b.why.length > 0)).toBe(true)
  })

  it('a row lookup that throws fails CLOSED at the gate (403), never open', async () => {
    let status = 0
    const res = { writeHead(c: number) { status = c; return res }, end() { /* */ }, setHeader() { return res } } as unknown as http.ServerResponse
    const req = Readable.from([Buffer.from('{"status":"done"}')]) as unknown as http.IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${agentTok}` }
    const url = new URL('http://127.0.0.1/api/messages/1')
    const resolver = createAgentTokenResolver({ baseDir: join(scratch.root, 'agents'), mainToken: MAIN_TOKEN })
    const auth = await gateRequest(req, res, url, url.pathname, 'PUT', {
      dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID,
      identityLookups: { messageRecipient: () => { throw new Error('db down') }, memoryOwner: () => null },
    })
    expect(auth).toBeNull()
    expect(status).toBe(403)
  })
})
