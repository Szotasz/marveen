import { createHash } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILENAME, STORE_DIR } from './config.js'

export type NoticeStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'manual_review'
export interface Notice { notificationId: string; targetId: string; status: NoticeStatus; updatedAt: number }
export interface ChannelRecord {
  deliveryId: string; payload: string; internal: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  reviewState: 'manual_review' | null; attemptCount: number
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}

/** Separate durable journals for channel work and outbound notifications.
 * Unknown history is never promoted to queued. No external calls in this store. */
export class DeliveryRecoveryStore {
  private readonly db: Database.Database
  constructor(path: string = join(STORE_DIR, DB_FILENAME)) {
    this.db = new Database(path)
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codex_channel_deliveries (
        delivery_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, internal INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
        review_state TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS codex_notifications (
        notification_id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','manual_review')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
      );
    `)
  }
  close(): void { this.db.close() }
  getChannel(id: string): ChannelRecord | null {
    return (this.db.prepare('SELECT delivery_id AS deliveryId,payload,internal,status,review_state AS reviewState,attempt_count AS attemptCount FROM codex_channel_deliveries WHERE delivery_id=?').get(id) as ChannelRecord) ?? null
  }
  hasActiveChannels(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM codex_channel_deliveries WHERE status IN ('queued','running') LIMIT 1").get())
  }
  prepareChannel(item: any, knownUnstarted = false, now = Date.now()): ChannelRecord {
    const meta = item?.params?.meta
    const valid = meta?.chat_id && typeof item?.params?.content === 'string'
    const key = meta?.chat_id && meta?.message_id != null
      ? 'telegram:' + JSON.stringify([String(meta.chat_id), String(meta.message_id)])
      : 'legacy:' + (typeof item?.key === 'string' ? item.key : digest(canonical(item)))
    const id = digest(key)
    // Only new intake or a trustworthy versioned queue marker can prove no start.
    const safe = Boolean(knownUnstarted && valid)
    this.db.prepare(`INSERT OR IGNORE INTO codex_channel_deliveries
      (delivery_id,idempotency_key,payload,internal,status,review_state,queued_at)
      VALUES (?,?,?,?,?,?,?)`).run(id,key,canonical(item),item?.internal ? 1 : 0,
        safe ? 'queued' : 'interrupted',safe ? null : 'manual_review',now)
    return this.getChannel(id)!
  }
  claimChannel(internal: boolean, now = Date.now()): ChannelRecord | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT delivery_id FROM codex_channel_deliveries WHERE status='queued' AND internal=? ORDER BY queued_at,delivery_id LIMIT 1").get(internal ? 1 : 0) as {delivery_id: string} | undefined
      if (!row) return null
      const result = this.db.prepare("UPDATE codex_channel_deliveries SET status='running',started_at=?,attempt_count=attempt_count+1 WHERE delivery_id=? AND status='queued'").run(now,row.delivery_id)
      return result.changes ? this.getChannel(row.delivery_id) : null
    }).immediate()
  }
  finishChannel(id: string, status: 'completed' | 'failed' | 'interrupted', now = Date.now()): boolean {
    return this.db.prepare("UPDATE codex_channel_deliveries SET status=?,review_state=?,finished_at=? WHERE delivery_id=? AND status='running'").run(status,status === 'completed' ? null : 'manual_review',now,id).changes > 0
  }
  recoverChannels(now = Date.now()): number {
    return this.db.prepare("UPDATE codex_channel_deliveries SET status='interrupted',review_state='manual_review',finished_at=? WHERE status='running'").run(now).changes
  }
  prepareNotice(targetId: string, now = Date.now()): Notice {
    const id = digest('notice:' + targetId)
    // Old notified_at was stamped BEFORE send; never treat it as proof of success.
    const hasDeliveries = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_deliveries'").get()
    const old = hasDeliveries ? (this.db.prepare('SELECT notified_at FROM codex_deliveries WHERE delivery_id=?').get(targetId) as {notified_at: number | null} | undefined) : undefined
    this.db.prepare('INSERT OR IGNORE INTO codex_notifications (notification_id,target_id,status,created_at,updated_at,error_code) VALUES (?,?,?,?,?,?)').run(id,targetId,old?.notified_at != null ? 'manual_review' : 'pending',now,now,old?.notified_at != null ? 'legacy_unconfirmed_notice' : null)
    return this.getNotice(id)!
  }
  getNotice(id: string): Notice | null {
    return (this.db.prepare('SELECT notification_id AS notificationId,target_id AS targetId,status,updated_at AS updatedAt FROM codex_notifications WHERE notification_id=?').get(id) as Notice) ?? null
  }
  claimNotice(id: string, now = Date.now()): boolean {
    return this.db.prepare("UPDATE codex_notifications SET status='sending',updated_at=? WHERE notification_id=? AND status='pending'").run(now,id).changes > 0
  }
  finishNotice(id: string, status: 'sent' | 'failed' | 'manual_review', now = Date.now()): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE codex_notifications SET status=?,updated_at=? WHERE notification_id=? AND status='sending'").run(status,now,id).changes > 0
      if (changed && status === 'sent' && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_deliveries'").get()) {
        this.db.prepare('UPDATE codex_deliveries SET notified_at=? WHERE delivery_id=(SELECT target_id FROM codex_notifications WHERE notification_id=?)').run(now,id)
      }
      return changed
    })()
  }
  recoverNotices(now = Date.now()): number {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_deliveries'").get()) {
      const old = this.db.prepare('SELECT delivery_id FROM codex_deliveries WHERE notified_at IS NOT NULL').all() as Array<{delivery_id: string}>
      for (const row of old) this.prepareNotice(row.delivery_id, now)
    }
    return this.db.prepare("UPDATE codex_notifications SET status='manual_review',updated_at=?,error_code='restart_during_send' WHERE status='sending'").run(now).changes
  }
  listUnconfirmed(): Notice[] {
    return this.db.prepare("SELECT notification_id AS notificationId,target_id AS targetId,status,updated_at AS updatedAt FROM codex_notifications WHERE status IN ('failed','manual_review')").all() as Notice[]
  }
}

export async function sendDurableNotice(store: DeliveryRecoveryStore, id: string, send: () => Promise<void>): Promise<boolean> {
  if (!store.claimNotice(id)) return false
  try {
    await send()
    if (!store.finishNotice(id,'sent')) throw new Error('Notification completion lost ownership')
    return true
  } catch (error) {
    // A transport error may follow a successful external send. Never blindly retry.
    store.finishNotice(id,(error as {definitelyNotSent?: boolean})?.definitelyNotSent ? 'failed' : 'manual_review')
    throw error
  }
}
let defaultStore: DeliveryRecoveryStore | null = null
export function getDeliveryRecoveryStore(): DeliveryRecoveryStore {
  return defaultStore ??= new DeliveryRecoveryStore()
}
