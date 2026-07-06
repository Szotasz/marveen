import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { deriveMtdSpend, parseDeepSeekBalanceUsd, syncDeepSeekBalance } from '../costops/collectors/deepseek.js'

describe('deriveMtdSpend (pure)', () => {
  it('sums balance drops, ignoring top-ups (rises)', () => {
    // 10 -> 8 (drop 2) -> 12 (top-up, ignore) -> 9 (drop 3) => spend 5
    const snaps = [10, 8, 12, 9].map((b, i) => ({ balance: b, captured_at: i }))
    expect(deriveMtdSpend(snaps)).toBe(5)
  })
  it('is 0 for a single snapshot (baseline)', () => {
    expect(deriveMtdSpend([{ balance: 4.55, captured_at: 1 }])).toBe(0)
    expect(deriveMtdSpend([])).toBe(0)
  })
})

describe('parseDeepSeekBalanceUsd', () => {
  it('reads the USD total_balance from the /user/balance shape', () => {
    expect(parseDeepSeekBalanceUsd({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.55' }] })).toBe(4.55)
    expect(parseDeepSeekBalanceUsd({ balance_infos: [{ currency: 'CNY', total_balance: '30' }] })).toBe(30) // falls back to first
    expect(parseDeepSeekBalanceUsd(null)).toBe(0)
  })
})

describe('syncDeepSeekBalance (offline stub)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('records a snapshot + baseline line on first sync, then MTD spend on a later drop', async () => {
    const db = getDb()
    const t0 = Math.floor(Date.UTC(2026, 6, 5) / 1000)
    const bal = (v: string) => async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: v }] })
    // first sync: balance 5.00 -> baseline, spend 0
    const r1 = await syncDeepSeekBalance(db, t0, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('5.00') })
    expect(r1.ok).toBe(true)
    expect(r1.balance_usd).toBe(5)
    expect(r1.mtd_spend_usd).toBe(0)
    const line0 = db.prepare("SELECT billed_cost, confidence FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number; confidence: string }
    expect(line0.billed_cost).toBe(0)
    expect(line0.confidence).toBe('provider_api')

    // second sync later same month: balance dropped to 3.20 -> spend 1.80 usd -> 648 HUF
    const r2 = await syncDeepSeekBalance(db, t0 + 86400, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('3.20') })
    expect(r2.mtd_spend_usd).toBeCloseTo(1.8, 4)
    const line1 = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number }
    expect(line1.billed_cost).toBeCloseTo(1.8 * 360, 2) // idempotent upsert, single line
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='deepseek-api'").get() as { c: number }).c).toBe(1)
    // secret never in audit rows
    expect(JSON.stringify(db.prepare('SELECT * FROM import_runs').all())).not.toContain('"k"')
  })

  it('errors (no line) when the vault key is missing', async () => {
    const db = getDb()
    const r = await syncDeepSeekBalance(db, Math.floor(Date.now() / 1000), { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => ({}) })
    expect(r.ok).toBe(false)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='deepseek-api'").get() as { c: number }).c).toBe(0)
  })
})
