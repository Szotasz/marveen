import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// #2358: GET /api/agents and GET /api/agents/:name carry runAsUser, so a tool
// acting for the agent (console, launcher, monitor) reads it from the
// authenticated API instead of parsing agent-config.json itself. The value is
// readAgentRunAsUser's -- the same one the spawn uses -- and null when unset.
//
// agent-config.ts reads its own (unmocked) agentDir internally, so the
// sandboxed readers below call the module's real resolveRunAsUser on the
// sandboxed file: the parsing/validation is the real one, only the dir moves.
let SANDBOX = ''
const NAMES = ['withuser', 'nouser', 'baduser']

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  const dirOf = (name: string) => join(SANDBOX, 'agents', name)
  return {
    ...actual,
    agentDir: dirOf,
    listAgentNames: () => NAMES,
    isKnownAgent: (name: string) => NAMES.includes(name),
    readAgentRunAsUser: (name: string) =>
      actual.resolveRunAsUser(actual.readFileOr(join(dirOf(name), 'agent-config.json'), '{}')),
  }
})
vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return { ...actual, capturePane: () => null, sharedEnvAuthKeysCopiedTo: () => [] }
})
vi.mock('../web/vault.js', async (orig) => {
  const actual = await orig<typeof import('../web/vault.js')>()
  return { ...actual, getSecret: () => null }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

function writeConfig(name: string, config: Record<string, unknown>) {
  mkdirSync(join(SANDBOX, 'agents', name), { recursive: true })
  writeFileSync(join(SANDBOX, 'agents', name, 'agent-config.json'), JSON.stringify(config))
}

async function get(path: string): Promise<unknown> {
  let status = 0
  let body = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk) body = chunk.toString() },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} }, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  expect(status).toBe(200)
  return JSON.parse(body)
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'runasuser-sum-'))
  writeConfig('withuser', { runAsUser: 'marveen-withuser' })
  writeConfig('nouser', { model: 'sonnet' })
  // Fails RUN_AS_USER_ALLOWED: the API must not echo what the spawn would refuse.
  writeConfig('baduser', { runAsUser: 'root; rm -rf /' })
})
afterEach(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('runAsUser in the agent API (#2358)', () => {
  it('GET /api/agents: each row carries its own agent\'s runAsUser, null when unset or invalid', async () => {
    const rows = await get('/api/agents') as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.name, r.runAsUser])).toEqual([
      ['withuser', 'marveen-withuser'],
      ['nouser', null],
      ['baduser', null],
    ])
    // null, not a missing key: a client can tell "not configured" from an old server.
    for (const r of rows) expect(Object.prototype.hasOwnProperty.call(r, 'runAsUser')).toBe(true)
  })

  it('GET /api/agents/:name: the detail carries it too', async () => {
    const withUser = await get('/api/agents/withuser') as Record<string, unknown>
    expect(withUser.runAsUser).toBe('marveen-withuser')
    const noUser = await get('/api/agents/nouser') as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(noUser, 'runAsUser')).toBe(true)
    expect(noUser.runAsUser).toBeNull()
  })
})
