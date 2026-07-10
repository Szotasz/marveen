import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { checkBearerToken } from '../web/dashboard-auth.js'
import {
  validateFederationConfig,
  getFederationConfig,
  writeFederationConfig,
  identifyFederationCaller,
  setFederationEnabledPreservingFile,
  setFederationRoutingModePreservingFile,
  removeFederationStore,
  generatePeerInboundToken,
  isAcceptablePeerBaseUrl,
  abandonWindowMsForPeer,
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  FEDERATION_MIN_TOKEN_LENGTH,
  DEFAULT_ABANDON_WINDOW_MINUTES,
  type FederationConfig,
} from '../web/federation/config.js'

// Isolated store dir (initDatabase(':memory:') precedent: explicit override,
// never the real checkout's store/).
const TMP = mkdtempSync(join(tmpdir(), 'fed-config-test-'))
const IN_TOKEN = 'f'.repeat(64)
const OUT_TOKEN = 'e'.repeat(64)

function writeConfigFile(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  rmSync(join(TMP, '.federation-token'), { force: true })
  _setFederationStoreDirForTest(TMP)
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const validPeers = [{ id: 'arthur', baseUrl: 'https://macbook.example.ts.net', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }]

describe('validateFederationConfig (pure)', () => {
  it('accepts a minimal valid config and defaults systemId to MAIN_AGENT_ID', () => {
    const r = validateFederationConfig({ enabled: true, peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe(MAIN_AGENT_ID)
      expect(r.peers[0]).toMatchObject({ id: 'arthur', trust: 'untrusted', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN })
    }
  })

  it('parses peers for DISABLED configs too (lossless disable)', () => {
    const r = validateFederationConfig({ enabled: false, systemId: 'teodor', peers: validPeers })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.enabled).toBe(false)
      expect(r.peers).toHaveLength(1)
    }
  })

  it('is strict about enabled === true', () => {
    for (const enabled of ['true', 1, undefined]) {
      const r = validateFederationConfig({ enabled, peers: validPeers })
      if (typeof r !== 'string') expect(r.enabled).toBe(false)
      else expect.fail(`expected config, got: ${r}`)
    }
  })

  it('defaults routingMode to catalog-first when absent, round-trips a valid mode', () => {
    const def = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof def === 'string') return expect.fail(def)
    expect(def.routingMode).toBe('catalog-first')
    for (const mode of ['strong', 'catalog-first', 'advisory'] as const) {
      const r = validateFederationConfig({ enabled: true, routingMode: mode, peers: validPeers })
      if (typeof r === 'string') return expect.fail(r)
      expect(r.routingMode).toBe(mode)
    }
  })

  it('rejects an unknown routingMode (fail-closed)', () => {
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 'aggressive', peers: validPeers })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, routingMode: 5, peers: validPeers })).toBe('string')
  })

  it('allows an EMPTY outboundToken (pairing pending) but rejects a short one', () => {
    const pending = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: '' }] })
    expect(typeof pending).not.toBe('string')
    if (typeof pending !== 'string') expect(pending.peers[0].outboundToken).toBe('')
    const missing = validateFederationConfig({ enabled: true, peers: [{ id: 'arthur', baseUrl: 'https://x.example', inboundToken: IN_TOKEN }] })
    expect(typeof missing).not.toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], outboundToken: 'short' }] })).toBe('string')
  })

  it('REQUIRES a well-formed inboundToken (min length, empty-string bypass guard)', () => {
    for (const inboundToken of [undefined, '', '   ', 'short', 'x'.repeat(FEDERATION_MIN_TOKEN_LENGTH - 1)]) {
      const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], inboundToken }] })
      expect(typeof r).toBe('string')
    }
  })

  it('rejects duplicate inbound tokens (cross-peer impersonation guard)', () => {
    const r = validateFederationConfig({
      enabled: true,
      peers: [validPeers[0], { id: 'cecil', baseUrl: 'https://c.example', inboundToken: IN_TOKEN }],
    })
    expect(r).toContain('duplicate inbound token')
  })

  it('rejects peer id equal to own systemId and duplicate peer ids', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'arthur', peers: validPeers })).toContain('equals own systemId')
    expect(validateFederationConfig({ enabled: true, peers: [...validPeers, { ...validPeers[0], inboundToken: 'g'.repeat(64) }] })).toContain('duplicate peer id')
  })

  it('lowercases systemId and peer ids at validation -- case-insensitive ids, stored lowercase (L1)', () => {
    const r = validateFederationConfig({ enabled: true, systemId: 'Teodor', peers: [{ ...validPeers[0], id: 'Arthur' }] })
    expect(typeof r).not.toBe('string')
    if (typeof r !== 'string') {
      expect(r.systemId).toBe('teodor')
      expect(r.peers[0].id).toBe('arthur')
    }
  })

  it('detects id collisions ACROSS case (own-system + duplicate)', () => {
    expect(validateFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ ...validPeers[0], id: 'Teodor' }] })).toContain('equals own systemId')
    expect(validateFederationConfig({
      enabled: true, systemId: 'x',
      peers: [validPeers[0], { ...validPeers[0], id: 'ARTHUR', inboundToken: 'a'.repeat(64) }],
    })).toContain('duplicate peer id')
  })

  it('rejects unknown trust values (fail-closed forward-compat)', () => {
    expect(validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], trust: 'trusted' }] })).toContain('trust')
  })

  it('parses the per-peer shareCapabilitySummaries flag strictly and ROUND-TRIPS it (L5)', () => {
    const on = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: true }] })
    if (typeof on === 'string') expect.fail(on)
    // Must survive the validator: every mutating endpoint persists the
    // validator's output, so a dropped field would silently revoke the grant.
    expect(on.peers[0].shareCapabilitySummaries).toBe(true)
    const off = validateFederationConfig({ enabled: true, peers: validPeers })
    if (typeof off === 'string') expect.fail(off)
    expect(off.peers[0].shareCapabilitySummaries).toBeUndefined() // default: not shared
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], shareCapabilitySummaries: 'yes' }] })).toBe('string')
  })

  it('validates abandonWindowMinutes bounds', () => {
    const ok = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: 1440 }] })
    if (typeof ok !== 'string') expect(ok.peers[0].abandonWindowMinutes).toBe(1440)
    else expect.fail(ok)
    for (const w of [0, 4, 999999, 1.5, '60']) {
      expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], abandonWindowMinutes: w }] })).toBe('string')
    }
  })

  it('rejects invalid ids and baseUrls; strips trailing slashes', () => {
    expect(typeof validateFederationConfig({ enabled: true, systemId: 'bad name', peers: [] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], id: 'a/b' }] })).toBe('string')
    expect(typeof validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'http://evil.example.com' }] })).toBe('string')
    const r = validateFederationConfig({ enabled: true, peers: [{ ...validPeers[0], baseUrl: 'https://x.example//' }] })
    if (typeof r !== 'string') expect(r.peers[0].baseUrl).toBe('https://x.example')
  })
})

