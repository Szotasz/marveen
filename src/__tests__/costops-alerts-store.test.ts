import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { listAllAlerts, listAlerts, applyAlertReconciliation, reconcileAndPersist, acknowledgeAlertByKey, resolveAlertByKey } from '../costops/alerts-store.js'
import { reconcileAlerts, type AlertCandidate } from '../costops/alerts.js'

const NOW = 1_800_000_000

function candidate(dedupKey: string, overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return { type: 'budget_threshold', severity: 'warning', evidence: { foo: 'bar' }, dedup_key: dedupKey, ...overrides }
}

describe('alerts-store (CostOps Phase 3, GAP-12 persistence)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('persists a brand-new candidate as an inserted alert', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('render:budget')], NOW)
    const alerts = listAlerts(db)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].dedup_key).toBe('render:budget')
    expect(alerts[0].evidence).toEqual({ foo: 'bar' })
    expect(alerts[0].resolved_at).toBeNull()
  })

  it('a repeated candidate for an active alert dedupes (touch, not a new row)', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('render:budget')], NOW)
    reconcileAndPersist(db, [candidate('render:budget', { severity: 'critical' })], NOW + 100)
    const all = listAllAlerts(db)
    expect(all).toHaveLength(1)
    expect(all[0].severity).toBe('critical') // refreshed
    expect(all[0].last_seen).toBe(NOW + 100)
  })

  it('an alert whose candidate disappears next round gets resolved', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('render:budget')], NOW)
    reconcileAndPersist(db, [], NOW + 100) // condition cleared
    const active = listAlerts(db, { status: 'active' })
    expect(active).toHaveLength(0)
    const resolved = listAlerts(db, { status: 'resolved' })
    expect(resolved).toHaveLength(1)
    expect(resolved[0].resolved_at).toBe(NOW + 100)
  })

  it('listAlerts defaults to active only, status=all returns everything', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('a'), candidate('b')], NOW)
    reconcileAndPersist(db, [candidate('a')], NOW + 100) // b resolves
    expect(listAlerts(db)).toHaveLength(1) // default: active
    expect(listAlerts(db, { status: 'all' })).toHaveLength(2)
    expect(listAlerts(db, { status: 'resolved' })).toHaveLength(1)
  })

  it('filters by type', () => {
    const db = getDb()
    reconcileAndPersist(db, [
      candidate('a', { type: 'budget_threshold' }),
      candidate('b', { type: 'stale_collector' }),
    ], NOW)
    expect(listAlerts(db, { type: 'stale_collector' })).toHaveLength(1)
  })

  it('acknowledgeAlertByKey sets acknowledged fields without touching resolution', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('render:budget')], NOW)
    const r = acknowledgeAlertByKey(db, 'render:budget', 'istvan', NOW + 50)
    expect(r.ok).toBe(true)
    const all = listAllAlerts(db)
    expect(all[0].acknowledged_by).toBe('istvan')
    expect(all[0].acknowledged_at).toBe(NOW + 50)
    expect(all[0].resolved_at).toBeNull()
  })

  it('acknowledgeAlertByKey 404s on an unknown dedup_key', () => {
    const db = getDb()
    const r = acknowledgeAlertByKey(db, 'ghost', 'istvan', NOW)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  it('resolveAlertByKey manually resolves an active alert early', () => {
    const db = getDb()
    reconcileAndPersist(db, [candidate('render:budget')], NOW)
    const r = resolveAlertByKey(db, 'render:budget', NOW + 20)
    expect(r.ok).toBe(true)
    expect(listAlerts(db)).toHaveLength(0)
  })

  it('applyAlertReconciliation matches reconcileAlerts pure output exactly (integration check)', () => {
    const db = getDb()
    const result = reconcileAlerts([], [candidate('x')], NOW)
    applyAlertReconciliation(db, result, NOW)
    const all = listAllAlerts(db)
    expect(all).toHaveLength(1)
    expect(all[0].recurrence_count).toBe(0)
    expect(all[0].cooldown_until).toBe(NOW + 3600)
  })
})
