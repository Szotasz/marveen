import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  validateFederationConfig,
  parseAllowedAgents,
  isPeerAgentAllowed,
  type FederationConfig,
} from '../web/federation/config.js'
import { sendFederatedMessage, _resetBackoffForTest } from '../web/federation/bridge.js'
import { pollPeerManifests, getFederationStatus, resetFederationPollerCache } from '../web/federation/poller.js'
import { validateInboxPayload } from '../web/routes/federation.js'

// Per-peer agent allowlist: the owner federates with ONE agent of a peer
// system (its main agent) and the peer's other agents must neither show up
// (status / directory / UI) nor be reachable in either direction.

const TMP = mkdtempSync(join(tmpdir(), 'fed-allowlist-test-'))
const OUT_TOKEN = 'a'.repeat(64)
const IN_TOKEN = 'b'.repeat(64)
const NOW = 1_750_000_000_000

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

function enabledConfig(peerOverrides: Record<string, unknown> = {}): void {
  writeConfigFile({
    enabled: true,
    systemId: 'localsys',
    peers: [{ id: 'marveen', baseUrl: 'https://mac.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, ...peerOverrides }],
  })
}

const MANIFEST = {
  system: 'marveen', marveenVersion: '1.49.1', federationVersion: 1,
  agents: [
    { id: 'marveen', displayName: 'Marveen', model: 'm' },
    { id: 'bea', displayName: 'Sid', model: 'm' },
    { id: 'heni', displayName: 'Adminisztracio', model: 'm' },
  ],
  skills: [
    { agent: 'marveen', name: 'main-skill', description: 'x' },
    { agent: 'bea', name: 'bea-skill', description: 'y' },
  ],
}

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  reloadFederationForTest()
  resetFederationPollerCache()
  _resetBackoffForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const basePeer = { id: 'marveen', baseUrl: 'https://mac.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN }

describe('allowedAgents config parsing', () => {
  it('absent means no allowlist, and the field round-trips lowercase and deduped', () => {
    const none = validateFederationConfig({ enabled: true, systemId: 'localsys', peers: [basePeer] }) as FederationConfig
    expect(none.peers[0].allowedAgents).toBeUndefined()
    const some = validateFederationConfig({ enabled: true, systemId: 'localsys', peers: [{ ...basePeer, allowedAgents: ['Marveen', 'marveen'] }] }) as FederationConfig
    expect(some.peers[0].allowedAgents).toEqual(['marveen'])
  })

  it('fails closed on an empty list, a non-array or an invalid id', () => {
    for (const bad of [[], 'marveen', ['a/b'], [''], [42]]) {
      expect(typeof validateFederationConfig({ enabled: true, systemId: 'localsys', peers: [{ ...basePeer, allowedAgents: bad }] })).toBe('string')
    }
    expect(parseAllowedAgents(null)).toBeUndefined()
  })

  it('isPeerAgentAllowed: no list allows all, a list allows only its members (case-insensitive)', () => {
    expect(isPeerAgentAllowed({}, 'bea')).toBe(true)
    expect(isPeerAgentAllowed(undefined, 'bea')).toBe(true)
    expect(isPeerAgentAllowed({ allowedAgents: ['marveen'] }, 'Marveen')).toBe(true)
    expect(isPeerAgentAllowed({ allowedAgents: ['marveen'] }, 'bea')).toBe(false)
  })
})

describe('status view hides agents outside the allowlist', () => {
  it('without an allowlist every published agent is visible', async () => {
    enabledConfig()
    await pollPeerManifests(NOW, fetchReturning(200, MANIFEST))
    expect(getFederationStatus()[0].manifest?.agents.map((a) => a.id)).toEqual(['marveen', 'bea', 'heni'])
  })

  it('with an allowlist only the listed agents and their skills remain, and an edit applies without a re-poll', async () => {
    enabledConfig()
    await pollPeerManifests(NOW, fetchReturning(200, MANIFEST))
    enabledConfig({ allowedAgents: ['marveen'] })
    const [st] = getFederationStatus()
    expect(st.manifest?.agents.map((a) => a.id)).toEqual(['marveen'])
    expect(st.manifest?.skills.map((s) => s.agent)).toEqual(['marveen'])
  })
})

describe('outbound: the bridge refuses an agent outside the allowlist', () => {
  it('fails terminally without a network call', async () => {
    enabledConfig({ allowedAgents: ['marveen'] })
    let called = false
    const spy = (async () => { called = true; return new Response('{}', { status: 202 }) }) as typeof fetch
    const r = await sendFederatedMessage({ id: 1, from_agent: 'localsys', to_agent: 'marveen/bea', content: 'hi' }, NOW, spy)
    expect(r).toMatchObject({ kind: 'failed' })
    expect(called).toBe(false)
  })

  it('still sends to a listed agent', async () => {
    enabledConfig({ allowedAgents: ['marveen'] })
    const r = await sendFederatedMessage({ id: 2, from_agent: 'localsys', to_agent: 'marveen/marveen', content: 'hi' }, NOW, fetchReturning(202, { id: 9 }))
    expect(r.kind).not.toBe('failed')
  })
})

describe('inbound: the inbox refuses a sender outside the allowlist', () => {
  const cfg = validateFederationConfig({ enabled: true, systemId: 'localsys', peers: [{ ...basePeer, allowedAgents: ['marveen'] }] }) as FederationConfig
  const deps = { isKnownAgent: () => true, mainAgentId: 'localsys' }

  it('rejects an unlisted sender agent with 403', () => {
    const v = validateInboxPayload({ from: 'marveen/bea', to: 'localsys', content: 'hello' }, cfg, deps, 'marveen')
    expect(v).toMatchObject({ status: 403 })
  })

  it('accepts the listed sender agent', () => {
    const v = validateInboxPayload({ from: 'marveen/marveen', to: 'localsys', content: 'hello' }, cfg, deps, 'marveen')
    expect(v).toMatchObject({ from: 'marveen/marveen', to: 'localsys' })
  })
})