describe('isAcceptablePeerBaseUrl / abandonWindowMsForPeer / token mint', () => {
  it('requires https except on loopback', () => {
    expect(isAcceptablePeerBaseUrl('https://any.example')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://127.0.0.1:3432')).toBe(true)
    expect(isAcceptablePeerBaseUrl('http://192.168.1.10:3420')).toBe(false)
  })

  it('abandon window defaults to 60 min and honours per-peer override', () => {
    const cfg: FederationConfig = {
      enabled: true, systemId: 'a',
      peers: [
        { id: 'fast', baseUrl: 'https://x', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' },
        { id: 'laptop', baseUrl: 'https://y', outboundToken: OUT_TOKEN, inboundToken: 'g'.repeat(64), trust: 'untrusted', abandonWindowMinutes: 1440 },
      ],
    }
    expect(abandonWindowMsForPeer(cfg, 'fast')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'laptop')).toBe(1440 * 60_000)
    expect(abandonWindowMsForPeer(cfg, 'unknown')).toBe(DEFAULT_ABANDON_WINDOW_MINUTES * 60_000)
    // Case-insensitive: a pre-normalization stored row may carry 'Laptop/x'.
    expect(abandonWindowMsForPeer(cfg, 'Laptop')).toBe(1440 * 60_000)
  })

  it('mints 64-hex tokens', () => {
    expect(generatePeerInboundToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(generatePeerInboundToken()).not.toBe(generatePeerInboundToken())
  })
})

describe('fail-closed store reads', () => {
  it('missing file / garbage JSON / one invalid peer -> disabled with no peers', () => {
    expect(getFederationConfig().enabled).toBe(false)
    writeFileSync(join(TMP, 'federation.json'), '{not json')
    reloadFederationForTest()
    expect(getFederationConfig().enabled).toBe(false)
    writeConfigFile({ enabled: true, peers: [validPeers[0], { id: 'bad peer!', baseUrl: 'https://x.example', inboundToken: 'g'.repeat(64) }] })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(0)
  })

  it('valid enabled file -> enabled with parsed peers', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.peers.map((p) => p.id)).toEqual(['arthur'])
  })
})

