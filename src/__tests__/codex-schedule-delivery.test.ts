import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { CodexDeliveryStore, scheduledCodexIdempotencyKey } from '../codex-delivery.js'
import { DeliveryRecoveryStore } from '../codex-recovery.js'
import { codexDeliveryNeedsNotice } from '../web/schedule-runner.js'

const roots: string[] = []
const stores: CodexDeliveryStore[] = []

function fixture(): { path: string; store: CodexDeliveryStore; db: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'codex-delivery-'))
  roots.push(root)
  const path = join(root, 'test.sqlite3')
  const db = new Database(path)
  db.exec(`CREATE TABLE task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent TEXT NOT NULL,
    ts INTEGER NOT NULL, status TEXT NOT NULL, completed_at INTEGER, outcome TEXT
  )`)
  const store = new CodexDeliveryStore(path)
  stores.push(store)
  return { path, store, db }
}

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const input = {
  taskId: 'kanban-audit', agentId: 'marveen', scheduledOccurrence: 1_800_000,
  prompt: 'Run the audit', queuedAt: 1_800_020, late: false,
}

describe('scheduled Codex delivery lifecycle', () => {
  it('persists every identity and lifecycle field with the task run in one transaction', () => {
    const { store, db } = fixture()
    const { delivery, created } = store.prepare(input)
    expect(created).toBe(true)
    expect(delivery).toMatchObject({
      taskId: input.taskId, agentId: input.agentId, scheduledOccurrence: input.scheduledOccurrence,
      idempotencyKey: scheduledCodexIdempotencyKey(input.taskId, input.agentId, input.scheduledOccurrence),
      queuedAt: input.queuedAt, startedAt: null, finishedAt: null, status: 'queued',
      attemptCount: 0, errorCode: null, errorSummary: null,
    })
    expect(delivery.deliveryId).toMatch(/^[a-f0-9]{32}$/)
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(delivery.taskRunId) as Record<string, unknown>
    expect(run).toMatchObject({ name: input.taskId, agent: input.agentId, status: 'fired_codex' })
    db.close()
  })

  it('accepts an occurrence only once, including after a second store opens', () => {
    const { path, store, db } = fixture()
    const first = store.prepare(input)
    const secondStore = new CodexDeliveryStore(path)
    stores.push(secondStore)
    const second = secondStore.prepare({ ...input, prompt: 'changed prompt' })
    expect(second.created).toBe(false)
    expect(second.delivery.deliveryId).toBe(first.delivery.deliveryId)
    expect(second.delivery.prompt).toBe('Run the audit')
    expect((db.prepare('SELECT COUNT(*) n FROM task_runs').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('keeps a >30s running task active and closes a completed run exactly once', () => {
    const { store, db } = fixture()
    const { delivery } = store.prepare(input)
    expect(store.claimQueued(delivery.deliveryId, input.queuedAt + 100)).toMatchObject({
      status: 'running', attemptCount: 1,
    })
    expect(store.claimQueued(delivery.deliveryId, input.queuedAt + 200)).toBeNull()
    const running = store.get(delivery.deliveryId)!
    expect(codexDeliveryNeedsNotice(running, input.queuedAt + 31_000, 60_000)).toBe(false)
    expect(running.status).toBe('running')
    expect(store.finish(delivery.deliveryId, 'completed', null, null, input.queuedAt + 45_000)).toBe(true)
    expect(store.finish(delivery.deliveryId, 'completed', null, null, input.queuedAt + 46_000)).toBe(false)
    const run = db.prepare('SELECT outcome, completed_at FROM task_runs WHERE id = ?').get(delivery.taskRunId)
    expect(run).toEqual({ outcome: 'done', completed_at: input.queuedAt + 45_000 })
    db.close()
  })

  it.each(['failed', 'interrupted'] as const)('%s remains visible and cannot be claimed again', status => {
    const { store, db } = fixture()
    const { delivery } = store.prepare(input)
    store.claimQueued(delivery.deliveryId)
    expect(store.finish(delivery.deliveryId, status, 'worker_error', 'short summary')).toBe(true)
    expect(store.get(delivery.deliveryId)).toMatchObject({ status, attemptCount: 1, errorCode: 'worker_error' })
    expect(store.claimQueued(delivery.deliveryId)).toBeNull()
    expect(store.listQueued()).toEqual([])
    expect(store.listMonitorable().map(d => d.deliveryId)).toContain(delivery.deliveryId)
    expect(db.prepare('SELECT outcome FROM task_runs WHERE id = ?').get(delivery.taskRunId)).toEqual({ outcome: 'interrupted' })
    db.close()
  })

  it('recovers queued work across restart and marks an in-progress turn interrupted without replay', () => {
    const { path, store, db } = fixture()
    const queued = store.prepare(input).delivery
    const second = store.prepare({ ...input, scheduledOccurrence: input.scheduledOccurrence + 1 }).delivery
    store.claimQueued(second.deliveryId)
    store.close()
    const restarted = new CodexDeliveryStore(path)
    stores.push(restarted)
    expect(restarted.interruptRunning()).toBe(1)
    expect(restarted.get(queued.deliveryId)?.status).toBe('queued')
    expect(restarted.get(second.deliveryId)?.status).toBe('interrupted')
    expect(restarted.listQueued().map(d => d.deliveryId)).toEqual([queued.deliveryId])
    expect(restarted.claimQueued(second.deliveryId)).toBeNull()
    db.close()
  })

  it('a missing consumer leaves queued work waiting and alerts only once', () => {
    const { store, db } = fixture()
    const delivery = store.prepare(input).delivery
    expect(store.get(delivery.deliveryId)?.status).toBe('queued')
    const recovery = new DeliveryRecoveryStore(db.name)
    const notice = recovery.prepareNotice(delivery.deliveryId)
    expect(recovery.claimNotice(notice.notificationId)).toBe(true)
    expect(recovery.claimNotice(notice.notificationId)).toBe(false)
    recovery.close()
    expect(store.listQueued()).toHaveLength(1)
    expect(store.get(delivery.deliveryId)?.attemptCount).toBe(0)
    db.close()
  })

  it('finds a task run whose delivery record is missing and never invents a replay', () => {
    const { store, db } = fixture()
    db.prepare(`INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)`)
      .run('orphan-audit', 'marveen', 123, 'fired_codex')
    expect(store.listUnknownRuns()).toMatchObject([{ taskId: 'orphan-audit', agentId: 'marveen' }])
    expect(store.listQueued()).toEqual([])
    db.close()
  })

  it('rolls back the task run when delivery insertion fails', () => {
    const { store, db } = fixture()
    db.exec(`CREATE TRIGGER reject_codex_delivery BEFORE INSERT ON codex_deliveries
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
    expect(() => store.prepare(input)).toThrow('injected failure')
    expect((db.prepare('SELECT COUNT(*) n FROM task_runs').get() as { n: number }).n).toBe(0)
    db.close()
  })
})
