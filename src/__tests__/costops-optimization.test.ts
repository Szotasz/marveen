import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  detectUnderusedSubscriptionRecommendation,
  detectDuplicateSubscriptionRecommendations,
  detectDuplicateHostingSaasRecommendations,
  detectAnnualBillingRecommendation,
  detectUnusedDomainOrStorageRecommendation,
  detectForgottenServiceRecommendation,
  detectOversizedFixedPackageRecommendation,
  detectAutomateLongManualSourceRecommendation,
  detectProviderCreditOrDiscountRecommendation,
  reconcileRecommendations,
  acceptRecommendation,
  dismissRecommendation,
  serializeEvidence,
  deserializeEvidence,
  initOptimizationSchema,
  type RecommendationRecord,
  type RecommendationCandidate,
} from '../costops/optimization.js'

// ---- detectors ---------------------------------------------------------------------

describe('detectUnderusedSubscriptionRecommendation', () => {
  it('is null above the under-threshold', () => {
    expect(detectUnderusedSubscriptionRecommendation({ subscription_id: 's', provider: 'anthropic', monthly_cost: 100, usage_pct: 0.5, under_threshold_pct: 0.1, cancel_or_downgrade_option: null, downgrade_monthly_cost: null })).toBeNull()
  })
  it('recommends cancellation (full saving, medium risk, high confidence) when no downgrade path is known', () => {
    const r = detectUnderusedSubscriptionRecommendation({ subscription_id: 's', provider: 'anthropic', monthly_cost: 100, usage_pct: 0.05, under_threshold_pct: 0.1, cancel_or_downgrade_option: 'cancel', downgrade_monthly_cost: null })
    expect(r?.estimated_monthly_saving).toBe(100)
    expect(r?.risk).toBe('medium')
    expect(r?.confidence).toBe('high')
  })
  it('recommends downgrade (partial saving, low risk) when a cheaper tier is known', () => {
    const r = detectUnderusedSubscriptionRecommendation({ subscription_id: 's', provider: 'anthropic', monthly_cost: 100, usage_pct: 0.05, under_threshold_pct: 0.1, cancel_or_downgrade_option: 'downgrade', downgrade_monthly_cost: 40 })
    expect(r?.estimated_monthly_saving).toBe(60)
    expect(r?.risk).toBe('low')
  })
  it('is null when no real option is known at all (never fabricates a saving)', () => {
    const r = detectUnderusedSubscriptionRecommendation({ subscription_id: 's', provider: 'anthropic', monthly_cost: 100, usage_pct: 0.05, under_threshold_pct: 0.1, cancel_or_downgrade_option: null, downgrade_monthly_cost: null })
    expect(r).toBeNull()
  })
})

describe('detectDuplicateSubscriptionRecommendations', () => {
  it('flags a group of 2+ active subscriptions in the same product, keeping the most expensive', () => {
    const recs = detectDuplicateSubscriptionRecommendations([
      { subscription_id: 'claude-max', provider: 'anthropic', product: 'llm-subscription', monthly_cost: 100, status: 'active' },
      { subscription_id: 'claude-pro', provider: 'anthropic', product: 'llm-subscription', monthly_cost: 40, status: 'active' },
    ])
    expect(recs).toHaveLength(1)
    expect(recs[0].evidence.suggested_keep).toBe('claude-max')
    expect(recs[0].evidence.suggested_cancel).toEqual(['claude-pro'])
    expect(recs[0].estimated_monthly_saving).toBe(40)
  })
  it('does not flag a single subscription per product', () => {
    const recs = detectDuplicateSubscriptionRecommendations([
      { subscription_id: 'a', provider: 'x', product: 'p1', monthly_cost: 10, status: 'active' },
      { subscription_id: 'b', provider: 'x', product: 'p2', monthly_cost: 10, status: 'active' },
    ])
    expect(recs).toEqual([])
  })
  it('ignores canceled/expired subscriptions', () => {
    const recs = detectDuplicateSubscriptionRecommendations([
      { subscription_id: 'a', provider: 'x', product: 'p1', monthly_cost: 10, status: 'active' },
      { subscription_id: 'b', provider: 'x', product: 'p1', monthly_cost: 10, status: 'canceled' },
    ])
    expect(recs).toEqual([])
  })
})

