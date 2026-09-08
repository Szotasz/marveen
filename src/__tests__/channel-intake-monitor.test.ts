// A dead inbound pipe produces no event: nothing arrives, nothing errors, and
// the pane keeps rendering a connected plugin. Finy was deaf for five days in
// July 2026 and every existing check was satisfied the whole time.
//
// These tests pin the two positive signals that DO exist while the channel is
// deaf, so the detection never rests on an absence again:
//   1. getWebhookInfo.pending_update_count > 0 -- updates queued upstream that
//      nobody is fetching. Proof, not suspicion.
//   2. getMe answering ok:false -- the token itself is gone.
// Inbound silence alone stays a suspicion and must never alert on its own: an
// agent with nothing to do is legitimately silent for days.

import { describe, it, expect } from 'vitest'
import {
  parseIntakeProbe,
  decideIntakeVerdict,
  type IntakeProbe,
  type IntakeObservation,
} from '../web/channel-intake-monitor.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SILENCE_MS = 2 * DAY_MS
const NOW = 1_760_000_000_000

function probe(over: Partial<IntakeProbe> = {}): IntakeProbe {
  return { reachable: true, tokenOk: true, pendingUpdates: 0, webhookUrl: '', lastErrorMessage: null, ...over }
}

describe('parseIntakeProbe', () => {
  it('reads the pending update count out of a healthy getWebhookInfo body', () => {
    const r = parseIntakeProbe(200, {
      ok: true,
      result: { url: '', pending_update_count: 7, last_error_message: 'wrong response' },
    })
    expect(r).toEqual({
      reachable: true,
      tokenOk: true,
      pendingUpdates: 7,
      webhookUrl: '',
      lastErrorMessage: 'wrong response',
    })
  })

  it('parses the exact body a healthy live bot returned on 2026-09-06', () => {
    // Verbatim from getWebhookInfo against a running fleet agent's token.
    const r = parseIntakeProbe(200, {
      ok: true,
      result: { url: '', has_custom_certificate: false, pending_update_count: 0 },
    })
    expect(r.tokenOk).toBe(true)
    expect(r.pendingUpdates).toBe(0)
    expect(r.lastErrorMessage).toBeNull()
  })

  it('marks the token invalid when Telegram rejects it', () => {
    const r = parseIntakeProbe(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    expect(r.tokenOk).toBe(false)
    expect(r.reachable).toBe(true)
    expect(r.pendingUpdates).toBeNull()
  })

  it('reports unreachable (not token-invalid) when the HTTP call itself failed', () => {
    const r = parseIntakeProbe(0, null)
    expect(r.reachable).toBe(false)
    expect(r.tokenOk).toBe(true)
    expect(r.pendingUpdates).toBeNull()
  })
})

describe('decideIntakeVerdict', () => {
  it('stays silent while the channel is quiet but the intake is clean', () => {
    const d = decideIntakeVerdict({
      probe: probe(),
      prev: null,
      lastInboundAt: NOW - 5 * DAY_MS,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('quiet')
    expect(d.alert).toBe(false)
  })

  it('says ok when inbound arrived inside the silence window', () => {
    const d = decideIntakeVerdict({
      probe: probe(),
      prev: null,
      lastInboundAt: NOW - 60_000,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('ok')
    expect(d.alert).toBe(false)
  })

  it('does not alert on a single backlog reading -- one tick can catch a burst mid-fetch', () => {
    const d = decideIntakeVerdict({
      probe: probe({ pendingUpdates: 3 }),
      prev: null,
      lastInboundAt: NOW - 5 * DAY_MS,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('backlog-suspected')
    expect(d.alert).toBe(false)
  })

  it('alerts when the backlog is still there on the next tick and has not shrunk', () => {
    const prev: IntakeObservation = { at: NOW - 5 * 60_000, pendingUpdates: 3 }
    const d = decideIntakeVerdict({
      probe: probe({ pendingUpdates: 4 }),
      prev,
      lastInboundAt: NOW - 5 * DAY_MS,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('deaf-backlog')
    expect(d.alert).toBe(true)
  })

  it('alerts on a persistent backlog even when inbound is recent -- deafness is not a silence question', () => {
    const prev: IntakeObservation = { at: NOW - 5 * 60_000, pendingUpdates: 2 }
    const d = decideIntakeVerdict({
      probe: probe({ pendingUpdates: 2 }),
      prev,
      lastInboundAt: NOW - 60_000,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('deaf-backlog')
    expect(d.alert).toBe(true)
  })

  it('clears the suspicion when the poller drained the queue between ticks', () => {
    const prev: IntakeObservation = { at: NOW - 5 * 60_000, pendingUpdates: 9 }
    const d = decideIntakeVerdict({
      probe: probe({ pendingUpdates: 2 }),
      prev,
      lastInboundAt: NOW - 60_000,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('draining')
    expect(d.alert).toBe(false)
  })

  it('does not confirm a backlog from two readings taken in the same moment', () => {
    const prev: IntakeObservation = { at: NOW - 1_000, pendingUpdates: 3 }
    const d = decideIntakeVerdict({
      probe: probe({ pendingUpdates: 3 }),
      prev,
      lastInboundAt: NOW - 60_000,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('backlog-suspected')
    expect(d.alert).toBe(false)
  })

  it('alerts when the token stopped working', () => {
    const d = decideIntakeVerdict({
      probe: probe({ tokenOk: false, pendingUpdates: null }),
      prev: null,
      lastInboundAt: NOW - 60_000,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('token-invalid')
    expect(d.alert).toBe(true)
  })

  it('never alerts when our own side could not reach Telegram', () => {
    const d = decideIntakeVerdict({
      probe: probe({ reachable: false, pendingUpdates: null }),
      prev: null,
      lastInboundAt: NOW - 9 * DAY_MS,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('unreachable')
    expect(d.alert).toBe(false)
  })

  it('reports a missing ingestion timestamp as unknown, never as proven silence', () => {
    const d = decideIntakeVerdict({
      probe: probe(),
      prev: null,
      lastInboundAt: null,
      now: NOW,
      silenceThresholdMs: SILENCE_MS,
    })
    expect(d.verdict).toBe('unknown-inbound')
    expect(d.alert).toBe(false)
  })
})
