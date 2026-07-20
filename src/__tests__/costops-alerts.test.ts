import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  detectBudgetThresholdAlert,
  detectForecastBudgetBreachAlert,
  detectBalanceExhaustionAlert,
  detectStaleCollectorAlert,
  detectFailedSyncAlert,
  detectCredentialPermissionAlert,
  detectMissingInvoiceAlert,
  detectReconciliationMismatchAlert,
  detectManualProviderVarianceAlert,
  detectUnusualSpendGrowthAlert,
  detectNewUnknownSourceAlert,
  detectLongEstimateOnlySourceAlert,
  detectSubscriptionUtilizationAlert,
  reconcileAlerts,
  acknowledgeAlert,
  resolveAlert,
  serializeEvidence,
  deserializeEvidence,
  initAlertsSchema,
  type AlertRecord,
  type AlertCandidate,
} from '../costops/alerts.js'

// ---- detectors ---------------------------------------------------------------------

describe('detectBudgetThresholdAlert', () => {
  it('is null below the warning threshold', () => {
    expect(detectBudgetThresholdAlert({ budget_id: 'global', scope: 'global', used_pct: 0.5, warning_threshold: 0.8, hard_threshold: 1.0 })).toBeNull()
  })
  it('is warning between warning and hard', () => {
    const a = detectBudgetThresholdAlert({ budget_id: 'global', scope: 'global', used_pct: 0.85, warning_threshold: 0.8, hard_threshold: 1.0 })
    expect(a?.severity).toBe('warning')
  })
  it('is critical at/above hard threshold', () => {
    const a = detectBudgetThresholdAlert({ budget_id: 'global', scope: 'global', used_pct: 1.05, warning_threshold: 0.8, hard_threshold: 1.0 })
    expect(a?.severity).toBe('critical')
  })
})

describe('detectForecastBudgetBreachAlert', () => {
  it('fires when forecast crosses hard but current spend has not yet', () => {
    const a = detectForecastBudgetBreachAlert({ budget_id: 'global', scope: 'global', used_pct: 0.6, forecast_pct: 1.1, warning_threshold: 0.8, hard_threshold: 1.0 })
    expect(a?.type).toBe('forecast_budget_breach')
  })
  it('does not fire once current spend itself has already crossed hard (budget_threshold owns that)', () => {
    const a = detectForecastBudgetBreachAlert({ budget_id: 'global', scope: 'global', used_pct: 1.02, forecast_pct: 1.1, warning_threshold: 0.8, hard_threshold: 1.0 })
    expect(a).toBeNull()
  })
})

describe('detectBalanceExhaustionAlert', () => {
  const NOW = 100 * 86400
  it('is null without a forecast exhaustion date', () => {
    expect(detectBalanceExhaustionAlert({ provider: 'deepseek', remaining: 5, currency: 'USD', forecast_exhaustion_at: null }, NOW)).toBeNull()
  })
  it('is critical once the exhaustion date has passed', () => {
    const a = detectBalanceExhaustionAlert({ provider: 'deepseek', remaining: 0, currency: 'USD', forecast_exhaustion_at: NOW - 86400 }, NOW)
    expect(a?.severity).toBe('critical')
  })
  it('is warning within the warning window', () => {
    const a = detectBalanceExhaustionAlert({ provider: 'deepseek', remaining: 2, currency: 'USD', forecast_exhaustion_at: NOW + 3 * 86400 }, NOW)
    expect(a?.severity).toBe('warning')
  })
  it('is null far outside the warning window', () => {
    const a = detectBalanceExhaustionAlert({ provider: 'deepseek', remaining: 100, currency: 'USD', forecast_exhaustion_at: NOW + 30 * 86400 }, NOW)
    expect(a).toBeNull()
  })
})