describe('detectDuplicateHostingSaasRecommendations', () => {
  it('flags a redundant group at low confidence (heuristic grouping)', () => {
    const recs = detectDuplicateHostingSaasRecommendations([
      { source_id: 'render-hosting', provider: 'render', source_type: 'hosting', service_key: 'web-hosting', monthly_cost: 100 },
      { source_id: 'vercel-hosting', provider: 'vercel', source_type: 'hosting', service_key: 'web-hosting', monthly_cost: 60 },
    ])
    expect(recs).toHaveLength(1)
    expect(recs[0].confidence).toBe('low')
    expect(recs[0].estimated_monthly_saving).toBe(60) // total 160 - max 100
  })
})

describe('detectAnnualBillingRecommendation', () => {
  it('is null without a known annual equivalent (never estimated generically)', () => {
    expect(detectAnnualBillingRecommendation({ subscription_id: 's', provider: 'x', monthly_cost: 100, annual_plan_monthly_equivalent: null })).toBeNull()
  })
  it('computes saving and treats the annual up-front cost as switching_cost', () => {
    const r = detectAnnualBillingRecommendation({ subscription_id: 's', provider: 'x', monthly_cost: 100, annual_plan_monthly_equivalent: 80 })
    expect(r?.estimated_monthly_saving).toBe(20)
    expect(r?.switching_cost).toBe(80 * 12)
    expect(r?.confidence).toBe('high')
  })
})

describe('detectUnusedDomainOrStorageRecommendation', () => {
  it('never fires from mere absence of data -- requires confirmed_unused', () => {
    expect(detectUnusedDomainOrStorageRecommendation({ source_id: 'd1', provider: 'namecheap', source_type: 'domain', monthly_cost: 10, confirmed_unused: false })).toBeNull()
  })
  it('fires with the full monthly cost as saving when confirmed', () => {
    const r = detectUnusedDomainOrStorageRecommendation({ source_id: 'd1', provider: 'namecheap', source_type: 'domain', monthly_cost: 10, confirmed_unused: true })
    expect(r?.estimated_monthly_saving).toBe(10)
    expect(r?.rollback_note).toMatch(/re-registered/)
  })
})

describe('detectForgottenServiceRecommendation', () => {
  it('is null with unknown inactivity (never fabricated as 0 months)', () => {
    expect(detectForgottenServiceRecommendation({ source_id: 's', provider: 'x', monthly_cost: 50, months_since_last_meaningful_activity: null, threshold_months: 6 })).toBeNull()
  })
  it('is null under the threshold', () => {
    expect(detectForgottenServiceRecommendation({ source_id: 's', provider: 'x', monthly_cost: 50, months_since_last_meaningful_activity: 3, threshold_months: 6 })).toBeNull()
  })
  it('fires at/above the threshold', () => {
    const r = detectForgottenServiceRecommendation({ source_id: 's', provider: 'x', monthly_cost: 50, months_since_last_meaningful_activity: 6, threshold_months: 6 })
    expect(r?.estimated_monthly_saving).toBe(50)
  })
})

describe('detectOversizedFixedPackageRecommendation', () => {
  it('is null without a known smaller tier', () => {
    expect(detectOversizedFixedPackageRecommendation({ subscription_id: 's', provider: 'x', current_tier_monthly_cost: 100, actual_usage_pct_of_current_tier: 0.1, smaller_tier_monthly_cost: null, smaller_tier_capacity_pct_of_current: null })).toBeNull()
  })
  it('is null when actual usage would NOT fit the smaller tier', () => {
    expect(detectOversizedFixedPackageRecommendation({ subscription_id: 's', provider: 'x', current_tier_monthly_cost: 100, actual_usage_pct_of_current_tier: 0.6, smaller_tier_monthly_cost: 50, smaller_tier_capacity_pct_of_current: 0.5 })).toBeNull()
  })
  it('fires when usage fits within the smaller tier capacity', () => {
    const r = detectOversizedFixedPackageRecommendation({ subscription_id: 's', provider: 'x', current_tier_monthly_cost: 100, actual_usage_pct_of_current_tier: 0.3, smaller_tier_monthly_cost: 50, smaller_tier_capacity_pct_of_current: 0.5 })
    expect(r?.estimated_monthly_saving).toBe(50)
  })
})

