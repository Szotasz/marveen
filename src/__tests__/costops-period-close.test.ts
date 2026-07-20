import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  getPeriodStatus, isPeriodClosed, checkPeriodWritable, checkCloseReadiness,
  closePeriod, reopenPeriod, getPeriodCloseHistory, getCloseSnapshot,
} from '../costops/period-close.js'
import { createManualCost, deleteManualCost } from '../costops/manual-entry.js'
import { createCorrection } from '../costops/correction.js'
import { monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const MONTH = monthWindow(NOW).key
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

describe('period status + writability (CostOps Phase 2, GAP-13)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('defaults to open when no row exists yet', () => {
    expect(getPeriodStatus(getDb(), MONTH)).toBe('open')
    expect(isPeriodClosed(getDb(), MONTH)).toBe(false)
    expect(checkPeriodWritable(getDb(), MONTH).writable).toBe(true)
  })

  it('checkPeriodWritable blocks only when status is closed', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'end of month', NOW, { force: true })
    expect(isPeriodClosed(db, MONTH)).toBe(true)
    const r = checkPeriodWritable(db, MONTH)
    expect(r.writable).toBe(false)
    expect(r.reason).toContain('closed')
  })

  it('reopened status reverts to writable (same rules as open)', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW, { force: true })
    reopenPeriod(db, MONTH, 'istvan', 'found a mistake', NOW + 100)
    expect(getPeriodStatus(db, MONTH)).toBe('reopened')
    expect(checkPeriodWritable(db, MONTH).writable).toBe(true)
  })
})

