import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { captureReliabilitySnapshot, listReliabilitySnapshots, getLatestReliabilitySnapshot, startCostOpsBackgroundTasks } from '../costops/reliability-observation.js'
import type { CostOpsConfig } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const DAY = 86400
const cfg: CostOpsConfig = { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] }

describe('reliability observation window (CostOps Phase 0, P0.4/P0.5)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('captures a snapshot and can read it back verbatim', () => {
    const db = getDb()
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,?,?)`).run(NOW, NOW)
    const snap = captureReliabilitySnapshot(db, cfg, NOW)
    expect(snap.captured_at).toBe(NOW)
    expect(snap.source_count).toBe(1)
    expect(snap.inventory[0].source_id).toBe('domain')

    const latest = getLatestReliabilitySnapshot(db)
    expect(latest).not.toBeNull()
    expect(latest!.captured_at).toBe(NOW)
    expect(latest!.inventory).toEqual(snap.inventory)
  })

  it('returns null from getLatestReliabilitySnapshot when nothing has been captured yet', () => {
    expect(getLatestReliabilitySnapshot(getDb())).toBeNull()
  })

  it('accumulates the 7-day observation window as multiple captures, oldest first', () => {
    const db = getDb()
    captureReliabilitySnapshot(db, cfg, NOW)
    captureReliabilitySnapshot(db, cfg, NOW + DAY)
    captureReliabilitySnapshot(db, cfg, NOW + 2 * DAY)
    const list = listReliabilitySnapshots(db)
    expect(list.map(s => s.captured_at)).toEqual([NOW, NOW + DAY, NOW + 2 * DAY])
  })

  it('the latest snapshot reflects the most recent capture, not the first', () => {
    const db = getDb()
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('domain','Domain','other','domain','HUF',1,?,?)`).run(NOW, NOW)
    captureReliabilitySnapshot(db, cfg, NOW)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('hosting','Hosting','other','hosting','HUF',1,?,?)`).run(NOW, NOW)
    const second = captureReliabilitySnapshot(db, cfg, NOW + DAY)
    const latest = getLatestReliabilitySnapshot(db)
    expect(latest!.source_count).toBe(2)
    expect(latest!.captured_at).toBe(second.captured_at)
  })
})

describe('startCostOpsBackgroundTasks (boot seam, docs/fork-upstream-policy.md §2a)', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('captures a snapshot immediately at boot, then again every 24h, via a single call', () => {
    const handle = startCostOpsBackgroundTasks()
    try {
      expect(listReliabilitySnapshots(getDb())).toHaveLength(1) // immediate boot capture
      vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      expect(listReliabilitySnapshots(getDb())).toHaveLength(2) // one interval tick later
    } finally {
      clearInterval(handle)
    }
  })

  it('the same single call also captures a Phase 1 forecast snapshot (TOTAL row, no sources yet)', async () => {
    const { listForecastSnapshots } = await import('../costops/forecast-capture.js')
    const handle = startCostOpsBackgroundTasks()
    try {
      const stored = listForecastSnapshots(getDb())
      expect(stored.length).toBeGreaterThan(0)
      expect(stored.some(s => s.source_id === null)).toBe(true) // whole-deployment TOTAL row
    } finally {
      clearInterval(handle)
    }
  })

  it('the same single call also runs the Phase 3 alerts capture without throwing (empty DB, no candidates expected)', async () => {
    const { listAlerts } = await import('../costops/alerts-store.js')
    const handle = startCostOpsBackgroundTasks()
    try {
      expect(listAlerts(getDb())).toEqual([])
    } finally {
      clearInterval(handle)
    }
  })

  it('the same single call also runs the Phase 4 optimization recommendation capture without throwing (empty DB, no candidates expected)', async () => {
    const { listAllRecommendations } = await import('../costops/recommendations-store.js')
    const handle = startCostOpsBackgroundTasks()
    try {
      expect(listAllRecommendations(getDb())).toEqual([])
    } finally {
      clearInterval(handle)
    }
  })
})
