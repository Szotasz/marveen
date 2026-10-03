// A verdict nobody polls is the same silence in a new place.
//
// The VoiceMailAI backend checks its own schema at boot and publishes the
// result at GET /health/schema. These pin the fleet-side half: that `missing`
// alerts at once, that `unknown` does NOT alert on its own, and -- the case
// the card was actually written for -- that an endpoint which stays unknown
// for days DOES alert, because a permanently silent check is indistinguishable
// from a permanently healthy one.
//
// The staleness cases move a timestamp rather than waiting, and they sit ON
// the boundary: a value comfortably inside the window passes with or without
// the rule, which is how a broken threshold survives its own test.

import { describe, it, expect } from 'vitest'
import {
  parseSchemaProbe,
  decideSchemaVerdict,
  nextSchemaWatchState,
  formatSchemaAlert,
  SCHEMA_UNKNOWN_STALE_MS,
  type SchemaProbe,
  type SchemaWatchState,
} from '../web/schema-watch.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

function decide(
  probe: SchemaProbe,
  over: { lastMeaningfulAt?: number | null; watchingSince?: number | null; now?: number } = {},
) {
  return decideSchemaVerdict({
    probe,
    lastMeaningfulAt: over.lastMeaningfulAt ?? null,
    watchingSince: over.watchingSince ?? null,
    now: over.now ?? NOW,
    staleAfterMs: SCHEMA_UNKNOWN_STALE_MS,
  })
}

// The shape below is the one measured against production on 2026-09-07:
// {"state":"ok","summary":"schema complete","missing_tables":[],"missing_columns":[]}
const OK_BODY = { state: 'ok', summary: 'schema complete', missing_tables: [], missing_columns: [] }

describe('parseSchemaProbe', () => {
  it('reads the production ok payload as ok', () => {
    const probe = parseSchemaProbe(200, OK_BODY, JSON.stringify(OK_BODY))
    expect(probe.state).toBe('ok')
    expect(probe.summary).toBe('schema complete')
  })

  it('reads a missing payload and carries its lists through untouched', () => {
    // This shape comes from the backend's own tests, not from a live
    // observation, so nothing here rewrites or re-orders it.
    const body = {
      state: 'missing',
      summary: 'missing tables: app_sessions; missing columns: email_accounts.provider_account_id',
      missing_tables: ['app_sessions'],
      missing_columns: ['email_accounts.provider_account_id'],
    }
    const probe = parseSchemaProbe(200, body, JSON.stringify(body))
    expect(probe.state).toBe('missing')
    expect(probe.missingTables).toEqual(['app_sessions'])
    expect(probe.missingColumns).toEqual(['email_accounts.provider_account_id'])
  })

  it('treats a call that never completed as unknown, never as missing', () => {
    // Our own network being down says nothing about their database.
    const probe = parseSchemaProbe(0, null)
    expect(probe.state).toBe('unknown')
    expect(probe.missingTables).toEqual([])
  })

  it('treats a non-200 answer as unknown and names the status', () => {
    const probe = parseSchemaProbe(502, null, '<html>bad gateway</html>')
    expect(probe.state).toBe('unknown')
    expect(probe.summary).toContain('502')
    expect(probe.raw).toContain('bad gateway')
  })

  it('does not guess at an unrecognised state, and keeps the body verbatim', () => {
    // Only the `ok` shape has been seen in production. Anything else is
    // reported as-is for a human to read, rather than being flattened into a
    // verdict this file invented.
    const body = { state: 'degraded', summary: 'partial' }
    const probe = parseSchemaProbe(200, body, JSON.stringify(body))
    expect(probe.state).toBe('unknown')
    expect(probe.raw).toContain('degraded')
  })

  it('does not read a body without a state field as healthy', () => {
    const probe = parseSchemaProbe(200, { summary: 'schema complete' }, '{}')
    expect(probe.state).toBe('unknown')
  })
})

