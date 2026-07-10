import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OWNER_NAME } from '../config.js'
import { _setFederationStoreDirForTest, reloadFederationForTest } from '../web/federation/config.js'
import {
  roleSpecificHead,
  readSummarySource,
  summarySourceHash,
  containsPrivateData,
  pickStaleAgents,
  failureBackoffMs,
  generateOneSummary,
  pruneCapabilityCache,
  getCapabilitySummary,
  mainAgentCapabilitySummary,
  readCapabilityCache,
  writeCapabilityCache,
  purgeCapabilityCache,
  buildSummaryPrompt,
  CAPABILITY_CACHE_FILENAME,
  CAPABILITY_SUMMARY_MAX_CHARS,
  CAPABILITY_FAILURE_BACKOFF_BASE_MS,
  CAPABILITY_FAILURE_BACKOFF_MAX_MS,
  _setCapabilityStoreDirForTest,
  type CapabilityCache,
} from '../web/federation/capabilities.js'

const TMP = mkdtempSync(join(tmpdir(), 'fed-capabilities-test-'))
const NOW = 1_750_000_000_000
const IN_TOKEN = 'i'.repeat(64)
const OUT_TOKEN = 'o'.repeat(64)

beforeEach(() => {
  rmSync(join(TMP, CAPABILITY_CACHE_FILENAME), { force: true })
  rmSync(join(TMP, 'federation.json'), { force: true })
  rmSync(join(TMP, '.dashboard-token'), { force: true })
  _setCapabilityStoreDirForTest(TMP)
  _setFederationStoreDirForTest(TMP)
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('roleSpecificHead', () => {
  it('cuts before the fleet-boilerplate heading (both accent variants), whole file as fallback', () => {
    const doc = '# Role\nSpecialist for X.\n\n## Memoria rendszer\nBOILERPLATE with private stuff\n'
    expect(roleSpecificHead(doc)).not.toContain('BOILERPLATE')
    expect(roleSpecificHead(doc)).toContain('Specialist for X.')
    const accented = '# Role\nY.\n\n## Memória rendszer\nBOILERPLATE\n'
    expect(roleSpecificHead(accented)).not.toContain('BOILERPLATE')
    expect(roleSpecificHead('# Custom persona\nno headings')).toBe('# Custom persona\nno headings')
  })
})

describe('containsPrivateData (deterministic outbound scrub)', () => {
  it('catches the owner name case-insensitively, including inflected forms', () => {
    expect(containsPrivateData(`This agent helps ${OWNER_NAME} with tasks`)).toBe('owner name')
    expect(containsPrivateData(`Segit ${OWNER_NAME.toUpperCase()}nak mindenben`)).toBe('owner name')
  })

  it('catches internal system literals and the token path', () => {
    expect(containsPrivateData('Uses the Alkotmany MCP for legal texts')).toBe('internal system name')
    expect(containsPrivateData('reads store/.dashboard-token for auth')).toBe('token path')
  })

  it('catches configured peer tokens and the dashboard token value', () => {
    writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
      enabled: true, systemId: 'localsys',
      peers: [{ id: 'teodor', baseUrl: 'https://mini.example', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }],
    }))
    reloadFederationForTest()
    writeFileSync(join(TMP, '.dashboard-token'), 'd'.repeat(64))
    expect(containsPrivateData(`summary leaking ${IN_TOKEN} here`)).toBe('peer token')
    expect(containsPrivateData(`summary leaking ${'d'.repeat(64)}`)).toBe('dashboard token')
  })

  it('skips EMPTY constants (a fresh install without OWNER_DRIVE_FOLDER must not reject everything)', () => {
    // Default test env: OWNER_DRIVE_FOLDER and ALLOWED_CHAT_ID are '' -- a
    // clean capability sentence must pass.
    expect(containsPrivateData('Video editing, subtitling and rendering workflows.')).toBeNull()
  })
})

describe('pickStaleAgents (pure)', () => {
  const hash = 'h1'
  const cands = [{ name: 'a', sourceHash: hash }, { name: 'b', sourceHash: hash }]

  it('picks missing entries; skips fresh ones; honours the limit', () => {
    const cache: CapabilityCache = { a: { summary: 's', sourceHash: hash, generatedAt: NOW } }
    expect(pickStaleAgents(cands, cache, NOW, 5)).toEqual(['b'])
    expect(pickStaleAgents(cands, {}, NOW, 1)).toHaveLength(1)
  })

  it('skips privacy-rejected entries until the sources change', () => {
    const cache: CapabilityCache = { a: { sourceHash: hash, rejected: true, lastAttemptAt: NOW - 10 } }
    expect(pickStaleAgents([{ name: 'a', sourceHash: hash }], cache, NOW, 5)).toEqual([])
    // Source change -> fresh attempt.
    expect(pickStaleAgents([{ name: 'a', sourceHash: 'h2' }], cache, NOW, 5)).toEqual(['a'])
  })

  it('respects the exponential failure backoff and resets it on a hash change', () => {
    const twoFails: CapabilityCache = { a: { sourceHash: hash, consecutiveFailures: 2, lastAttemptAt: NOW } }
    expect(failureBackoffMs(1)).toBe(CAPABILITY_FAILURE_BACKOFF_BASE_MS)
    expect(failureBackoffMs(2)).toBe(CAPABILITY_FAILURE_BACKOFF_BASE_MS * 2)
    expect(failureBackoffMs(20)).toBe(CAPABILITY_FAILURE_BACKOFF_MAX_MS)
    expect(pickStaleAgents([{ name: 'a', sourceHash: hash }], twoFails, NOW + failureBackoffMs(2) - 1, 5)).toEqual([])
    expect(pickStaleAgents([{ name: 'a', sourceHash: hash }], twoFails, NOW + failureBackoffMs(2) + 1, 5)).toEqual(['a'])
    expect(pickStaleAgents([{ name: 'a', sourceHash: 'h2' }], twoFails, NOW + 1, 5)).toEqual(['a'])
  })

  it('prefers the least-recently-attempted eligible agent', () => {
    const cache: CapabilityCache = {
      a: { sourceHash: 'old', lastAttemptAt: NOW - 1000 },
      b: { sourceHash: 'old', lastAttemptAt: NOW - 5000 },
    }
    expect(pickStaleAgents(cands, cache, NOW, 1)).toEqual(['b'])
  })
})

