import { describe, it, expect } from 'vitest'
import { fromSubscriptions, fromDeepSeekBalance } from '../costops/limits.js'
import { deriveLifecycle, type SubscriptionsConfig } from '../costops/subscriptions.js'
import { initDatabase, getDb } from '../db.js'

// Card 2ed90db1: wiring real Claude Max/Pro weekly-limit % data into the subscription gauge.
const NOW = Math.floor(Date.UTC(2026, 6, 8, 19, 0, 0) / 1000) // 2026-07-08 21:00 CEST

function cfg(subs: Partial<SubscriptionsConfig['subscriptions'][number]>[]): SubscriptionsConfig {
  return { version: 1, subscriptions: subs.map(s => ({ id: 'x', name: 'X', provider: 'p', source: 's', status: 'active', amount_source: 'no_invoice_found', ...s })) as SubscriptionsConfig['subscriptions'] }
}

describe('costops limits: weekly usage-% snapshot (card 2ed90db1)', () => {
  it('emits a weekly_usage_pct entry from a usage_snapshot, percent converted to a 0..1 fraction', () => {
    const lc = deriveLifecycle(cfg([{
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active', next_renewal: '2026-07-20',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59', fable_pct: 0 },
    }]), NOW)
    const limits = fromSubscriptions(lc)
    const weekly = limits.find(l => l.limit_type === 'weekly_usage_pct')
    expect(weekly).toBeDefined()
    expect(weekly!.usage_pct).toBeCloseTo(0.19)
    expect(weekly!.status).toBe('ok') // below the 0.7 warning tier
    expect(weekly!.reset_date).toBe('Tue 08:59') // raw label, never a computed/parsed date
    expect(weekly!.sub_id).toBe('anthropic-max')
    expect(weekly!.current_usage).toBeNull() // no fabricated absolute ceiling
    expect(weekly!.limit_value).toBeNull()
  })

  it('a usage_snapshot with no renewal/cancellation date still emits its weekly_usage_pct entry (no early-continue bug)', () => {
    // Regression: fromSubscriptions used to `continue` the whole loop iteration when a
    // subscription had no paid_until/next_renewal, silently skipping the usage_snapshot entry
    // too. Claude Pro after re-activation is exactly this case (status active, no known next
    // renewal date, but a real usage_snapshot).
    const lc = deriveLifecycle(cfg([{
      id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', status: 'active',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 16, weekly_pct: 2, weekly_reset_label: 'Wed 06:00', fable_pct: 0 },
    }]), NOW)
    const limits = fromSubscriptions(lc)
    expect(limits.some(l => l.limit_type === 'subscription_renewal')).toBe(false) // honestly no renewal-date entry
    const weekly = limits.find(l => l.limit_type === 'weekly_usage_pct')
    expect(weekly).toBeDefined()
    expect(weekly!.usage_pct).toBeCloseTo(0.02)
    expect(weekly!.sub_id).toBe('claude-pro-google-play')
  })

  it('crossing 80% weekly usage escalates status to high-tier (critical stays below 90, blocked at 100)', () => {
    const lc = deriveLifecycle(cfg([{
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 50, weekly_pct: 85, weekly_reset_label: 'Tue 08:59' },
    }]), NOW)
    const weekly = fromSubscriptions(lc).find(l => l.limit_type === 'weekly_usage_pct')!
    expect(weekly.usage_pct).toBeCloseTo(0.85)
    expect(weekly.status).toBe('warning') // limits.ts's own tierForPct ladder: 0.7 warning / 0.9 critical / 1.0 blocked
  })

  it('two subscriptions sharing the same provider each get their own distinct sub_id', () => {
    const lc = deriveLifecycle(cfg([
      { id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active', usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59' } },
      { id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', status: 'active', usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 16, weekly_pct: 2, weekly_reset_label: 'Wed 06:00' } },
    ]), NOW)
    const rows = fromSubscriptions(lc).filter(l => l.limit_type === 'weekly_usage_pct')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.sub_id).sort()).toEqual(['anthropic-max', 'claude-pro-google-play'])
  })

  it('no usage_snapshot at all -> no weekly_usage_pct entry (never fabricated)', () => {
    const lc = deriveLifecycle(cfg([{ id: 'openai-chatgpt', name: 'ChatGPT Plus', provider: 'openai', status: 'active' }]), NOW)
    expect(fromSubscriptions(lc).some(l => l.limit_type === 'weekly_usage_pct')).toBe(false)
  })
})

// Card 7d086cd3 (F4, Muse WS-C design-fidelity): DeepSeek's prepaid balance is a raw native-
// currency number (USD), unlike every other limit_type here which either has no monetary
// current_usage/limit_value at all, or is a plain percentage -- the renderer's HUF-formatter was
// silently stamping "Ft" onto it, printing "3,17 HUF" for a ~$3.17 USD balance.
describe('costops limits: DeepSeek balance unit (card 7d086cd3, F4)', () => {
  it('no snapshots yet -> unknown status, unit null (not assumed USD before any data exists)', () => {
    initDatabase(':memory:')
    const db = getDb()
    const limits = fromDeepSeekBalance(db)
    expect(limits).toHaveLength(1)
    expect(limits[0].status).toBe('unknown')
    expect(limits[0].unit).toBeNull()
  })

  it('carries the real native currency from the snapshot row, never HUF-assumed', () => {
    initDatabase(':memory:')
    const db = getDb()
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',10,?)`).run(1000)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',3.17,?)`).run(2000)
    const limits = fromDeepSeekBalance(db)
    expect(limits).toHaveLength(1)
    expect(limits[0].unit).toBe('USD')
    expect(limits[0].current_usage).toBe(3.17)
    expect(limits[0].limit_value).toBe(10)
  })
})
