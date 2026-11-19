/**
 * ACCESSMODE1101: every dashboard write of a channel plugin's access.json (and of
 * the invites.json next to it) keeps the file at 0600.
 *
 * The official plugins create access.json 0600 (the telegram server writes its tmp
 * file with { mode: 0o600 } and renames it), and the routes that write the .env
 * beside it already pass { mode: 0o600 }. The access.json rewrites went through
 * atomicWriteFileSync WITHOUT a mode, so the rename put a fresh file in place at the
 * process umask: one pairing approve or allowlist edit left the allowlist and the
 * pending pairing codes (and, for invites.json, the invite tokens) readable by every
 * local user. Everything runs in a temp dir.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'access-mode-'))
const AGENTS = join(ROOT, 'agents')
const NAME = 'modetest'

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(AGENTS, name),
    readAgentChannelProvider: () => 'slack',
  }
})

vi.mock('../db.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db.js')>()
  return {
    ...orig,
    listPendingChannelRequests: () => [{ id: 7, agent: NAME, channel_id: 'C123', channel_name: 'general', user_id: 'U1', status: 'pending' }],
    updateChannelRequestStatus: () => true,
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const ORIGINAL = JSON.stringify({
  dmPolicy: 'allowlist',
  allowFrom: ['111', '222'],
  groups: { '-100': { requireMention: true, allowFrom: [] } },
  pending: { abc123: { senderId: '333', chatId: '333', createdAt: 1, expiresAt: 9e15 } },
}, null, 2)

function stateDir(provider: string): string {
  return join(AGENTS, NAME, '.claude', 'channels', provider)
}

function modeOf(file: string): number {
  return statSync(file).mode & 0o777
}

function fakeCtx(method: string, path: string, body: unknown) {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const raw = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    headers: {},
    on(ev: string, cb: (x?: Buffer) => void) { if (ev === 'data') cb(raw); if (ev === 'end') cb(); return req },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

async function call(method: string, path: string, body?: unknown) {
  const { ctx, out } = fakeCtx(method, path, body)
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return out
}

interface Route {
  label: string
  provider: string
  method: string
  path: string
  body?: unknown
  // true when the route creates access.json if it is missing (pairing approve answers 404 instead)
  createsWhenMissing: boolean
}

const ROUTES: Route[] = [
  { label: 'pairing approve', provider: 'telegram', method: 'POST', path: `/api/agents/${NAME}/channels/telegram/approve`, body: { code: 'abc123' }, createsWhenMissing: false },
  { label: 'allowlist user remove', provider: 'telegram', method: 'DELETE', path: `/api/agents/${NAME}/channels/telegram/allowed/user/111`, createsWhenMissing: true },
  { label: 'allowlist group remove', provider: 'telegram', method: 'DELETE', path: `/api/agents/${NAME}/channels/telegram/allowed/group/-100`, createsWhenMissing: true },
  { label: 'Slack channel-request approve', provider: 'slack', method: 'POST', path: `/api/agents/${NAME}/channel-requests/7/approve`, body: {}, createsWhenMissing: true },
  { label: 'invite create', provider: 'slack', method: 'POST', path: `/api/agents/${NAME}/channels/slack/invites`, body: {}, createsWhenMissing: true },
]

beforeEach(() => {
  rmSync(join(AGENTS, NAME), { recursive: true, force: true })
  mkdirSync(stateDir('telegram'), { recursive: true })
  mkdirSync(stateDir('slack'), { recursive: true })
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe.each(ROUTES)('$label', (route) => {
  it('an existing 0600 access.json stays 0600 after the rewrite', async () => {
    const file = join(stateDir(route.provider), 'access.json')
    writeFileSync(file, ORIGINAL)
    chmodSync(file, 0o600)

    const out = await call(route.method, route.path, route.body)

    expect(out.status).toBe(200)
    expect(readFileSync(file, 'utf-8')).not.toBe(ORIGINAL)
    expect(modeOf(file)).toBe(0o600)
  })

  it.runIf(route.createsWhenMissing)('a newly created access.json is 0600', async () => {
    const file = join(stateDir(route.provider), 'access.json')
    const out = await call(route.method, route.path, route.body)
    expect(out.status).toBe(200)
    expect(existsSync(file)).toBe(true)
    expect(modeOf(file)).toBe(0o600)
  })
})

describe('invite create', () => {
  it('writes invites.json at 0600 too', async () => {
    const out = await call('POST', `/api/agents/${NAME}/channels/slack/invites`, {})
    expect(out.status).toBe(200)
    expect(modeOf(join(stateDir('slack'), 'invites.json'))).toBe(0o600)
  })
})

// The channel-setup writes (Google Chat, and the token + access.json the connect
// route seeds) are not driven above; pin every access.json write in the source so
// a new or edited writer cannot silently drop the mode again.
describe('source: every access.json write passes an explicit 0600', () => {
  const HEAD = 'atomicWriteFileSync('

  // Each atomicWriteFileSync(...) call, string-literal aware so a paren inside a string cannot end it early.
  function calls(src: string): string[] {
    const out: string[] = []
    let i = src.indexOf(HEAD)
    while (i !== -1) {
      let depth = 0
      let quote: string | null = null
      let j = i + HEAD.length - 1
      for (; j < src.length; j++) {
        const ch = src[j]
        if (quote) {
          if (ch === '\\') { j++; continue }
          if (ch === quote) quote = null
          continue
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
        if (ch === '(') depth++
        else if (ch === ')') { depth--; if (depth === 0) break }
      }
      out.push(src.slice(i, j + 1))
      i = src.indexOf(HEAD, j)
    }
    return out
  }

  // The call's first argument (the target path), up to the first top-level comma.
  function firstArg(call: string): string {
    let depth = 0
    let quote: string | null = null
    for (let k = HEAD.length; k < call.length; k++) {
      const ch = call[k]
      if (quote) {
        if (ch === '\\') { k++; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') { if (depth === 0) return call.slice(HEAD.length, k); depth-- }
      else if (ch === ',' && depth === 0) return call.slice(HEAD.length, k)
    }
    return call.slice(HEAD.length)
  }

  it.each([
    ['src/web/routes/agents.ts', (c: string) => /access\.json|accessPath/.test(firstArg(c)), 5],
    ['src/web/channel-invites.ts', () => true, 2],
  ] as const)('%s', (rel, isChannelStateWrite, expected) => {
    const src = readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
    const writes = calls(src).filter(isChannelStateWrite)
    expect(writes.length).toBeGreaterThanOrEqual(expected)
    for (const w of writes) expect(w).toMatch(/\{\s*mode:\s*0o600\s*\}\)$/)
  })
})