describe('generateOneSummary', () => {
  it('caches a clean summary single-lined and capped; getCapabilitySummary reports it fresh', async () => {
    const out = await generateOneSummary('ghost-agent', 'en', async () => ({
      text: 'Does video\nediting.\n' + 'x'.repeat(1000),
    }))
    expect(out).toBe('ok')
    const entry = readCapabilityCache()['ghost-agent']
    expect(entry.summary).toBeTruthy()
    expect(entry.summary).not.toContain('\n')
    expect(entry.summary!.length).toBeLessThanOrEqual(CAPABILITY_SUMMARY_MAX_CHARS)
    // Freshness: the stored hash matches the current (empty-ish) sources.
    expect(getCapabilitySummary('ghost-agent', 'en')).toMatchObject({ fresh: true })
    // Cache file is real + JSON.
    expect(existsSync(join(TMP, CAPABILITY_CACHE_FILENAME))).toBe(true)
    expect(() => JSON.parse(readFileSync(join(TMP, CAPABILITY_CACHE_FILENAME), 'utf-8'))).not.toThrow()
  })

  it('REJECTS a summary that leaks private data and does not retry the same sources', async () => {
    const out = await generateOneSummary('ghost-agent', 'en', async () => ({
      text: `Helps ${OWNER_NAME} with the alkotmany system`,
    }))
    expect(out).toBe('rejected')
    const entry = readCapabilityCache()['ghost-agent']
    expect(entry.summary).toBeUndefined()
    expect(entry.rejected).toBe(true)
    // The picker must NOT re-pick it for the unchanged hash.
    expect(pickStaleAgents([{ name: 'ghost-agent', sourceHash: entry.sourceHash }], readCapabilityCache(), Date.now(), 5)).toEqual([])
    expect(getCapabilitySummary('ghost-agent', 'en')).toMatchObject({ summary: null })
  })

  it('records failures (null text OR error -- covers the timeout-as-error path) with a growing counter', async () => {
    await generateOneSummary('ghost-agent', 'en', async () => ({ text: null }))
    await generateOneSummary('ghost-agent', 'en', async () => ({ text: 'apology text', error: 'timeout after 5min' }))
    const entry = readCapabilityCache()['ghost-agent']
    expect(entry.summary).toBeUndefined()
    expect(entry.consecutiveFailures).toBe(2)
    // A throwing runner is a failure too, never an unhandled rejection.
    await expect(generateOneSummary('ghost-agent', 'en', async () => { throw new Error('boom') })).resolves.toBe('failed')
  })
})

describe('cache maintenance', () => {
  it('prunes entries for removed agents and purge deletes the file idempotently', () => {
    writeCapabilityCache({
      keep: { summary: 's', sourceHash: 'h' },
      gone: { summary: 's', sourceHash: 'h' },
    })
    pruneCapabilityCache(new Set(['keep']))
    expect(Object.keys(readCapabilityCache())).toEqual(['keep'])
    purgeCapabilityCache()
    expect(existsSync(join(TMP, CAPABILITY_CACHE_FILENAME))).toBe(false)
    expect(readCapabilityCache()).toEqual({})
    expect(() => purgeCapabilityCache()).not.toThrow() // idempotent
  })
})

describe('prompt + fixed main summary', () => {
  it('the generation prompt carries the privacy rules and the role head, and the main summary is template-only', () => {
    const src = readSummarySource('ghost-agent')
    const prompt = buildSummaryPrompt('ghost-agent', src, 'hu')
    expect(prompt).toContain('NO client, system, project or product proper nouns')
    expect(prompt).toContain('NEVER include personal data')
    expect(prompt).toContain('Írj magyarul.')
    expect(mainAgentCapabilitySummary('hu')).toContain('koordinátor')
    expect(mainAgentCapabilitySummary('en')).toContain('coordinator')
    // The fixed summaries themselves must pass the outbound scrub.
    expect(containsPrivateData(mainAgentCapabilitySummary('hu'))).toBeNull()
    expect(containsPrivateData(mainAgentCapabilitySummary('en'))).toBeNull()
  })

  it('the source hash depends on generation language: a DASHBOARD_LANG flip invalidates the summary (L5 review)', async () => {
    const src = readSummarySource('ghost-agent')
    expect(summarySourceHash(src, 'hu')).not.toBe(summarySourceHash(src, 'en'))
    // A summary generated in 'en' reports stale (fresh:false) once the language is 'hu'.
    await generateOneSummary('ghost-agent', 'en', async () => ({ text: 'Video editing capabilities.' }))
    expect(getCapabilitySummary('ghost-agent', 'en')).toMatchObject({ fresh: true })
    expect(getCapabilitySummary('ghost-agent', 'hu')).toMatchObject({ fresh: false })
  })
})
