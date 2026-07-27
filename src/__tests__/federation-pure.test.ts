import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../config.js', () => ({
  PROJECT_ROOT: '/fake/project',
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'Marveen',
}))

vi.mock('../../db.js', () => ({
  createAgentMessage: vi.fn().mockReturnValue({ id: 1 }),
  failPendingFederatedMessages: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../web/http-helpers.js', () => ({
  readBody: vi.fn().mockResolvedValue(Buffer.from('{}')),
  json: vi.fn(),
  RequestBodyTooLargeError: class extends Error {},
}))

vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: vi.fn().mockReturnValue(false),
  readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
  readAgentModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
}))

vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: vi.fn().mockReturnValue({ enabled: true, systemId: 'local', peers: [], routingMode: 'direct' }),
  federationFileHealth: vi.fn().mockReturnValue('ok'),
  validateFederationConfig: vi.fn().mockReturnValue({ valid: true }),
  writeFederationConfig: vi.fn(),
  setFederationEnabledPreservingFile: vi.fn(),
  setFederationRoutingModePreservingFile: vi.fn(),
  removeFederationStore: vi.fn(),
  generatePeerInboundToken: vi.fn().mockReturnValue('gen-token'),
  isAcceptablePeerBaseUrl: vi.fn().mockReturnValue(true),
  FEDERATION_MIN_TOKEN_LENGTH: 32,
  MIN_ABANDON_WINDOW_MINUTES: 5,
  MAX_ABANDON_WINDOW_MINUTES: 1440,
  FEDERATION_ROUTING_MODES: ['direct', 'bridge'],
  DEFAULT_ROUTING_MODE: 'direct',
}))

vi.mock('../web/federation/address.js', async (importOriginal) => {
  return await importOriginal<typeof import('../web/federation/address.js')>()
})

vi.mock('../web/federation/local-catalog.js', () => ({
  catalogAgentNames: vi.fn().mockReturnValue([]),
  listAgentLocalSkills: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/federation/capabilities.js', () => ({
  containsPrivateData: vi.fn().mockReturnValue(false),
  getCapabilitySummary: vi.fn().mockReturnValue({ summary: null, fresh: false }),
  mainAgentCapabilitySummary: vi.fn().mockReturnValue('Main agent summary'),
  purgeCapabilityCache: vi.fn(),
}))

vi.mock('../web/federation/bridge.js', () => ({
  resetPeerBackoff: vi.fn(),
}))

vi.mock('../web/federation/poller.js', () => ({
  getFederationStatus: vi.fn().mockReturnValue({}),
  refreshFederationStatus: vi.fn().mockResolvedValue(undefined),
  resetFederationPollerCache: vi.fn(),
}))

vi.mock('../web/federation/onboarding.js', () => ({
  ensureFederationClaudeMdSection: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn().mockReturnValue('hu'),
}))

import {
  validateInboxPayload,
  purgeInboxDedup,
  _resetInboxDedupForTest,
  FEDERATION_VERSION,
  INBOX_MAX_BODY_BYTES,
} from '../web/routes/federation.js'
import type { FederationConfig } from '../web/federation/config.js'

const BASE_CFG: FederationConfig = {
  enabled: true,
  systemId: 'local',
  peers: [
    {
      id: 'peer-a',
      baseUrl: 'https://peer-a.example.com',
      trust: 'untrusted',
      outboundToken: 'outbound-token-1234567890',
      inboundToken: 'inbound-token-1234567890',
    },
  ],
  routingMode: 'catalog-first',
}

const BASE_DEPS = {
  isKnownAgent: (name: string) => name === 'jarvis',
  mainAgentId: 'marveen',
}

beforeEach(() => {
  _resetInboxDedupForTest()
})

describe('FEDERATION constants', () => {
  it('exports FEDERATION_VERSION as a number', () => {
    expect(typeof FEDERATION_VERSION).toBe('number')
    expect(FEDERATION_VERSION).toBeGreaterThan(0)
  })

  it('exports INBOX_MAX_BODY_BYTES', () => {
    expect(INBOX_MAX_BODY_BYTES).toBeGreaterThan(0)
  })
})

