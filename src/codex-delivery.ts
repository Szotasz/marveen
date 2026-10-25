import { createHash } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILENAME, STORE_DIR } from './config.js'

export type CodexDeliveryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface CodexDelivery {
  deliveryId: string
  idempotencyKey: string
  taskId: string
  agentId: string
  scheduledOccurrence: number
  taskRunId: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  status: CodexDeliveryStatus
  attemptCount: number
  errorCode: string | null
  errorSummary: string | null
  reviewState: 'waiting' | null
  prompt: string
  notifiedAt: number | null
  escalatedAt: number | null
}

interface DeliveryRow {
  delivery_id: string
  idempotency_key: string
  task_id: string
  agent_id: string
  scheduled_occurrence: number
  task_run_id: number
  queued_at: number
  started_at: number | null
  finished_at: number | null
  status: CodexDeliveryStatus
  attempt_count: number
  error_code: string | null
  error_summary: string | null
  review_state: 'waiting' | null
  prompt: string
  notified_at: number | null
  escalated_at: number | null
}

function toDelivery(row: DeliveryRow): CodexDelivery {
  return {
    deliveryId: row.delivery_id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    agentId: row.agent_id,
    scheduledOccurrence: row.scheduled_occurrence,
    taskRunId: row.task_run_id,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    reviewState: row.review_state,
    prompt: row.prompt,
    notifiedAt: row.notified_at,
    escalatedAt: row.escalated_at,
  }
}

export function scheduledCodexIdempotencyKey(taskId: string, agentId: string, occurrence: number): string {
  if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(agentId) || !Number.isSafeInteger(occurrence) || occurrence < 0) {
    throw new Error('Invalid scheduled Codex delivery identity')
  }
  return `scheduled:${agentId}:${taskId}:${occurrence}`
}

export function scheduledCodexIdentity(taskId: string, agentId: string, occurrence: number): { deliveryId: string; idempotencyKey: string } {
  const idempotencyKey = scheduledCodexIdempotencyKey(taskId, agentId, occurrence)
  return { deliveryId: createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32), idempotencyKey }
}

/**
 * The queue and its task_runs ownership are committed by one SQLite transaction.
 * A crash before commit leaves neither; a crash after commit leaves a queued
 * delivery that the Codex host can pick up after either process restarts.
 */
export class CodexDeliveryStore {
  private readonly db: Database.Database

