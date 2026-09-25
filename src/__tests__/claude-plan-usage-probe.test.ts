// Live per-plan usage probe: header parser, IO wrapper (fetch mocked -- never
// a real token or a real network call), observation mapping and the
// background-refresh throttle.
import { describe, it, expect, vi } from 'vitest'
import {
  parseUnifiedRateLimitHeaders,
  probePlanUsage,
  observationFromProbe,
  selectPlansToProbe,
  PROBE_MIN_INTERVAL_MS,
  type ProbeResult,
} from '../claude-plan-usage-probe.js'
import type { ClaudePlan } from '../web/claude-plans.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

// Obviously fake, but shaped like the real thing so a leak check is meaningful.
const FAKE_TOKEN = 'sk-ant-oat01-' + 'FAKEPROBETOKEN'.repeat(5)

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0)
const NOW_S = NOW / 1000

function headers(map: Record<string, string>): Headers {
  return new Headers(map)
}

const FULL = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.35',
  'anthropic-ratelimit-unified-5h-reset': String(NOW_S + 3600),
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.62',
  'anthropic-ratelimit-unified-7d-reset': String(NOW_S + 3 * 86400),
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
}

const EXHAUSTED = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '0.1',
  'anthropic-ratelimit-unified-5h-reset': String(NOW_S + 3600),
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '1.0',
  'anthropic-ratelimit-unified-7d-reset': String(NOW_S + 2 * 86400),
  'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
}

describe('parseUnifiedRateLimitHeaders', () => {
  it('parses a normal (allowed) response, fraction -> percent', () => {
    expect(parseUnifiedRateLimitHeaders(headers(FULL))).toEqual({
      fiveHour: { usedPercent: 35, resetsAt: NOW_S + 3600, status: 'allowed' },
      sevenDay: { usedPercent: 62, resetsAt: NOW_S + 3 * 86400, status: 'allowed' },
      overallStatus: 'allowed',
      representativeClaim: 'five_hour',
    })
  })

  it('parses an exhausted (429-style) response', () => {
    const u = parseUnifiedRateLimitHeaders(headers(EXHAUSTED))
    expect(u?.overallStatus).toBe('rejected')
    expect(u?.sevenDay).toEqual({ usedPercent: 100, resetsAt: NOW_S + 2 * 86400, status: 'rejected' })
    expect(u?.representativeClaim).toBe('seven_day')
  })

  it('returns null when no unified headers are present (no data != 0% used)', () => {
    expect(parseUnifiedRateLimitHeaders(headers({ 'content-type': 'application/json' }))).toBeNull()
  })

  it('drops a window missing its reset or carrying a non-numeric utilization', () => {
    const u = parseUnifiedRateLimitHeaders(headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-utilization': 'n/a',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_S),
    }))
    expect(u).toEqual({ fiveHour: null, sevenDay: null, overallStatus: 'allowed', representativeClaim: null })
  })
})

function fakeResponse(status: number, hdrs: Record<string, string>): Response {
  return new Response(status === 204 ? null : '{}', { status, headers: hdrs })
}

describe('probePlanUsage', () => {
  it('sends the token only in the Authorization header and returns parsed usage', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse(200, FULL))
    const r = await probePlanUsage(FAKE_TOKEN, { fetchImpl })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.usage.fiveHour?.usedPercent).toBe(35)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(String(init.body)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN)
  })

  it('429 -> rate_limited, still carrying the parsed (exhausted) usage', async () => {
    const r = await probePlanUsage(FAKE_TOKEN, { fetchImpl: async () => fakeResponse(429, EXHAUSTED) })
    expect(r).toMatchObject({ ok: false, error: 'rate_limited', httpStatus: 429 })
    expect(!r.ok && r.usage?.sevenDay?.usedPercent).toBe(100)
  })

  it('401 -> invalid_token, no usage', async () => {
    const r = await probePlanUsage(FAKE_TOKEN, { fetchImpl: async () => fakeResponse(401, {}) })
    expect(r).toEqual({ ok: false, error: 'invalid_token', message: 'Token rejected (401)', httpStatus: 401 })
  })

  it('200 without headers -> no_usage_headers', async () => {
    const r = await probePlanUsage(FAKE_TOKEN, { fetchImpl: async () => fakeResponse(200, {}) })
    expect(r).toMatchObject({ ok: false, error: 'no_usage_headers' })
  })

  it('a thrown fetch -> network, and the exception text (which could echo anything) is dropped', async () => {
    const r = await probePlanUsage(FAKE_TOKEN, {
      fetchImpl: async () => { throw new Error(`boom ${FAKE_TOKEN}`) },
    })
    expect(r).toEqual({ ok: false, error: 'network', message: 'Network error while probing' })
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN)
  })

  it('times out via AbortController -> network "timed out"', async () => {
    const fetchImpl = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const r = await probePlanUsage(FAKE_TOKEN, { fetchImpl, timeoutMs: 10 })
    expect(r).toEqual({ ok: false, error: 'network', message: 'Probe timed out' })
  })
})

