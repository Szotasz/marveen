/**
 * GROMZOGATECONF1030 (c) (the owner's GO, Samu 59516, Dani 59506): a sub-agent's sender-role gate lives in
 * store/agent-sender-role-gates.json, which only the dashboard writes; the launcher and the gate read ONLY from
 * there, never from the agent's own agent-config.json (the agent can write that one). Every file here is a temp
 * file: no run touches a real store/ file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  migrateSenderRoleGates,
  readSenderRoleGates,
  senderRoleGatesPath,
  storedGateConfig,
  SENDER_ROLE_GATES_FILE,
  UNREADABLE_GATES_POLICY,
} from '../web/sender-role-gate-store.js'
import { readAgentSenderRoleGatePolicy } from '../web/agent-config.js'

const ON = { riskyTools: ['Bash'], roles: [{ channel: 'telegram', sender: '111111', role: 'owner' }] }
const TEAM = { allowTools: ['mcp__plugin_gromzo-channel_gromzo__reply'], roles: [] }

let dir: string
let gates: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'srg-store-'))
  gates = join(dir, SENDER_ROLE_GATES_FILE)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const decode = (policy: string | null): unknown =>
  policy == null ? null : JSON.parse(Buffer.from(policy, 'base64url').toString('utf-8'))

describe('the store file', () => {
  it('lives under store/ by that name', () => {
    expect(senderRoleGatesPath('/install/store')).toBe('/install/store/agent-sender-role-gates.json')
  })

  it('missing is no gate for anyone; an object is every agent\'s gate', () => {
    expect(readSenderRoleGates(gates)).toEqual({ ok: true, gates: {} })
    writeFileSync(gates, JSON.stringify({ a: ON }))
    expect(readSenderRoleGates(gates)).toEqual({ ok: true, gates: { a: ON } })
  })

  it.each([
    ['not JSON', '{"a":'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['not UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
  ])('%s is unreadable (not ok), never "no gate"', (_label, body) => {
    writeFileSync(gates, body)
    expect(readSenderRoleGates(gates)).toEqual({ ok: false })
  })

  it('storedGateConfig gives the gate helpers one agent\'s view, and none for an agent not listed', () => {
    const store = { ok: true as const, gates: { a: ON } }
    expect(storedGateConfig(store, 'a')).toEqual({ senderRoleGate: ON })
    expect(storedGateConfig(store, 'b')).toEqual({})
    expect(storedGateConfig(store, 'constructor')).toEqual({})
  })
})

describe('the launcher\'s readers read the store only', () => {
  it('the policy is the stored value, or null without one', () => {
    writeFileSync(gates, JSON.stringify({ a: ON, off: { riskyTools: [] } }))
    expect(decode(readAgentSenderRoleGatePolicy('a', gates))).toEqual(ON)
    expect(readAgentSenderRoleGatePolicy('off', gates)).toBeNull()
    expect(readAgentSenderRoleGatePolicy('nobody', gates)).toBeNull()
  })

  it('an unreadable store fails closed: a malformed policy for every agent', () => {
    writeFileSync(gates, '{"a":')
    expect(readAgentSenderRoleGatePolicy('a', gates)).toBe(UNREADABLE_GATES_POLICY)
    expect(readAgentSenderRoleGatePolicy('nobody', gates)).toBe(UNREADABLE_GATES_POLICY)
    expect(decode(UNREADABLE_GATES_POLICY)).toBe('unreadable')
  })

  it('source pin: the reader does not open agent-config.json', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-config.ts'), 'utf-8')
    for (const fn of ['readAgentSenderRoleGatePolicy']) {
      const start = src.indexOf(`export function ${fn}(`)
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n}\n', start))
      expect(body).not.toMatch(/agent-config\.json|agentDir\(|readFileOr\(/)
      expect(body).toContain('readSenderRoleGates(gatesPath)')
    }
  })
})

describe('the one-time move from agent-config.json (the dashboard\'s start)', () => {
  const configs: Record<string, unknown> = {
    a: { model: 'x', senderRoleGate: ON },
    b: { model: 'y' },
    c: { senderRoleGate: TEAM },
  }
  const read = (n: string): unknown => {
    if (n === 'broken') throw new SyntaxError('not JSON')
    return configs[n]
  }

  it('moves every gate there is, once, into a 0600 file', () => {
    expect(migrateSenderRoleGates(['a', 'b', 'c', 'broken'], read, gates)).toEqual(['a', 'c'])
    expect(JSON.parse(readFileSync(gates, 'utf-8'))).toEqual({ a: ON, c: TEAM })
    expect(statSync(gates).mode & 0o777).toBe(0o600)
  })

  it('writes {} when no agent had a gate, so the move is marked done', () => {
    expect(migrateSenderRoleGates(['b'], read, gates)).toEqual([])
    expect(JSON.parse(readFileSync(gates, 'utf-8'))).toEqual({})
  })

  it('run twice is the same file, byte for byte', () => {
    migrateSenderRoleGates(['a', 'b', 'c'], read, gates)
    const first = readFileSync(gates)
    expect(migrateSenderRoleGates(['a', 'b', 'c'], read, gates)).toBeNull()
    expect(readFileSync(gates).equals(first)).toBe(true)
  })

  it('a gate an agent writes into its own agent-config.json after the move never reaches the store', () => {
    migrateSenderRoleGates(['b'], read, gates)
    const widened = (n: string): unknown => (n === 'b' ? { senderRoleGate: { allowTools: ['*'], roles: [] } } : read(n))
    expect(migrateSenderRoleGates(['a', 'b', 'c'], widened, gates)).toBeNull()
    expect(JSON.parse(readFileSync(gates, 'utf-8'))).toEqual({})
    expect(readAgentSenderRoleGatePolicy('b', gates)).toBeNull()
  })

  it('the store wins: an agent already stored keeps the stored value', () => {
    writeFileSync(gates, JSON.stringify({ a: ON }))
    const loose = (): unknown => ({ senderRoleGate: { riskyTools: [] } })
    expect(migrateSenderRoleGates(['a'], loose, gates)).toBeNull()
    expect(decode(readAgentSenderRoleGatePolicy('a', gates))).toEqual(ON)
  })

  it('an unreadable store is never written over', () => {
    writeFileSync(gates, '{"a":')
    expect(migrateSenderRoleGates(['a', 'c'], read, gates)).toBeNull()
    expect(readFileSync(gates, 'utf-8')).toBe('{"a":')
  })

  it('leaves no temp file behind', () => {
    migrateSenderRoleGates(['a'], read, gates)
    expect(existsSync(`${gates}.tmp-${process.pid}`)).toBe(false)
  })

  it('source pin: the dashboard runs it at its start, after the database, from the agents\' agent-config.json', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
    const db = src.indexOf('  initDatabase()\n')
    const move = src.indexOf("migrateSenderRoleGates(listAgentNames(), (n) => JSON.parse(readFileOr(join(agentDir(n), 'agent-config.json'), '{}')))")
    expect(db).toBeGreaterThan(-1)
    expect(move).toBeGreaterThan(db)
  })
})

describe('the launcher says a gate in agent-config.json is ignored', () => {
  it('source pin: a warning at the agent\'s start, with no other effect', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toContain("if (agentConfigCarriesSenderRoleGate(name)) {\n    logger.warn({ name }, 'senderRoleGate in agent-config.json is ignored: the gate is read from store/agent-sender-role-gates.json only')\n  }")
  })
})
