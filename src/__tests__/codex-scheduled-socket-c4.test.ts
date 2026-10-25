import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { CodexDeliveryStore, scheduledCodexIdentity } from '../codex-delivery.js'
import { acceptScheduledDelivery } from '../codex-channel-scheduled-delivery.js'
import { DeliveryRecoveryStore } from '../codex-recovery.js'
import { channelApprovalSettings } from '../../scripts/lib/codex-channel-approvals.mjs'

const roots: string[] = []
const stores: CodexDeliveryStore[] = []
const recoveryStores: DeliveryRecoveryStore[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-c4-'))
  roots.push(root)
  const dbPath = join(root, 'delivery.sqlite3')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL, completed_at INTEGER, outcome TEXT)')
  db.close()
  const store = new CodexDeliveryStore(dbPath)
  stores.push(store)
  return { root, dbPath, store }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const store of recoveryStores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const input = { type: 'scheduled_delivery' as const, taskId: 'daily-report', agentId: 'marveen', scheduledOccurrence: 1_800_000,
  prompt: 'synthetic prompt', queuedAt: 1_800_010, late: false }

describe('C4 scheduled socket delivery', () => {
  it('accepts an identical socket request once and remains idempotent after host restart', () => {
    const { dbPath, store, root } = fixture()
    const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
    const first = acceptScheduledDelivery(store, { ...input, ...identity })
    expect(first).toMatchObject({ ok: true, created: true, ...identity, scheduledOccurrence: input.scheduledOccurrence })
    expect(acceptScheduledDelivery(store, { ...input, ...identity })).toMatchObject({ ok: true, created: false, ...identity })
    store.close()
    const restarted = new CodexDeliveryStore(dbPath)
    stores.push(restarted)
    expect(acceptScheduledDelivery(restarted, { ...input, ...identity })).toMatchObject({ ok: true, created: false, ...identity, status: 'queued' })
    const claimed = restarted.claimQueued(identity.deliveryId)
    expect(claimed?.scheduledOccurrence).toBe(input.scheduledOccurrence)
    expect(restarted.claimQueued(identity.deliveryId)).toBeNull()
    restarted.finish(identity.deliveryId, 'completed')
    expect(acceptScheduledDelivery(restarted, { ...input, ...identity })).toMatchObject({ ok: true, created: false, status: 'completed' })
    expect(restarted.claimQueued(identity.deliveryId)).toBeNull()
    const db = new Database(dbPath)
    expect(db.prepare('SELECT COUNT(*) n FROM task_runs').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM codex_deliveries').get()).toEqual({ n: 1 })
    db.close()
    expect(['store/claudeclaw.db', 'store/claudeclaw.db-wal', 'store/claudeclaw.db-shm'].some(name => existsSync(join(root, name)))).toBe(false)
  })

  it.each(['failed', 'interrupted'] as const)('%s deliveries do not replay on duplicate socket requests', status => {
    const { store } = fixture()
    const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
    const queued = acceptScheduledDelivery(store, { ...input, ...identity })
    expect(queued.ok).toBe(true)
    store.claimQueued(identity.deliveryId)
    store.finish(identity.deliveryId, status, 'synthetic', 'synthetic')
    expect(acceptScheduledDelivery(store, { ...input, ...identity })).toMatchObject({ ok: true, created: false, status })
    expect(store.claimQueued(identity.deliveryId)).toBeNull()
  })

  it('keeps deliveryId deduplication intact across a foreground thread rotation', async () => {
    const rotationModulePath: string = '../../scripts/lib/codex-thread-rotation.mjs'
    const { rotateConversation } = await import(rotationModulePath)
    const { store, dbPath } = fixture()
    const channelStore = new DeliveryRecoveryStore(dbPath)
    recoveryStores.push(channelStore)
    const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
    const before = acceptScheduledDelivery(store, { ...input, ...identity })
    expect(before).toMatchObject({ ok: true, created: true })
    const queuedChannel = channelStore.prepareChannel({key: 'synthetic-pending-chat-message', params: {meta: {chat_id: 'owner', message_id: 'later-message'}, content: 'synthetic queued message'}}, true)
    let state: any = { threads: { owner: 'thread-before' }, pending: [], completedKeys: [], rotationRequest: { id: 'rotation-cmd', chatId: 'owner', mode: 'clear', reason: 'manual-clear' } }
    await rotateConversation({
      getState: () => state,
      setState: (next: any) => { state = next },
      chatId: 'owner', request: state.rotationRequest,
      inspect: async () => ({ bytes: 10, completedTurns: 1, createdAt: new Date().toISOString() }),
      summarize: async () => { throw new Error('clear does not summarize') },
      createThread: async () => 'thread-after', persist: () => {},
    })
    expect(state.threads.owner).toBe('thread-after')
    expect(acceptScheduledDelivery(store, { ...input, ...identity })).toMatchObject({ ok: true, created: false, ...identity })
    expect(channelStore.claimChannel(false)?.deliveryId).toBe(queuedChannel.deliveryId)
    expect(store.claimQueued(identity.deliveryId)?.deliveryId).toBe(identity.deliveryId)
    expect(store.claimQueued(identity.deliveryId)).toBeNull()
  })

  it('rejects mismatched identity, missing occurrence, and display names as agent ids', () => {
    const { store } = fixture()
    const identity = scheduledCodexIdentity(input.taskId, input.agentId, input.scheduledOccurrence)
    expect(acceptScheduledDelivery(store, { ...input, deliveryId: 'c'.repeat(32), idempotencyKey: 'wrong' }).ok).toBe(false)
    expect(acceptScheduledDelivery(store, { ...input, scheduledOccurrence: undefined, ...identity } as never).ok).toBe(false)
    expect(acceptScheduledDelivery(store, { ...input, agentId: 'Major Attila', ...identity }).ok).toBe(false)
  })
})

describe('C4 approval policy', () => {
  it('keeps owner turns reviewable and background turns interaction-free', () => {
    expect(channelApprovalSettings({ internal: false })).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    expect(channelApprovalSettings({ internal: true })).toMatchObject({ approvalPolicy: 'never' })
  })

  it('wires owner requests through on-request review and scheduled work through the socket', () => {
    const bridge = readFileSync(join(process.cwd(), 'scripts/codex-channels.mjs'), 'utf8')
    const runner = readFileSync(join(process.cwd(), 'src/web/schedule-runner.ts'), 'utf8')
    expect(bridge).toMatch(/\.\.\.channelApprovalSettings\(\{ internal \}\)/)
    // Automatic foreground rotation is deliberately not wired into the live
    // bridge: the C5 implementation caused unbounded memory growth in
    // production. Owner turns still receive the explicit on-request approval
    // policy above, while rotation remains a separately tested helper.
    expect(bridge).not.toMatch(/createFreshThread/)
    expect(bridge).toMatch(/acceptScheduledDelivery\(deliveryStore, request\)/)
    expect(bridge).toMatch(/internal: false, params: \{meta: \{chat_id: owner/)
    expect(runner).toMatch(/sendCodexScheduledDelivery\(/)
    expect(runner).not.toMatch(/queueCodexScheduledTask\(/)
  })
})