describe('detectStaleCollectorAlert / detectFailedSyncAlert', () => {
  it('stale is capped at warning (never critical) -- stale data alone is not a strong claim', () => {
    const a = detectStaleCollectorAlert({ provider: 'render', status: 'stale', last_success: 1, data_age_secs: 999999, error_code: null })
    expect(a?.severity).toBe('warning')
  })
  it('stale detector ignores ok/failed status', () => {
    expect(detectStaleCollectorAlert({ provider: 'render', status: 'ok', last_success: 1, data_age_secs: 1, error_code: null })).toBeNull()
    expect(detectStaleCollectorAlert({ provider: 'render', status: 'failed', last_success: 1, data_age_secs: 1, error_code: null })).toBeNull()
  })
  it('failed sync is critical for a credential/permission error, warning otherwise', () => {
    const cred = detectFailedSyncAlert({ provider: 'aws', status: 'failed', last_success: null, data_age_secs: null, error_code: 'credential_error' })
    expect(cred?.severity).toBe('critical')
    const network = detectFailedSyncAlert({ provider: 'aws', status: 'failed', last_success: null, data_age_secs: null, error_code: 'timeout' })
    expect(network?.severity).toBe('warning')
  })
})

describe('detectCredentialPermissionAlert', () => {
  it('always returns a critical alert', () => {
    const a = detectCredentialPermissionAlert({ source_id: 'aws-costexplorer', provider: 'aws', issue: 'permission_error' })
    expect(a.severity).toBe('critical')
    expect(a.dedup_key).toBe('credential_permission_error|aws-costexplorer')
  })
})

describe('detectMissingInvoiceAlert', () => {
  it('is null if received or not yet due', () => {
    expect(detectMissingInvoiceAlert({ source_id: 'render', expected_by: 1000, received: true }, 2000)).toBeNull()
    expect(detectMissingInvoiceAlert({ source_id: 'render', expected_by: 3000, received: false }, 2000)).toBeNull()
  })
  it('fires once overdue', () => {
    const a = detectMissingInvoiceAlert({ source_id: 'render', expected_by: 1000, received: false }, 1000 + 5 * 86400)
    expect(a?.evidence.overdue_days).toBe(5)
  })
})

describe('detectReconciliationMismatchAlert', () => {
  it('refuses to fire against a zero baseline (never a fabricated comparison)', () => {
    expect(detectReconciliationMismatchAlert({ source_id: 'x', estimate: 100, actual: 0, variance: -100, variance_threshold_pct: 0.1 })).toBeNull()
  })
  it('is null under the threshold, warning over, critical at 2x the threshold', () => {
    expect(detectReconciliationMismatchAlert({ source_id: 'x', estimate: 100, actual: 105, variance: 5, variance_threshold_pct: 0.1 })).toBeNull()
    const warn = detectReconciliationMismatchAlert({ source_id: 'x', estimate: 100, actual: 87, variance: -13, variance_threshold_pct: 0.1 })
    expect(warn?.severity).toBe('warning')
    const crit = detectReconciliationMismatchAlert({ source_id: 'x', estimate: 100, actual: 50, variance: -50, variance_threshold_pct: 0.1 })
    expect(crit?.severity).toBe('critical')
  })
})

describe('detectManualProviderVarianceAlert', () => {
  it('is null with no provider-derived spend', () => {
    expect(detectManualProviderVarianceAlert({ provider: 'render', manual_spend: 100, provider_derived_spend: 0, variance_threshold_pct: 0.1 })).toBeNull()
  })
  it('fires past the threshold', () => {
    const a = detectManualProviderVarianceAlert({ provider: 'render', manual_spend: 40000, provider_derived_spend: 37080, variance_threshold_pct: 0.05 })
    expect(a?.type).toBe('manual_provider_variance')
  })
})

describe('detectUnusualSpendGrowthAlert', () => {
  it('is null with no measurable baseline', () => {
    expect(detectUnusualSpendGrowthAlert({ key: 'anthropic', current_amount: 500, baseline_amount: 0, growth_threshold_pct: 0.5 })).toBeNull()
  })
  it('warning past threshold, critical at 2x', () => {
    const warn = detectUnusualSpendGrowthAlert({ key: 'anthropic', current_amount: 160, baseline_amount: 100, growth_threshold_pct: 0.5 })
    expect(warn?.severity).toBe('warning')
    const crit = detectUnusualSpendGrowthAlert({ key: 'anthropic', current_amount: 220, baseline_amount: 100, growth_threshold_pct: 0.5 })
    expect(crit?.severity).toBe('critical')
  })
})