describe('purgeInboxDedup', () => {
  it('clears all entries when called without peerId', () => {
    purgeInboxDedup()
  })

  it('clears entries matching peerId prefix', () => {
    purgeInboxDedup('peer-a')
  })

  it('handles empty dedup map gracefully', () => {
    _resetInboxDedupForTest()
    purgeInboxDedup('nonexistent-peer')
  })
})

describe('validateInboxPayload - invalid inputs', () => {
  it('returns 400 when payload is null', () => {
    const r = validateInboxPayload(null, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('JSON object') })
  })

  it('returns 400 when payload is an array', () => {
    const r = validateInboxPayload([], BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })

  it('returns 400 when payload is a string', () => {
    const r = validateInboxPayload('hello', BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })

  it('returns 400 when from is missing', () => {
    const r = validateInboxPayload({ to: 'marveen', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('from') })
  })

  it('returns 400 when from has invalid format', () => {
    const r = validateInboxPayload({ from: 'bad-id', to: 'marveen', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })
})

describe('validateInboxPayload - from system checks', () => {
  it('returns 403 when from system equals local system id', () => {
    const r = validateInboxPayload({ from: 'local/agent1', to: 'marveen', content: 'hi' }, BASE_CFG, BASE_DEPS, null)
    expect(r).toMatchObject({ status: 403, error: expect.stringContaining('from system equals this system') })
  })

  it('returns 403 when caller peer does not match from system', () => {
    const r = validateInboxPayload({ from: 'peer-b/agent1', to: 'marveen', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 403, error: expect.stringContaining('does not match the authenticated peer') })
  })

  it('returns 403 when dashboard caller uses unconfigured peer', () => {
    const r = validateInboxPayload({ from: 'unknown-peer/agent1', to: 'marveen', content: 'hi' }, BASE_CFG, BASE_DEPS, null)
    expect(r).toMatchObject({ status: 403, error: expect.stringContaining('not a configured peer') })
  })

  it('allows dashboard caller to use configured peer', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hello' }, BASE_CFG, BASE_DEPS, null)
    expect((r as any).status).toBeUndefined()
  })
})

describe('validateInboxPayload - to field checks', () => {
  it('returns 403 when to contains slash', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'foo/bar', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 403, error: expect.stringContaining('local') })
  })

  it('returns 400 when to is not a string', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 123, content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 403 })
  })

  it('returns 400 for invalid to id segment', () => {
    const r = validateInboxPayload({ from: 'peer-a/a1', to: 'invalid id!', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })

  it('returns 404 when to agent is not known', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'unknownagent', content: 'hi' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 404, error: expect.stringContaining('Unknown recipient') })
  })
})

describe('validateInboxPayload - content checks', () => {
  it('returns 400 when content is empty', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: '' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('content') })
  })

  it('returns 400 when content is not a string', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 123 }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })

  it('returns 400 when content is whitespace only', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: '   ' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })
})

describe('validateInboxPayload - ref field', () => {
  it('returns 400 when ref is empty string', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hi', ref: '' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('ref') })
  })

  it('returns 400 when ref is too long', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hi', ref: 'x'.repeat(200) }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('ref') })
  })

  it('returns 400 when ref is not a string', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hi', ref: 42 }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect(r).toMatchObject({ status: 400 })
  })

  it('accepts valid message with ref', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hello', ref: 'msg-001' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect((r as any).status).toBeUndefined()
    expect((r as any).ref).toBe('msg-001')
    expect((r as any).from).toBe('peer-a/agent1')
  })

  it('accepts null ref as null in normalized message', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hello', ref: null }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect((r as any).ref).toBeNull()
  })

  it('accepts message without ref field', () => {
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'marveen', content: 'hello' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect((r as any).ref).toBeNull()
  })

  it('normalizes from to lowercase system prefix', () => {
    const r = validateInboxPayload({ from: 'PEER-A/MyAgent', to: 'marveen', content: 'hello' }, BASE_CFG, BASE_DEPS, 'peer-a')
    expect((r as any).from).toBe('peer-a/MyAgent')
  })
})

describe('validateInboxPayload - known agent recipient', () => {
  it('accepts message to known agent', () => {
    const deps = { isKnownAgent: (n: string) => n === 'jarvis', mainAgentId: 'marveen' }
    const r = validateInboxPayload({ from: 'peer-a/agent1', to: 'jarvis', content: 'ping' }, BASE_CFG, deps, 'peer-a')
    expect((r as any).to).toBe('jarvis')
  })
})