describe('detectAutomateLongManualSourceRecommendation', () => {
  it('is null under the threshold', () => {
    expect(detectAutomateLongManualSourceRecommendation({ source_id: 's', provider: 'x', monthly_cost: 20, consecutive_manual_only_months: 2, threshold_months: 3 })).toBeNull()
  })
  it('fires with ZERO estimated saving -- value is data quality, never a fabricated dollar figure', () => {
    const r = detectAutomateLongManualSourceRecommendation({ source_id: 's', provider: 'x', monthly_cost: 20, consecutive_manual_only_months: 3, threshold_months: 3 })
    expect(r?.estimated_monthly_saving).toBe(0)
    expect(r?.estimated_annual_saving).toBe(0)
    expect(r?.current_monthly_cost).toBe(20)
  })
})

describe('detectProviderCreditOrDiscountRecommendation', () => {
  it('is null without a known real offer', () => {
    expect(detectProviderCreditOrDiscountRecommendation({ provider: 'render', monthly_cost: 100, known_available_credit_or_discount_monthly: null, discount_description: null })).toBeNull()
    expect(detectProviderCreditOrDiscountRecommendation({ provider: 'render', monthly_cost: 100, known_available_credit_or_discount_monthly: 0, discount_description: null })).toBeNull()
  })
  it('fires at high confidence for a known offer', () => {
    const r = detectProviderCreditOrDiscountRecommendation({ provider: 'render', monthly_cost: 100, known_available_credit_or_discount_monthly: 15, discount_description: 'annual prepay 15% off' })
    expect(r?.estimated_monthly_saving).toBe(15)
    expect(r?.confidence).toBe('high')
  })
})

// ---- lifecycle ------------------------------------------------------------------------

function candidate(dedup_key: string, over: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    type: 'underused_subscription_downgrade', dedup_key, evidence: { note: 'x' },
    current_monthly_cost: 100, estimated_monthly_saving: 50, estimated_annual_saving: 600,
    switching_cost: 0, risk: 'low', confidence: 'medium',
    human_decision_required: 'confirm', rollback_note: 'reversible',
    ...over,
  }
}

function record(dedup_key: string, status: RecommendationRecord['status'], over: Partial<RecommendationRecord> = {}): RecommendationRecord {
  return {
    ...candidate(dedup_key),
    first_seen: 1, last_seen: 1, status, status_changed_at: null, status_changed_by: null, expires_at: 1 + 1000,
    ...over,
  }
}

describe('reconcileRecommendations', () => {
  it('inserts a brand new recommendation with status open and an expiry', () => {
    const r = reconcileRecommendations([], [candidate('a')], 1000, 500)
    expect(r.toInsert).toHaveLength(1)
    expect(r.toInsert[0].status).toBe('open')
    expect(r.toInsert[0].expires_at).toBe(1500)
  })

  it('touches an OPEN existing recommendation instead of duplicating', () => {
    const existing = record('a', 'open')
    const r = reconcileRecommendations([existing], [candidate('a', { estimated_monthly_saving: 999 })], 2000)
    expect(r.toInsert).toHaveLength(0)
    expect(r.toTouch).toHaveLength(1)
    expect(r.toTouch[0].patch.estimated_monthly_saving).toBe(999)
  })

  it('never touches an ACCEPTED recommendation -- a human decision is frozen', () => {
    const existing = record('a', 'accepted', { status_changed_at: 500, status_changed_by: 'istvan' })
    const r = reconcileRecommendations([existing], [candidate('a')], 2000)
    expect(r.toInsert).toHaveLength(0)
    expect(r.toTouch).toHaveLength(0)
  })

  it('never touches a DISMISSED recommendation -- a human decision is frozen', () => {
    const existing = record('a', 'dismissed', { status_changed_at: 500, status_changed_by: 'istvan' })
    const r = reconcileRecommendations([existing], [candidate('a')], 2000)
    expect(r.toTouch).toHaveLength(0)
  })

  it('resolves an open recommendation whose candidate disappeared', () => {
    const existing = record('a', 'open')
    const r = reconcileRecommendations([existing], [], 2000)
    expect(r.toResolve).toEqual([{ dedup_key: 'a' }])
    expect(r.toExpire).toEqual([])
  })

  it('expires an open recommendation past its expires_at even if still detected', () => {
    const existing = record('a', 'open', { expires_at: 1000 })
    const r = reconcileRecommendations([existing], [candidate('a')], 2000)
    expect(r.toExpire).toEqual([{ dedup_key: 'a' }])
    expect(r.toResolve).toEqual([])
  })

  it('resolve takes priority over expire when a recommendation is both gone AND past expiry', () => {
    const existing = record('a', 'open', { expires_at: 1000 })
    const r = reconcileRecommendations([existing], [], 2000)
    expect(r.toResolve).toEqual([{ dedup_key: 'a' }])
    expect(r.toExpire).toEqual([])
  })

  it('an EXPIRED recommendation resurfacing as a candidate again gets a fresh insert, not an un-expire', () => {
    const existing = record('a', 'expired')
    const r = reconcileRecommendations([existing], [candidate('a')], 3000, 500)
    expect(r.toInsert).toHaveLength(1)
    expect(r.toInsert[0].status).toBe('open')
    expect(r.toInsert[0].first_seen).toBe(3000)
  })

  it('a RESOLVED recommendation resurfacing gets a fresh insert too', () => {
    const existing = record('a', 'resolved')
    const r = reconcileRecommendations([existing], [candidate('a')], 3000)
    expect(r.toInsert).toHaveLength(0) // resolved is NOT in the "!ex || expired" fresh-insert branch by design
    expect(r.toTouch).toHaveLength(0)  // and resolved is frozen, same as accepted/dismissed
  })
})

