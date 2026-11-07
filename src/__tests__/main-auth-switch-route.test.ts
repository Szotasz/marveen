// MAINAUTHSWITCH1107 (Dani 72343, two surviving mutants): the main agent's PUT RUN through the real route, with the
// vault, the agent-config writer and the live probe stubbed (no real vault, Keychain or agent dir is touched).
//  - leaving api deletes the stored key (as for sub-agents);
//  - an unreadable vault answers 503 and changes nothing;
//  - the shared access token is refused (owner only).
import { Readable } from 'node:stream'
import type http from 'node:http'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

const h = vi.hoisted(() => ({
  vaultThrows: false,
  stored: null as string | null,
  setSecret: vi.fn(),
  deleteSecret: vi.fn(() => true),
  writeAgentAuthMode: vi.fn(),
  probe: vi.fn(async () => 'ok' as const),
}))
vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  getSecret: () => { if (h.vaultThrows) throw new Error('keychain not reachable'); return h.stored },
  setSecret: (...a: unknown[]) => (h.setSecret as any)(...a),
  deleteSecret: (...a: unknown[]) => (h.deleteSecret as any)(...a),
}))
// The route mkdirs agentDir(<main>) before writing the mode: pointed at a throwaway dir, so a run never creates
// agents/<main> in the checkout (that dir makes the main id a "known agent" for later tests in the same run).
const TMP_AGENTS = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'mauth-route-agents-'))
})
vi.mock('../web/agent-config.js', async (orig) => {
  const { join } = await import('node:path')
  return {
    ...(await orig<typeof import('../web/agent-config.js')>()),
    agentDir: (n: string) => join(TMP_AGENTS, n),
    writeAgentAuthMode: (...a: unknown[]) => (h.writeAgentAuthMode as any)(...a),
    readAgentCustomProvider: () => null,
  }
})
vi.mock('../web/claude-credentials-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-credentials-guard.js')>()),
  liveProbeAuth: (...a: unknown[]) => (h.probe as any)(...a),
}))
// the real owner gate; only the refusal body is simplified (no dashboard-user lookup in a unit test)
vi.mock('../web/routes/auth.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/auth.js')>()),
  refuseOwner: (res: http.ServerResponse, msg: string) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 'owner_session_required', error: msg }))
  },
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  resolveMainAgentConfigDir: () => null,
  resolveMainAgentRotatedConfigDir: () => null,
  resolveMainAgentRotatedTokenSecretId: () => null,
}))

const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { existsSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const CHECKOUT_MAIN_DIR = join(PROJECT_ROOT, 'agents', MAIN_AGENT_ID)
const checkoutHadMainDir = existsSync(CHECKOUT_MAIN_DIR)
afterAll(() => {
  rmSync(TMP_AGENTS, { recursive: true, force: true })
  // the run itself must not have created it
  if (!checkoutHadMainDir) expect(existsSync(CHECKOUT_MAIN_DIR)).toBe(false)
})

type Auth = RouteContext['auth']
async function put(body: unknown, auth: Auth) {
  const out = { status: 0, body: null as Record<string, unknown> | null }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method: 'PUT', url: `/api/agents/${MAIN_AGENT_ID}` })
  const url = new URL(`http://localhost:3420/api/agents/${MAIN_AGENT_ID}`)
  const ctx = { req, res, path: url.pathname, method: 'PUT', url, auth } as unknown as RouteContext
  await tryHandleAgents(ctx, '/nonexistent-web-root')
  return out
}
const SESSION = { kind: 'session' } as Auth
const TOKEN = { kind: 'token', agent: 'zz-agent' } as Auth

beforeEach(() => {
  h.vaultThrows = false; h.stored = null
  h.setSecret.mockClear(); h.deleteSecret.mockClear(); h.writeAgentAuthMode.mockClear(); h.probe.mockClear()
})

describe('PUT /api/agents/<main>: the authentication switch, run through the route', () => {
  it('leaving api (back to shared) deletes the stored key and writes the mode', async () => {
    h.stored = 'fake-stored-key-0123456789abcdef'
    const r = await put({ authMode: 'shared' }, SESSION)
    expect(r.status).toBe(200)
    expect(h.writeAgentAuthMode).toHaveBeenCalledWith(MAIN_AGENT_ID, 'shared')
    expect(h.deleteSecret).toHaveBeenCalledWith(`agent-${MAIN_AGENT_ID}-api-key`)
    expect(h.setSecret).not.toHaveBeenCalled()
  })
  it('api with a new key: probed, stored, the mode written, the key not deleted', async () => {
    const r = await put({ authMode: 'api', apiKey: 'fake-new-key-0123456789abcdef' }, SESSION)
    expect(r.status).toBe(200)
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.setSecret).toHaveBeenCalledWith(`agent-${MAIN_AGENT_ID}-api-key`, expect.any(String), 'fake-new-key-0123456789abcdef')
    expect(h.writeAgentAuthMode).toHaveBeenCalledWith(MAIN_AGENT_ID, 'api')
    expect(h.deleteSecret).not.toHaveBeenCalled()
    expect(JSON.stringify(r.body)).not.toContain('fake-new-key')
  })
  it('a key the API rejects: 400, nothing stored or written', async () => {
    h.probe.mockImplementationOnce(async () => 'auth-rejected' as never)
    const r = await put({ authMode: 'api', apiKey: 'fake-bad-key-0123456789abcdef' }, SESSION)
    expect(r.status).toBe(400)
    expect(r.body?.code).toBe('key-rejected')
    expect(h.setSecret).not.toHaveBeenCalled()
    expect(h.writeAgentAuthMode).not.toHaveBeenCalled()
  })
  it('an unreadable vault: 503, nothing changed', async () => {
    h.vaultThrows = true
    const r = await put({ authMode: 'shared' }, SESSION)
    expect(r.status).toBe(503)
    expect(r.body?.code).toBe('vault-unreadable')
    expect(h.writeAgentAuthMode).not.toHaveBeenCalled()
    expect(h.deleteSecret).not.toHaveBeenCalled()
  })
  it('the shared access token: 403 before anything is read or written', async () => {
    const r = await put({ authMode: 'shared' }, TOKEN)
    expect(r.status).toBe(403)
    expect(h.writeAgentAuthMode).not.toHaveBeenCalled()
    expect(h.deleteSecret).not.toHaveBeenCalled()
  })
})