describe('decideSchemaVerdict', () => {
  const ok = parseSchemaProbe(200, OK_BODY)
  const missing = parseSchemaProbe(200, {
    state: 'missing',
    summary: 'missing tables: app_sessions',
    missing_tables: ['app_sessions'],
    missing_columns: [],
  })
  const unknown = parseSchemaProbe(0, null)

  it('stays silent on ok', () => {
    expect(decide(ok, { lastMeaningfulAt: NOW - DAY_MS })).toMatchObject({ verdict: 'ok', alert: false })
  })

  it('alerts immediately on missing', () => {
    expect(decide(missing, { lastMeaningfulAt: NOW - 1000 })).toMatchObject({ verdict: 'missing', alert: true })
  })

  it('does not alert on a single unknown', () => {
    // Mid-deploy, a network blip, a maintenance window. Paging here teaches
    // the reader to ignore this watcher.
    const d = decide(unknown, { lastMeaningfulAt: NOW - DAY_MS })
    expect(d).toMatchObject({ verdict: 'unknown-recent', alert: false })
    expect(d.unknownForMs).toBe(DAY_MS)
  })

  it('alerts once unknown has lasted the whole window', () => {
    // ON the boundary, not inside it: at exactly the threshold a rule that
    // compares with > instead of >= is still wrong, and only this input says so.
    const d = decide(unknown, { lastMeaningfulAt: NOW - SCHEMA_UNKNOWN_STALE_MS })
    expect(d).toMatchObject({ verdict: 'unknown-stale', alert: true })
  })

  it('stays quiet one millisecond before the boundary', () => {
    const d = decide(unknown, { lastMeaningfulAt: NOW - SCHEMA_UNKNOWN_STALE_MS + 1 })
    expect(d).toMatchObject({ verdict: 'unknown-recent', alert: false })
  })

  it('ages from when watching began when the endpoint has NEVER answered', () => {
    // The nastiest case: a URL that was wrong from the first day. With the
    // clock running only from the last meaningful answer, there would never be
    // one, and the watcher would stay silent for ever.
    const d = decide(unknown, { lastMeaningfulAt: null, watchingSince: NOW - SCHEMA_UNKNOWN_STALE_MS })
    expect(d).toMatchObject({ verdict: 'unknown-stale', alert: true })
  })

  it('does not alert on the very first reading of all', () => {
    // One reading is not a duration.
    expect(decide(unknown, { lastMeaningfulAt: null, watchingSince: null })).toMatchObject({
      verdict: 'unknown-recent',
      alert: false,
    })
  })

  it('prefers the last meaningful answer over the start of watching', () => {
    // Watching began long ago, but the endpoint answered an hour ago: that is
    // a healthy watcher having one bad reading, not a stale one.
    const d = decide(unknown, {
      lastMeaningfulAt: NOW - 60 * 60 * 1000,
      watchingSince: NOW - 30 * DAY_MS,
    })
    expect(d).toMatchObject({ verdict: 'unknown-recent', alert: false })
  })
})

describe('nextSchemaWatchState', () => {
  const ok = parseSchemaProbe(200, OK_BODY)
  const unknown = parseSchemaProbe(0, null)
  const base: SchemaWatchState = {
    lastMeaningfulAt: NOW - 10 * DAY_MS,
    watchingSince: NOW - 30 * DAY_MS,
    lastState: 'ok',
    alert: null,
  }

  it('advances the meaningful clock on ok', () => {
    expect(nextSchemaWatchState(base, ok, NOW, false).lastMeaningfulAt).toBe(NOW)
  })

  it('does NOT advance it on unknown', () => {
    // The whole staleness rule rests on this: if an unreachable endpoint
    // refreshed the clock, "unknown for days" could never be reached.
    expect(nextSchemaWatchState(base, unknown, NOW, false).lastMeaningfulAt).toBe(base.lastMeaningfulAt)
  })

  it('keeps the original watchingSince across runs', () => {
    expect(nextSchemaWatchState(base, unknown, NOW, false).watchingSince).toBe(base.watchingSince)
  })

  it('starts watching now when there is no prior state', () => {
    expect(nextSchemaWatchState(null, unknown, NOW, false).watchingSince).toBe(NOW)
  })

  it('records a sent alert so the cooldown has something to measure', () => {
    expect(nextSchemaWatchState(base, unknown, NOW, true).alert).toEqual({ lastSentAt: NOW, suppressed: 0 })
  })
})

describe('formatSchemaAlert', () => {
  it('names the missing tables and columns', () => {
    const probe = parseSchemaProbe(200, {
      state: 'missing',
      summary: 'missing tables: app_sessions',
      missing_tables: ['app_sessions'],
      missing_columns: ['email_accounts.provider_account_id'],
    })
    const text = formatSchemaAlert(decide(probe, { lastMeaningfulAt: NOW }), probe)
    expect(text).toContain('app_sessions')
    expect(text).toContain('email_accounts.provider_account_id')
  })

  it('says how long the silence has lasted, and shows the raw answer', () => {
    const probe = parseSchemaProbe(502, null, '<html>bad gateway</html>')
    const decision = decide(probe, { lastMeaningfulAt: NOW - 3 * DAY_MS })
    const text = formatSchemaAlert(decision, probe)
    expect(text).toContain('3 napja')
    expect(text).toContain('bad gateway')
  })
})
