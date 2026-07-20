// CostOps -- Codex / ChatGPT Plus rate-limit collector (LIVE, read-only, metadata-only).
//
// The Codex CLI (ChatGPT Plus auth) weekly rate-limit usage is read via the
// app-server JSON-RPC method `account/rateLimits/read` -- a pure METADATA read
// that consumes NO ChatGPT Plus quota (it is not a model turn). This is
// deliberately NOT `codex exec`, which would burn quota AND is an LLM call
// (forbidden anywhere in CostOps). The reader spawns `codex app-server` and
// speaks JSON-RPC over stdio. No secret, no LLM, no provider-side write. If the
// read fails or is unparseable, NO snapshot is written and limits.ts reports
// 'unknown' -- never a fabricated percentage.

import type Database from 'better-sqlite3'

export const CODEX_PROVIDER = 'codex'

export interface CodexRateLimit {
  usedPercent: number              // 0..100, primary (weekly) window
  windowDurationMins: number | null
  resetsAt: number | null          // epoch sec
  planType: string | null          // e.g. 'plus'
  limitId: string | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * PURE: parse the app-server `account/rateLimits/read` result into a snapshot,
 * or null if malformed. Accepts either the bare result ({rateLimits:{...}}) or a
 * result already narrowed to rateLimits.
 */
export function parseCodexRateLimit(raw: unknown): CodexRateLimit | null {
  const top = asRecord(raw)
  if (!top) return null
  const rl = asRecord(top.rateLimits) ?? asRecord((asRecord(top.result) ?? {}).rateLimits) ?? top
  const primary = asRecord(rl.primary)
  if (!primary) return null
  const usedPercent = numOrNull(primary.usedPercent)
  if (usedPercent === null) return null
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: numOrNull(primary.windowDurationMins),
    resetsAt: numOrNull(primary.resetsAt),
    planType: strOrNull(rl.planType),
    limitId: strOrNull(rl.limitId),
  }
}

// Injected reader -- tests pass a stub returning a fixture; the live reader
// spawns codex app-server. Keeps sync() fully offline-testable.
export type CodexRateLimitReader = () => Promise<unknown>

/**
 * LIVE reader: spawn `codex app-server`, JSON-RPC initialize + account/rateLimits/read
 * over stdio, resolve with the `result` of the rateLimits response. METADATA-ONLY:
 * consumes no ChatGPT Plus quota. Never logs anything (no tokens/secrets involved).
 */
export const readCodexRateLimitLive: CodexRateLimitReader = async () => {
  const { spawn } = await import('node:child_process')
  return await new Promise<unknown>((resolve, reject) => {
    const p = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let settled = false
    const done = (err: Error | null, val?: unknown) => {
      if (settled) return
      settled = true
      try { p.kill() } catch { /* already gone */ }
      if (err) reject(err)
      else resolve(val)
    }
    const timer = setTimeout(() => done(new Error('codex app-server timeout')), 20000)
    p.on('error', (e: Error) => { clearTimeout(timer); done(e) })
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as { id?: number; result?: unknown }
          if (o && o.id === 2 && o.result !== undefined) { clearTimeout(timer); done(null, o.result) }
        } catch { /* partial / non-JSON line */ }
      }
    })
    const send = (o: unknown) => { try { p.stdin.write(JSON.stringify(o) + '\n') } catch { /* pipe closed */ } }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'costops', version: '1' } } })
    setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: null }), 400)
  })
}

export interface RateLimitSnapshotRow { used_percent: number; resets_at: number | null; captured_at: number }

/**
 * PURE: forecast when the window will hit 100% (epoch sec), or null when the
 * input can't support a trustworthy extrapolation. Sums only used% RISES between
 * consecutive snapshots (a drop = a window reset, ignored -- same discipline as
 * DeepSeek's top-up-ignoring burn rate). Never fabricates a date.
 */
export function forecastCodexLimitExhaustion(snapsAsc: RateLimitSnapshotRow[], now: number): number | null {
  if (snapsAsc.length < 2) return null
  const spanSec = snapsAsc[snapsAsc.length - 1].captured_at - snapsAsc[0].captured_at
  if (spanSec < 3600) return null                       // < 1h of history is too noisy
  let rise = 0
  for (let i = 1; i < snapsAsc.length; i++) {
    const d = snapsAsc[i].used_percent - snapsAsc[i - 1].used_percent
    if (d > 0) rise += d
  }
  if (rise <= 0) return null                            // flat or only resets -> no exhaustion to project
  const perSec = rise / spanSec
  if (!isFinite(perSec) || perSec <= 0) return null
  const remaining = 100 - snapsAsc[snapsAsc.length - 1].used_percent
  if (remaining <= 0) return now
  const secsToFull = remaining / perSec
  if (!isFinite(secsToFull) || secsToFull < 0) return null
  return Math.floor(now + secsToFull)
}

function recordRun(db: Database.Database, status: string, count: number, now: number, errMsg: string | null): void {
  db.prepare(`INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status, imported_count, error_code, error_message_sanitized, data_freshness_at)
    VALUES ('codex','codex-ratelimit',@now,@now,@status,@count,@ec,@em,@now)`).run({
    now, status, count, ec: status === 'error' ? 'ratelimit_error' : null, em: errMsg,
  })
}

/**
 * LIVE read-only sync: read the Codex weekly rate-limit via the app-server
 * (metadata-only, ZERO quota), record a snapshot, record an import_runs row.
 * Injected reader/clock make it fully offline-testable. On any failure it writes
 * NO snapshot (limits.ts then reports 'unknown') and records a sanitized error.
 */
export async function syncCodexRateLimit(
  db: Database.Database,
  now: number,
  deps: { reader?: CodexRateLimitReader } = {},
): Promise<{ ok: boolean; provider: string; status: string; imported_count: number; used_percent?: number; error?: string }> {
  const { sanitizeError } = await import('./runner.js')
  const reader = deps.reader ?? readCodexRateLimitLive
  let snap: CodexRateLimit | null
  try {
    const raw = await reader()
    snap = parseCodexRateLimit(raw)
  } catch (err) {
    const s = sanitizeError(err)
    recordRun(db, 'error', 0, now, s.message)
    return { ok: false, provider: CODEX_PROVIDER, status: 'error', imported_count: 0, error: s.code }
  }
  if (!snap) {
    recordRun(db, 'error', 0, now, 'unparseable rateLimits result')
    return { ok: false, provider: CODEX_PROVIDER, status: 'error', imported_count: 0, error: 'parse_error' }
  }
  db.prepare(`INSERT INTO provider_ratelimit_snapshots (provider, limit_id, used_percent, window_duration_mins, resets_at, plan_type, captured_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    CODEX_PROVIDER, snap.limitId, snap.usedPercent, snap.windowDurationMins, snap.resetsAt, snap.planType, now,
  )
  recordRun(db, 'ok', 1, now, null)
  return { ok: true, provider: CODEX_PROVIDER, status: 'ok', imported_count: 1, used_percent: snap.usedPercent }
}