describe('detectNewUnknownSourceAlert / detectLongEstimateOnlySourceAlert / detectSubscriptionUtilizationAlert', () => {
  it('new source only fires on first appearance', () => {
    expect(detectNewUnknownSourceAlert({ source_id: 'x', first_seen_month: '2026-07', is_first_appearance: false })).toBeNull()
    expect(detectNewUnknownSourceAlert({ source_id: 'x', first_seen_month: '2026-07', is_first_appearance: true })?.severity).toBe('info')
  })
  it('long estimate-only fires only at/above the threshold month count', () => {
    expect(detectLongEstimateOnlySourceAlert({ source_id: 'x', consecutive_estimate_only_months: 2, threshold_months: 3 })).toBeNull()
    expect(detectLongEstimateOnlySourceAlert({ source_id: 'x', consecutive_estimate_only_months: 3, threshold_months: 3 })?.type).toBe('long_estimate_only_source')
  })
  it('subscription utilization fires under and over, not in between', () => {
    expect(detectSubscriptionUtilizationAlert({ subscription_id: 's', usage_pct: 0.5, under_threshold_pct: 0.2, over_threshold_pct: 0.9 })).toBeNull()
    const under = detectSubscriptionUtilizationAlert({ subscription_id: 's', usage_pct: 0.1, under_threshold_pct: 0.2, over_threshold_pct: 0.9 })
    expect(under?.evidence.direction).toBe('under')
    const over = detectSubscriptionUtilizationAlert({ subscription_id: 's', usage_pct: 0.95, under_threshold_pct: 0.2, over_threshold_pct: 0.9 })
    expect(over?.evidence.direction).toBe('over')
  })
})

// ---- lifecycle ------------------------------------------------------------------------

function candidate(dedup_key: string, over: Partial<AlertCandidate> = {}): AlertCandidate {
  return { type: 'budget_threshold', severity: 'warning', evidence: { note: 'x' }, dedup_key, ...over }
}

describe('reconcileAlerts', () => {
  it('inserts a brand new alert when nothing existed for its dedup_key', () => {
    const r = reconcileAlerts([], [candidate('a')], 1000)
    expect(r.toInsert).toHaveLength(1)
    expect(r.toInsert[0].first_seen).toBe(1000)
    expect(r.toInsert[0].recurrence_count).toBe(0)
    expect(r.toTouch).toHaveLength(0)
    expect(r.toResolve).toHaveLength(0)
  })

  it('deduplicates: a candidate matching an ACTIVE existing alert only touches last_seen, never inserts a duplicate', () => {
    const existing: AlertRecord = {
      dedup_key: 'a', type: 'budget_threshold', severity: 'warning', evidence: {},
      first_seen: 500, last_seen: 500, acknowledged_at: null, acknowledged_by: null,
      resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: 500 + 3600,
    }
    const r = reconcileAlerts([existing], [candidate('a')], 1000)
    expect(r.toInsert).toHaveLength(0)
    expect(r.toTouch).toHaveLength(1)
    expect(r.toTouch[0].patch.last_seen).toBe(1000)
    expect(r.toTouch[0].patch.recurrence_count).toBe(0) // dedup does not bump recurrence
  })

  it('resolves an active alert whose candidate disappeared this round', () => {
    const existing: AlertRecord = {
      dedup_key: 'a', type: 'budget_threshold', severity: 'warning', evidence: {},
      first_seen: 500, last_seen: 500, acknowledged_at: null, acknowledged_by: null,
      resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: 4100,
    }
    const r = reconcileAlerts([existing], [], 1000)
    expect(r.toResolve).toEqual([{ dedup_key: 'a', resolved_at: 1000 }])
  })

  it('reopens a resolved alert WITHIN cooldown without bumping recurrence_count (flapping protection)', () => {
    const existing: AlertRecord = {
      dedup_key: 'a', type: 'budget_threshold', severity: 'warning', evidence: {},
      first_seen: 100, last_seen: 200, acknowledged_at: null, acknowledged_by: null,
      resolved_at: 300, recurrence_count: 2, owner: null, cooldown_until: 100 + 3600, // cooldown extends to 3700
    }
    const r = reconcileAlerts([existing], [candidate('a')], 3500, 3600) // 3500 < 3700 cooldown_until
    expect(r.toTouch).toHaveLength(1)
    expect(r.toTouch[0].patch.resolved_at).toBeNull()
    expect(r.toTouch[0].patch.recurrence_count).toBe(2) // unchanged -- flap, not a genuine new incident
  })

  it('reopens a resolved alert AFTER cooldown and bumps recurrence_count (genuine recurrence)', () => {
    const existing: AlertRecord = {
      dedup_key: 'a', type: 'budget_threshold', severity: 'warning', evidence: {},
      first_seen: 100, last_seen: 200, acknowledged_at: null, acknowledged_by: null,
      resolved_at: 300, recurrence_count: 2, owner: null, cooldown_until: 100 + 3600, // cooldown_until = 3700
    }
    const r = reconcileAlerts([existing], [candidate('a')], 4000, 3600) // 4000 > 3700
    expect(r.toTouch[0].patch.resolved_at).toBeNull()
    expect(r.toTouch[0].patch.recurrence_count).toBe(3) // bumped
    expect(r.toTouch[0].patch.cooldown_until).toBe(4000 + 3600)
  })

  it('handles insert + touch + resolve together in one reconcile call', () => {
    const stillActive: AlertRecord = {
      dedup_key: 'active', type: 'budget_threshold', severity: 'warning', evidence: {},
      first_seen: 1, last_seen: 1, acknowledged_at: null, acknowledged_by: null,
      resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: 3601,
    }
    const goneNow: AlertRecord = {
      dedup_key: 'gone', type: 'stale_collector', severity: 'warning', evidence: {},
      first_seen: 1, last_seen: 1, acknowledged_at: null, acknowledged_by: null,
      resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: 3601,
    }
    const r = reconcileAlerts([stillActive, goneNow], [candidate('active'), candidate('brand-new')], 5000)
    expect(r.toInsert.map(i => i.dedup_key)).toEqual(['brand-new'])
    expect(r.toTouch.map(t => t.dedup_key)).toEqual(['active'])
    expect(r.toResolve.map(t => t.dedup_key)).toEqual(['gone'])
  })
})

