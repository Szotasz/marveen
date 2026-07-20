import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { buildSourceInventory } from '../costops/inventory.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const DAY = 86400

function emptyConfig(overrides: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [], ...overrides }
}

function insertSource(db: import('better-sqlite3').Database, id: string, provider: string, sourceType = 'usage') {
  db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'HUF', 1, ?, ?)`)
    .run(id, id, provider, sourceType, NOW, NOW)
}

function insertRun(db: import('better-sqlite3').Database, provider: string, status: string, startedAt: number, errorCode: string | null = null) {
  db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, status, imported_count, error_code) VALUES (?, ?, ?, ?, 0, ?)`)
    .run(provider, `${provider}-costs`, startedAt, status, errorCode)
}

function insertLine(db: import('better-sqlite3').Database, sourceId: string, opts: { billedCost: number; confidence: string; actualSource: string | null; freshness: number }) {
  db.prepare(`
    INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source)
    VALUES (?, ?, ?, 'usage', ?, 'HUF', ?, ?, ?, ?, ?)
  `).run(sourceId, NOW - DAY, NOW + DAY, opts.billedCost, opts.confidence, opts.freshness, NOW, `test|${sourceId}|${Math.random()}`, opts.actualSource)
}

describe('buildSourceInventory (CostOps Phase 0, GAP-03/GAP-04)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the headline case: OpenAI with a working credential and zero usage is inactive, NOT credential_error/blocked (card 7f5a7fc9)', () => {
    const db = getDb()
    insertSource(db, 'openai-api', 'openai')
    insertRun(db, 'openai', 'ok', NOW - DAY) // the collector DID run successfully, just imported 0 lines
    const inv = buildSourceInventory(db, emptyConfig(), NOW, { credentialChecker: () => true })
    const openai = inv.find(s => s.source_id === 'openai-api')!
    expect(openai.lifecycle).toBe('inactive')
    expect(openai.blocker).toBeNull()
    expect(openai.collection_method).toBe('provider_api_collector')
    expect(openai.sync_cadence).toBe('manual') // honest -- no collector is boot-scheduled today
  })

  it('OpenAI with no credential configured is not_configured, with a concrete blocker', () => {
    const db = getDb()
    insertSource(db, 'openai-api', 'openai')
    const inv = buildSourceInventory(db, emptyConfig(), NOW, { credentialChecker: () => false })
    const openai = inv.find(s => s.source_id === 'openai-api')!
    expect(openai.lifecycle).toBe('not_configured')
    expect(openai.blocker).toMatch(/credential|Vault secret/)
  })

  it('OpenAI with a credential but a genuinely failed last sync is blocked, carrying the error code', () => {
    const db = getDb()
    insertSource(db, 'openai-api', 'openai')
    insertRun(db, 'openai', 'error', NOW - DAY, 'ETIMEDOUT')
    const inv = buildSourceInventory(db, emptyConfig(), NOW, { credentialChecker: () => true })
    const openai = inv.find(s => s.source_id === 'openai-api')!
    expect(openai.lifecycle).toBe('blocked')
    expect(openai.blocker).toBe('ETIMEDOUT')
  })

  it('a manual fixed-cost source with real spend is active, manual_actual, manual_fallback', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other', 'domain')
    insertLine(db, 'domain', { billedCost: 3000, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW })
    const inv = buildSourceInventory(db, emptyConfig(), NOW)
    const domain = inv.find(s => s.source_id === 'domain')!
    expect(domain.lifecycle).toBe('active')
    expect(domain.provenance).toBe('manual_actual')
    expect(domain.collection_method).toBe('manual_config')
    expect(domain.manual_fallback).toBe(true)
    expect(domain.operational_inclusion_rule).toBe('operational')
  })

  it('a manual source with only a $0 placeholder row is inactive, not active', () => {
    const db = getDb()
    insertSource(db, 'placeholder-saas', 'other', 'saas')
    insertLine(db, 'placeholder-saas', { billedCost: 0, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW })
    const inv = buildSourceInventory(db, emptyConfig(), NOW)
    const s = inv.find(x => x.source_id === 'placeholder-saas')!
    expect(s.lifecycle).toBe('inactive')
    expect(s.operational_inclusion_rule).toBe('no_data_yet')
  })

  it('explicit lifecycle_override in config wins regardless of activity/credential signals', () => {
    const db = getDb()
    insertSource(db, 'old-saas', 'other', 'saas')
    insertLine(db, 'old-saas', { billedCost: 5000, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW })
    const cfg = emptyConfig({ fixed_costs: [{ source_id: 'old-saas', name: 'Old SaaS', provider: 'other', source_type: 'saas', amount: 5000, lifecycle_override: 'deprecated' }] })
    const inv = buildSourceInventory(db, cfg, NOW)
    const s = inv.find(x => x.source_id === 'old-saas')!
    expect(s.lifecycle).toBe('deprecated')
  })

  it('owner defaults to operator when not configured, honors an explicit config owner otherwise', () => {
    const db = getDb()
    insertSource(db, 'domain', 'other', 'domain')
    insertSource(db, 'github-plan', 'github', 'saas')
    const cfg = emptyConfig({ fixed_costs: [{ source_id: 'domain', name: 'Domain', provider: 'other', source_type: 'domain', amount: 0, owner: 'DevOps' }] })
    const inv = buildSourceInventory(db, cfg, NOW, { credentialChecker: () => true })
    expect(inv.find(s => s.source_id === 'domain')!.owner).toBe('DevOps')
    expect(inv.find(s => s.source_id === 'github-plan')!.owner).toBe('operator')
  })

  it('freshness classifies fresh/aging/stale/unknown by age of the last observed line', () => {
    const db = getDb()
    insertSource(db, 'fresh-src', 'other')
    insertSource(db, 'aging-src', 'other')
    insertSource(db, 'stale-src', 'other')
    insertSource(db, 'unknown-src', 'other')
    insertLine(db, 'fresh-src', { billedCost: 100, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW - DAY })
    insertLine(db, 'aging-src', { billedCost: 100, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW - 6 * DAY })
    insertLine(db, 'stale-src', { billedCost: 100, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW - 20 * DAY })
    const inv = buildSourceInventory(db, emptyConfig(), NOW)
    expect(inv.find(s => s.source_id === 'fresh-src')!.freshness).toBe('fresh')
    expect(inv.find(s => s.source_id === 'aging-src')!.freshness).toBe('aging')
    expect(inv.find(s => s.source_id === 'stale-src')!.freshness).toBe('stale')
    expect(inv.find(s => s.source_id === 'unknown-src')!.freshness).toBe('unknown')
  })

  it('a pending_permission source is excluded from operational, never a fabricated amount', () => {
    const db = getDb()
    insertSource(db, 'aws', 'aws')
    insertLine(db, 'aws', { billedCost: 0, confidence: 'pending_permission', actualSource: 'pending_permission', freshness: NOW })
    const inv = buildSourceInventory(db, emptyConfig(), NOW)
    const aws = inv.find(s => s.source_id === 'aws')!
    expect(aws.operational_inclusion_rule).toBe('pending_permission_excluded')
    expect(aws.provenance).toBe('unknown') // genuinely unobservable, never guessed
  })

  it('a Render plan-estimate line is advisory, not operational', () => {
    const db = getDb()
    insertSource(db, 'render-hosting', 'render')
    insertLine(db, 'render-hosting', { billedCost: 5000, confidence: 'provider_plan_estimate', actualSource: 'provider_api', freshness: NOW })
    const inv = buildSourceInventory(db, emptyConfig(), NOW, { credentialChecker: () => true })
    const r = inv.find(s => s.source_id === 'render-hosting')!
    expect(r.operational_inclusion_rule).toBe('advisory_plan_estimate')
  })

  it('a voided manual entry does not count toward activity/freshness/provenance', () => {
    const db = getDb()
    insertSource(db, 'ghost-cost', 'other')
    insertLine(db, 'ghost-cost', { billedCost: 5000, confidence: 'manual', actualSource: 'manual_entry', freshness: NOW })
    db.prepare(`UPDATE cost_line_items SET voided_at = ? WHERE source_id = 'ghost-cost'`).run(NOW)
    const inv = buildSourceInventory(db, emptyConfig(), NOW)
    const s = inv.find(x => x.source_id === 'ghost-cost')!
    expect(s.lifecycle).toBe('inactive')
    expect(s.provenance).toBe('unknown')
    expect(s.freshness).toBe('unknown')
  })

  it('every source gets exactly one lifecycle, one provenance -- never both undefined/null', () => {
    const db = getDb()
    insertSource(db, 'a', 'other')
    insertSource(db, 'b', 'openai')
    insertSource(db, 'c', 'render')
    const inv = buildSourceInventory(db, emptyConfig(), NOW, { credentialChecker: () => true })
    for (const s of inv) {
      expect(s.lifecycle).toBeTruthy()
      expect(s.provenance).toBeTruthy()
    }
  })
})