describe('identifyFederationCaller', () => {
  it('identifies the matching peer and only while enabled', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBe('arthur')
    expect(identifyFederationCaller(`Bearer ${'0'.repeat(64)}`, checkBearerToken)).toBeNull()
    expect(identifyFederationCaller(undefined, checkBearerToken)).toBeNull()
    writeConfigFile({ enabled: false, peers: validPeers })
    // Disabled: no auth work at all -- a disabled peer presents as plain 401.
    expect(identifyFederationCaller(`Bearer ${IN_TOKEN}`, checkBearerToken)).toBeNull()
  })

  it('never authenticates against an empty/short stored token', () => {
    // Hand-edited file with a short inbound token fail-closes the WHOLE
    // config, so the caller loop never even sees it.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: '' }] })
    expect(identifyFederationCaller('Bearer  ', checkBearerToken)).toBeNull()
  })
})

describe('lossless enable/disable + removal', () => {
  it('setFederationEnabledPreservingFile flips the flag and keeps peers -- even INVALID ones stay in the file', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    expect(setFederationEnabledPreservingFile(false)).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.peers).toHaveLength(1) // lossless: peers survive the flip
    expect(setFederationEnabledPreservingFile(true)).toBe(true)
    expect(getFederationConfig().enabled).toBe(true)

    // The critical data-loss edge: an INVALID stored peer fail-closes the
    // VIEW (peers: []), but the flag flip must not write that emptiness back.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(getFederationConfig().peers).toHaveLength(0) // view is fail-closed
    expect(setFederationEnabledPreservingFile(false)).toBe(true)
    const raw = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(raw.peers).toHaveLength(1) // the file still has the peer
    expect(raw.enabled).toBe(false)
  })

  it('returns false on unreadable garbage (nothing to flip; validator already fail-closes)', () => {
    writeFileSync(join(TMP, 'federation.json'), '{oops')
    reloadFederationForTest()
    expect(setFederationEnabledPreservingFile(false)).toBe(false)
  })

  it('setFederationRoutingModePreservingFile sets the mode, keeps peers + enabled, survives an invalid stored peer', () => {
    writeConfigFile({ enabled: true, routingMode: 'catalog-first', peers: validPeers })
    expect(setFederationRoutingModePreservingFile('strong')).toBe(true)
    const cfg = getFederationConfig()
    expect(cfg.routingMode).toBe('strong')
    expect(cfg.enabled).toBe(true) // untouched
    expect(cfg.peers).toHaveLength(1) // lossless
    // Invalid stored peer -> the VIEW fail-closes, but the file (incl. the peer) is kept.
    writeConfigFile({ enabled: true, peers: [{ ...validPeers[0], inboundToken: 'short' }] })
    expect(setFederationRoutingModePreservingFile('advisory')).toBe(true)
    const raw = JSON.parse(readFileSync(join(TMP, 'federation.json'), 'utf-8'))
    expect(raw.routingMode).toBe('advisory')
    expect(raw.peers).toHaveLength(1)
  })

  it('removeFederationStore deletes config + legacy token file and is idempotent', () => {
    writeConfigFile({ enabled: true, peers: validPeers })
    writeFileSync(join(TMP, '.federation-token'), 'legacy'.repeat(11))
    removeFederationStore()
    expect(existsSync(join(TMP, 'federation.json'))).toBe(false)
    expect(existsSync(join(TMP, '.federation-token'))).toBe(false)
    expect(getFederationConfig().enabled).toBe(false)
    removeFederationStore() // idempotent
  })

  it('writeFederationConfig refreshes the cache synchronously', () => {
    writeFederationConfig({ enabled: true, systemId: 'teodor', peers: [{ id: 'arthur', baseUrl: 'https://x.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' }] })
    expect(getFederationConfig().enabled).toBe(true)
    expect(getFederationConfig().peers[0].id).toBe('arthur')
  })
})
