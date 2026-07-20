// CostOps Phase 0 -- 7-day source-reliability observation window (gap-analysis
// P0.4). Captures a point-in-time snapshot of the full source inventory
// (lifecycle + freshness + sync status per source) so day-over-day
// reliability can be compared once several captures accumulate. This module
// only builds and stores ONE capture; the recurring daily cadence over the
// 7-day window is wired at boot (see web.ts) the same way the existing
// fixed-cost sync interval is -- this module has no scheduling of its own,
// keeping it independently testable.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { loadCostopsConfig, type CostOpsConfig } from './config.js'
import { buildSourceInventory, type SourceInventoryEntry, type CredentialChecker } from './inventory.js'
import { captureForecastSnapshots } from './forecast-capture.js'
import { captureAlerts } from './alerts-capture.js'
import { captureRecommendations } from './optimization-capture.js'
import { logger } from '../logger.js'

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface ReliabilitySnapshot {
  captured_at: number
  source_count: number
  inventory: SourceInventoryEntry[]
}

/** Build and persist one reliability snapshot. Returns the row that was written. */
export function captureReliabilitySnapshot(
  db: Database.Database,
  config: CostOpsConfig,
  now: number,
  deps: { credentialChecker?: CredentialChecker } = {},
): ReliabilitySnapshot {
  const inventory = buildSourceInventory(db, config, now, deps)
  db.prepare(`
    INSERT INTO costops_reliability_snapshots (captured_at, source_count, inventory_json)
    VALUES (@now, @count, @json)
  `).run({ now, count: inventory.length, json: JSON.stringify(inventory) })
  return { captured_at: now, source_count: inventory.length, inventory }
}

/** All snapshots captured so far, oldest first -- the growing 7-day observation window. */
export function listReliabilitySnapshots(db: Database.Database, limit = 30): Array<{ captured_at: number; source_count: number }> {
  return db.prepare(`
    SELECT captured_at, source_count FROM costops_reliability_snapshots
    ORDER BY captured_at ASC LIMIT ?
  `).all(limit) as Array<{ captured_at: number; source_count: number }>
}

/** The single most recent snapshot's full inventory, or null if none exist yet. */
export function getLatestReliabilitySnapshot(db: Database.Database): ReliabilitySnapshot | null {
  const row = db.prepare(`
    SELECT captured_at, source_count, inventory_json FROM costops_reliability_snapshots
    ORDER BY captured_at DESC LIMIT 1
  `).get() as { captured_at: number; source_count: number; inventory_json: string } | undefined
  if (!row) return null
  return { captured_at: row.captured_at, source_count: row.source_count, inventory: JSON.parse(row.inventory_json) }
}

function captureNowSafely(): void {
  const now = Math.floor(Date.now() / 1000)
  try {
    const { config } = loadCostopsConfig()
    captureReliabilitySnapshot(getDb(), config, now)
  } catch (err) {
    logger.warn({ err }, 'CostOps reliability snapshot capture failed')
  }
  // Phase 1 (GAP-10): forecast snapshots, same daily cadence. Independent
  // try/catch so a failure in one capture never blocks the other.
  try {
    captureForecastSnapshots(getDb(), now)
  } catch (err) {
    logger.warn({ err }, 'CostOps forecast snapshot capture failed')
  }
  // Phase 3 (GAP-12): alerts capture/reconcile, same daily cadence.
  try {
    const { config } = loadCostopsConfig()
    captureAlerts(getDb(), config, now)
  } catch (err) {
    logger.warn({ err }, 'CostOps alerts capture failed')
  }
  // Phase 4 (GAP-17): optimization recommendation capture/reconcile, same daily cadence.
  try {
    captureRecommendations(getDb(), now)
  } catch (err) {
    logger.warn({ err }, 'CostOps optimization recommendation capture failed')
  }
}

/**
 * Boot-time seam entry point (docs/fork-upstream-policy.md §2a): the ONE
 * call web.ts makes for every CostOps background task, present and future
 * (currently: reliability-observation snapshots + Phase 1 forecast
 * snapshots). Captures immediately, then every 24h. Returns the interval
 * handle so the caller can clearInterval it on shutdown, matching every
 * other start*Runner()/start*Monitor() in this codebase (e.g.
 * startAutoRestartRunner).
 */
export function startCostOpsBackgroundTasks(): NodeJS.Timeout {
  captureNowSafely()
  return setInterval(captureNowSafely, SNAPSHOT_INTERVAL_MS)
}