describe('observationFromProbe', () => {
  const okResult: ProbeResult = {
    ok: true,
    httpStatus: 200,
    usage: parseUnifiedRateLimitHeaders(headers(FULL))!,
  }

  it('maps a successful probe into an ObservedPlanState incl. seven_day', () => {
    expect(observationFromProbe(okResult, undefined, NOW)).toEqual({
      observedAt: NOW,
      source: 'probe',
      windows: {
        five_hour: { usedPercent: 35, resetsAt: NOW_S + 3600, status: 'allowed' },
        seven_day: { usedPercent: 62, resetsAt: NOW_S + 3 * 86400, status: 'allowed' },
      },
      overallStatus: 'allowed',
      lastProbe: { at: NOW, ok: true },
    })
  })

  it('a failed probe keeps the previous numbers and only records the failure', () => {
    const prev = observationFromProbe(okResult, undefined, NOW - 3_600_000)
    const failed: ProbeResult = { ok: false, error: 'invalid_token', message: 'x', httpStatus: 401 }
    const next = observationFromProbe(failed, prev, NOW)
    expect(next.windows).toEqual(prev.windows)
    expect(next.observedAt).toBe(NOW - 3_600_000)
    expect(next.lastProbe).toEqual({ at: NOW, ok: false, error: 'invalid_token', httpStatus: 401 })
  })
})

function plan(id: string, mode: 'token' | 'dir' = 'token'): ClaudePlan {
  return {
    id,
    label: id,
    ...(mode === 'token' ? { tokenSecretId: `claude-plan-token-${id}` } : { configDir: `/opt/${id}` }),
    planType: 'personal',
    channelsAllowed: true,
  }
}

function state(over: Partial<ClaudePlansState> = {}): ClaudePlansState {
  return { activePlanByAgent: { main: 'a' }, plans: {}, ...over }
}

describe('selectPlansToProbe', () => {
  const ids = (ps: ClaudePlan[]) => ps.map((p) => p.id)

  it('single-plan install: probes nothing (zero behaviour change)', () => {
    expect(selectPlansToProbe({ plans: [plan('b')], state: state(), activeAgentId: 'main', nowMs: NOW })).toEqual([])
  })

  it('skips the active plan and configDir plans; probes never-checked token plans', () => {
    const r = selectPlansToProbe({
      plans: [plan('a'), plan('b'), plan('c', 'dir'), plan('d')],
      state: state(),
      activeAgentId: 'main',
      nowMs: NOW,
    })
    expect(ids(r)).toEqual(['b', 'd'])
  })

  it('throttles by the last check (observation or failed probe), 30 min', () => {
    const fresh = { observedAt: NOW - PROBE_MIN_INTERVAL_MS + 1000, source: 'probe', windows: {} }
    const stale = { observedAt: NOW - PROBE_MIN_INTERVAL_MS, source: 'probe', windows: {} }
    const failedRecently = { observedAt: 0, source: 'probe', windows: {}, lastProbe: { at: NOW - 60_000, ok: false, error: 'invalid_token' } }
    const r = selectPlansToProbe({
      plans: [plan('a'), plan('b'), plan('c'), plan('d')],
      state: state({ plans: { b: fresh, c: stale, d: failedRecently } }),
      activeAgentId: 'main',
      nowMs: NOW,
    })
    expect(ids(r)).toEqual(['c'])
  })
})