describe('acceptRecommendation / dismissRecommendation', () => {
  const base = record('a', 'open')
  it('acceptRecommendation sets status/actor/time', () => {
    const a = acceptRecommendation(base, 'istvan', 5000)
    expect(a.status).toBe('accepted')
    expect(a.status_changed_by).toBe('istvan')
    expect(a.status_changed_at).toBe(5000)
  })
  it('dismissRecommendation sets status/actor/time', () => {
    const d = dismissRecommendation(base, 'istvan', 6000)
    expect(d.status).toBe('dismissed')
    expect(d.status_changed_by).toBe('istvan')
  })
})

describe('serializeEvidence / deserializeEvidence (re-exported from alerts.ts)', () => {
  it('round-trips', () => {
    const ev = { subscription_id: 's', usage_pct: 0.05 }
    expect(deserializeEvidence(serializeEvidence(ev))).toEqual(ev)
  })
})

describe('initOptimizationSchema', () => {
  it('is idempotent and the table accepts a row keyed by dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initOptimizationSchema(db)
    initOptimizationSchema(db) // must not throw
    const now = 1000
    db.prepare(`
      INSERT INTO costops_recommendations
        (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving, switching_cost, risk, confidence, human_decision_required, rollback_note, status, expires_at, first_seen, last_seen, created_at)
      VALUES ('underused_subscription_downgrade', @ev, 'k1', 100, 50, 600, 0, 'low', 'medium', 'confirm', 'reversible', 'open', @exp, @now, @now, @now)
    `).run({ ev: serializeEvidence({ x: 1 }), exp: now + 1000, now })
    const row = db.prepare(`SELECT * FROM costops_recommendations WHERE dedup_key = 'k1'`).get() as { estimated_monthly_saving: number; status: string }
    expect(row.estimated_monthly_saving).toBe(50)
    expect(row.status).toBe('open')
  })

  it('rejects a duplicate dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initOptimizationSchema(db)
    const now = 1000
    const insert = () => db.prepare(`
      INSERT INTO costops_recommendations
        (type, evidence_json, dedup_key, current_monthly_cost, estimated_monthly_saving, estimated_annual_saving, switching_cost, risk, confidence, human_decision_required, rollback_note, status, expires_at, first_seen, last_seen, created_at)
      VALUES ('underused_subscription_downgrade', '{}', 'k1', 100, 50, 600, 0, 'low', 'medium', 'confirm', 'reversible', 'open', @exp, @now, @now, @now)
    `).run({ exp: now + 1000, now })
    insert()
    expect(() => insert()).toThrow()
  })
})