describe('acknowledgeAlert / resolveAlert', () => {
  const base: AlertRecord = {
    dedup_key: 'a', type: 'budget_threshold', severity: 'warning', evidence: {},
    first_seen: 1, last_seen: 1, acknowledged_at: null, acknowledged_by: null,
    resolved_at: null, recurrence_count: 0, owner: null, cooldown_until: null,
  }
  it('acknowledgeAlert records actor + time without touching resolution', () => {
    const a = acknowledgeAlert(base, 'istvan', 5000)
    expect(a.acknowledged_at).toBe(5000)
    expect(a.acknowledged_by).toBe('istvan')
    expect(a.resolved_at).toBeNull()
  })
  it('resolveAlert sets resolved_at', () => {
    const r = resolveAlert(base, 6000)
    expect(r.resolved_at).toBe(6000)
  })
})

describe('serializeEvidence / deserializeEvidence', () => {
  it('round-trips an evidence object', () => {
    const ev = { provider: 'render', used_pct: 0.9 }
    expect(deserializeEvidence(serializeEvidence(ev))).toEqual(ev)
  })
  it('deserializeEvidence never throws on bad JSON -- returns {}', () => {
    expect(deserializeEvidence('not json')).toEqual({})
  })
})

describe('initAlertsSchema', () => {
  it('is idempotent and the table accepts a row keyed by dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initAlertsSchema(db)
    initAlertsSchema(db) // second call must not throw
    const now = 1000
    db.prepare(`
      INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at)
      VALUES ('budget_threshold', 'warning', @ev, 'budget_threshold|global', @now, @now, 0, @now)
    `).run({ now, ev: serializeEvidence({ used_pct: 0.9 }) })
    const row = db.prepare(`SELECT * FROM costops_alerts WHERE dedup_key = 'budget_threshold|global'`).get() as { evidence_json: string; resolved_at: number | null }
    expect(deserializeEvidence(row.evidence_json)).toEqual({ used_pct: 0.9 })
    expect(row.resolved_at).toBeNull()
  })

  it('rejects a duplicate dedup_key', () => {
    initDatabase(':memory:')
    const db = getDb()
    initAlertsSchema(db)
    const now = 1000
    db.prepare(`INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at) VALUES ('budget_threshold','warning','{}','a',@now,@now,0,@now)`).run({ now })
    expect(() => {
      db.prepare(`INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at) VALUES ('budget_threshold','critical','{}','a',@now,@now,0,@now)`).run({ now })
    }).toThrow()
  })
})