  constructor(dbPath: string = join(STORE_DIR, DB_FILENAME)) {
    this.db = new Database(dbPath)
    this.db.pragma('busy_timeout = 5000')
    const columns = this.db.pragma('table_info(task_runs)') as Array<{name: string}>
    if (columns.length && !columns.some(c => c.name === 'scheduled_occurrence')) this.db.exec('ALTER TABLE task_runs ADD COLUMN scheduled_occurrence INTEGER')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codex_deliveries (
        delivery_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        scheduled_occurrence INTEGER NOT NULL,
        task_run_id INTEGER NOT NULL UNIQUE,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_summary TEXT,
        review_state TEXT CHECK(review_state IS NULL OR review_state = 'waiting'),
        prompt TEXT NOT NULL,
        notified_at INTEGER,
        escalated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_codex_deliveries_status ON codex_deliveries(status, queued_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_task_occurrence ON codex_deliveries(task_id, scheduled_occurrence);
    `)
  }

  close(): void { this.db.close() }

  get(deliveryId: string): CodexDelivery | null {
    const row = this.db.prepare('SELECT * FROM codex_deliveries WHERE delivery_id = ?').get(deliveryId) as DeliveryRow | undefined
    return row ? toDelivery(row) : null
  }

  prepare(input: {
    taskId: string
    agentId: string
    scheduledOccurrence: number
    prompt: string
    queuedAt?: number
    late?: boolean
    deliveryId?: string
    idempotencyKey?: string
  }): { delivery: CodexDelivery; created: boolean } {
    const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
    if ((input.deliveryId && input.deliveryId !== identity.deliveryId) ||
        (input.idempotencyKey && input.idempotencyKey !== identity.idempotencyKey)) {
      throw new Error('Scheduled Codex delivery identity mismatch')
    }
    const { idempotencyKey: key, deliveryId } = identity
    return this.db.transaction(() => {
      const existingRow = this.db.prepare('SELECT * FROM codex_deliveries WHERE task_id = ? AND scheduled_occurrence = ?').get(input.taskId, input.scheduledOccurrence) as DeliveryRow | undefined
      const existing = existingRow ? toDelivery(existingRow) : null
      if (existing && existing.agentId !== input.agentId) throw new Error('Occurrence already belongs to another agent')
      if (existing && (existing.deliveryId !== deliveryId || existing.idempotencyKey !== key)) throw new Error('Occurrence identity mismatch')
      if (existing) return { delivery: existing, created: false }
      const queuedAt = input.queuedAt ?? Date.now()
      const run = this.db.prepare(
        'INSERT INTO task_runs (name, agent, ts, status, scheduled_occurrence) VALUES (?, ?, ?, ?, ?)',
      ).run(input.taskId, input.agentId, queuedAt, input.late ? 'fired_late_codex' : 'fired_codex', input.scheduledOccurrence)
      this.db.prepare(`
        INSERT INTO codex_deliveries
          (delivery_id, idempotency_key, task_id, agent_id, scheduled_occurrence,
           task_run_id, queued_at, status, prompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(deliveryId, key, input.taskId, input.agentId, input.scheduledOccurrence,
        Number(run.lastInsertRowid), queuedAt, input.prompt)
      return { delivery: this.get(deliveryId)!, created: true }
    }).immediate()
  }

  listQueued(): CodexDelivery[] {
    return (this.db.prepare(`SELECT * FROM codex_deliveries WHERE status = 'queued' ORDER BY queued_at, delivery_id`).all() as DeliveryRow[])
      .map(toDelivery)
  }

  listMonitorable(): CodexDelivery[] {
    return (this.db.prepare(`
      SELECT * FROM codex_deliveries
      WHERE status IN ('queued','running')
         OR (status IN ('failed','interrupted') AND notified_at IS NULL)
      ORDER BY queued_at
    `).all() as DeliveryRow[]).map(toDelivery)
  }

  listUnknownRuns(): Array<{ taskRunId: number; taskId: string; agentId: string; queuedAt: number }> {
    return this.db.prepare(`
      SELECT r.id AS taskRunId, r.name AS taskId, r.agent AS agentId, r.ts AS queuedAt
      FROM task_runs r LEFT JOIN codex_deliveries d ON d.task_run_id = r.id
      WHERE r.status IN ('fired_codex','fired_late_codex') AND r.completed_at IS NULL
        AND d.delivery_id IS NULL
    `).all() as Array<{ taskRunId: number; taskId: string; agentId: string; queuedAt: number }>
  }

  claimQueued(deliveryId: string, startedAt = Date.now()): CodexDelivery | null {
    const result = this.db.prepare(`
      UPDATE codex_deliveries SET status = 'running', started_at = ?, review_state = NULL,
        attempt_count = attempt_count + 1
      WHERE delivery_id = ? AND status = 'queued'
    `).run(startedAt, deliveryId)
    return result.changes ? this.get(deliveryId) : null
  }

  finish(deliveryId: string, status: 'completed' | 'failed' | 'interrupted',
    errorCode: string | null = null, errorSummary: string | null = null, finishedAt = Date.now()): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE codex_deliveries
        SET status = ?, finished_at = ?, error_code = ?, error_summary = ?, review_state = ?
        WHERE delivery_id = ? AND status = 'running'
      `).run(status, finishedAt, errorCode?.slice(0, 64) ?? null, errorSummary?.slice(0, 240) ?? null,
        status === 'completed' ? null : 'waiting', deliveryId)
      if (!result.changes) return false
      const delivery = this.get(deliveryId)!
      this.db.prepare(`
        UPDATE task_runs SET completed_at = ?, outcome = ?
        WHERE id = ? AND completed_at IS NULL
      `).run(finishedAt, status === 'completed' ? 'done' : 'interrupted', delivery.taskRunId)
      return true
    })()
  }

  interruptRunning(finishedAt = Date.now()): number {
    return this.db.transaction(() => {
      const running = this.db.prepare(`SELECT delivery_id FROM codex_deliveries WHERE status = 'running'`)
        .all() as Array<{ delivery_id: string }>
      for (const row of running) this.finish(row.delivery_id, 'interrupted', 'host_restart', 'Codex host restarted before completion acknowledgement', finishedAt)
      return running.length
    })()
  }


}

let defaultStore: CodexDeliveryStore | null = null
export function getCodexDeliveryStore(): CodexDeliveryStore {
  if (!defaultStore) defaultStore = new CodexDeliveryStore()
  return defaultStore
}