describe('checkCloseReadiness (CostOps Phase 2, GAP-13)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an empty month with nothing outstanding is ready', () => {
    const r = checkCloseReadiness(getDb(), cfg, NOW, MONTH)
    expect(r.ready).toBe(true)
    expect(r.checks.expected_invoices_received.ok).toBe(true)
    expect(r.checks.unresolved_alerts.ok).toBe(true)
  })

  it('a material reconciliation variance blocks readiness', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,1,1)`).run()
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source) VALUES ('render-hosting', ?, ?, 'usage', 10000, 'HUF', 'provider_api', ?, ?, 'a', 'provider_api')`).run(win.start, win.end, NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source) VALUES ('render-hosting', ?, ?, 'usage', 15000, 'HUF', 'actual_invoice', ?, ?, 'b', 'email_invoice')`).run(win.start, win.end, NOW, NOW)
    const r = checkCloseReadiness(db, cfg, NOW, MONTH)
    expect(r.checks.reconciliation_clean.ok).toBe(false)
    expect(r.ready).toBe(false)
  })

  it('an unresolved CRITICAL alert blocks readiness; a non-critical one does not', () => {
    const db = getDb()
    db.prepare(`INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at) VALUES ('budget_threshold','warning','{}','a',?,?,0,?)`).run(NOW, NOW, NOW)
    expect(checkCloseReadiness(db, cfg, NOW, MONTH).ready).toBe(true)

    db.prepare(`INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at) VALUES ('budget_threshold','critical','{}','b',?,?,0,?)`).run(NOW, NOW, NOW)
    const r = checkCloseReadiness(db, cfg, NOW, MONTH)
    expect(r.checks.unresolved_alerts.ok).toBe(false)
    expect(r.ready).toBe(false)
  })

  it('estimate-only sources and stale (not failed) collectors are surfaced but never block', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('hosting','Hosting','other','hosting','HUF',1,1,1)`).run()
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source) VALUES ('hosting', ?, ?, 'subscription', 3000, 'HUF', 'manual', ?, ?, 'a', 'manual_entry')`).run(win.start, win.end, NOW, NOW)
    const r = checkCloseReadiness(db, cfg, NOW, MONTH)
    expect(r.checks.estimates_present.ok).toBe(false)
    expect(r.checks.estimates_present.estimate_only_sources).toContain('hosting')
    expect(r.ready).toBe(true) // estimate presence never blocks
  })
})

describe('closePeriod / reopenPeriod (CostOps Phase 2, GAP-13)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('closes a ready month, records an immutable snapshot + audit event', () => {
    const db = getDb()
    const r = closePeriod(db, cfg, MONTH, 'istvan', 'monthly close', NOW)
    expect(r.ok).toBe(true)
    expect(getPeriodStatus(db, MONTH)).toBe('closed')
    const history = getPeriodCloseHistory(db, MONTH)
    expect(history).toHaveLength(1)
    expect(history[0].event_type).toBe('closed')
    expect(history[0].actor).toBe('istvan')
    const snap = getCloseSnapshot(db, MONTH)
    expect(snap).not.toBeNull()
    expect(snap!.summary.month).toBe(MONTH)
    expect(Array.isArray(snap!.budgets)).toBe(true) // Phase 3 (GAP-11): budget statuses frozen into the close snapshot too
  })

  it('blocks close when readiness has a blocking issue, unless force:true', () => {
    const db = getDb()
    db.prepare(`INSERT INTO costops_alerts (type, severity, evidence_json, dedup_key, first_seen, last_seen, recurrence_count, created_at) VALUES ('budget_threshold','critical','{}','a',?,?,0,?)`).run(NOW, NOW, NOW)
    const blocked = closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW)
    expect(blocked.ok).toBe(false)
    expect(blocked.status).toBe(409)
    expect(blocked.readiness!.ready).toBe(false)

    const forced = closePeriod(db, cfg, MONTH, 'istvan', 'closing despite the alert, reviewed manually', NOW, { force: true })
    expect(forced.ok).toBe(true)
  })

  it('409s on closing an already-closed month -- must reopen first', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW)
    const second = closePeriod(db, cfg, MONTH, 'istvan', 'y', NOW + 10)
    expect(second.ok).toBe(false)
    expect(second.status).toBe(409)
  })

  it('requires an actor to close', () => {
    const db = getDb()
    const r = closePeriod(db, cfg, MONTH, '', 'x', NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('reopen requires a reason and an actor, and only works on a closed month', () => {
    const db = getDb()
    expect(reopenPeriod(db, MONTH, 'istvan', 'x', NOW).ok).toBe(false) // not closed yet
    closePeriod(db, cfg, MONTH, 'istvan', 'close', NOW)
    expect(reopenPeriod(db, MONTH, '', 'x', NOW + 10).ok).toBe(false) // missing actor
    expect(reopenPeriod(db, MONTH, 'istvan', '', NOW + 10).ok).toBe(false) // missing reason
    const r = reopenPeriod(db, MONTH, 'istvan', 'found an error', NOW + 10)
    expect(r.ok).toBe(true)
    expect(getPeriodStatus(db, MONTH)).toBe('reopened')
  })

  it('the audit history records both a close and a later reopen, in order', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'first close', NOW)
    reopenPeriod(db, MONTH, 'istvan', 'correction needed', NOW + 100)
    const history = getPeriodCloseHistory(db, MONTH)
    expect(history.map(h => h.event_type)).toEqual(['closed', 'reopened'])
  })

  it('re-closing after a reopen creates a SECOND immutable snapshot, not overwriting the first', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'first close', NOW)
    const firstSnap = getCloseSnapshot(db, MONTH)
    reopenPeriod(db, MONTH, 'istvan', 'fix needed', NOW + 100)
    // Change the data, then re-close -- the snapshot should reflect the NEW state.
    createManualCost(db, { source_id: 'domain', name: 'Domain', provider: 'other', amount: 5000, currency: 'HUF', month: MONTH }, { fxUsdHuf: 360, now: NOW + 150 })
    closePeriod(db, cfg, MONTH, 'istvan', 'second close', NOW + 200)
    const secondSnap = getCloseSnapshot(db, MONTH)
    expect(secondSnap!.summary.current_spend).not.toBe(firstSnap!.summary.current_spend)
    const history = getPeriodCloseHistory(db, MONTH)
    expect(history.map(h => h.event_type)).toEqual(['closed', 'reopened', 'closed'])
  })
})

describe('write-path guards on a closed month (CostOps Phase 2, GAP-13 integration)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('createManualCost is blocked on a closed month', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW)
    const r = createManualCost(db, { source_id: 'domain', name: 'Domain', provider: 'other', amount: 3000, currency: 'HUF', month: MONTH }, { fxUsdHuf: 360, now: NOW + 10 })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
    expect(r.error).toContain('correction')
  })

  it('createManualCost works again once the month is reopened', () => {
    const db = getDb()
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW)
    reopenPeriod(db, MONTH, 'istvan', 'need to add a late cost', NOW + 10)
    const r = createManualCost(db, { source_id: 'domain', name: 'Domain', provider: 'other', amount: 3000, currency: 'HUF', month: MONTH }, { fxUsdHuf: 360, now: NOW + 20 })
    expect(r.ok).toBe(true)
  })

  it('deleteManualCost (void) is also blocked on a closed month', () => {
    const db = getDb()
    createManualCost(db, { source_id: 'domain', name: 'Domain', provider: 'other', amount: 3000, currency: 'HUF', month: MONTH }, { fxUsdHuf: 360, now: NOW })
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW + 5, { force: true })
    const r = deleteManualCost(db, { source_id: 'domain', month: MONTH }, { now: NOW + 10 })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
  })

  it('createCorrection is NOT blocked on a closed month -- it is the sanctioned path', () => {
    const db = getDb()
    const win = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('render-hosting','Render','render','usage','HUF',1,1,1)`).run()
    const info = db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, created_at, dedup_key, actual_source) VALUES ('render-hosting', ?, ?, 'usage', 10000, 'HUF', 'provider_api', ?, ?, 'a', 'provider_api')`).run(win.start, win.end, NOW, NOW)
    closePeriod(db, cfg, MONTH, 'istvan', 'x', NOW + 5, { force: true })
    const r = createCorrection(db, { originalLineId: info.lastInsertRowid as number, newAmount: 9500, reason: 'late credit applied after close' }, { now: NOW + 20 })
    expect(r.ok).toBe(true)
  })
})
