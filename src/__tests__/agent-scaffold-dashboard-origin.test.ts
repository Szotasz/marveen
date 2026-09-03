// Tests for the DASHBOARD_PUBLIC_URL -> dashboardOrigin resolution in agent
// scaffolding. Background: agents running on k3s PODs or any remote host must
// reach the dashboard at its public URL, not at localhost. The scaffold embeds
// curl examples into the generated CLAUDE.md; those must use the operator-
// configured public URL when set, and fall back to localhost:port otherwise.
//
// Two surfaces are covered:
//   1. resolveDashboardOrigin() -- the pure resolver exported from
//      agent-scaffold.ts (unit-testable without any config or I/O).
//   2. generateClaudeMd source -- source-level assertion that no literal
//      localhost:3420 URL leaks into the LLM prompt (which would bake a wrong
//      host into every agent CLAUDE.md on non-localhost deployments).
//   3. renderHeartbeatClaudeMd -- the pure heartbeat renderer already accepts
//      dashboardOrigin as part of its identity; these tests verify it emits the
//      public URL when supplied.
//   4. currentHeartbeatIdentity source -- the config-bound factory must delegate
//      to resolveDashboardOrigin so it picks up DASHBOARD_PUBLIC_URL.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveDashboardOrigin } from '../web/agent-scaffold.js'
import { renderHeartbeatClaudeMd, type HeartbeatIdentity } from '../web/heartbeat-agent-scaffold.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_SRC = join(__dirname, '..', 'web', 'agent-scaffold.ts')
const HEARTBEAT_SRC = join(__dirname, '..', 'web', 'heartbeat-agent-scaffold.ts')

// ---------------------------------------------------------------------------
// 1. resolveDashboardOrigin -- pure function, no config dependency
// ---------------------------------------------------------------------------
describe('resolveDashboardOrigin', () => {
  it('returns localhost URL when publicUrl is empty', () => {
    expect(resolveDashboardOrigin('', 3420)).toBe('http://localhost:3420')
  })

  it('uses the supplied public URL when set', () => {
    expect(resolveDashboardOrigin('https://marveen.example.com', 3420)).toBe('https://marveen.example.com')
  })

  it('strips a trailing slash from the public URL', () => {
    expect(resolveDashboardOrigin('https://marveen.example.com/', 3420)).toBe('https://marveen.example.com')
  })

  it('strips a trailing slash from a localhost fallback (non-standard port)', () => {
    // Defensive: the fallback template never produces a trailing slash, but
    // if port were somehow empty the .replace() still leaves the result sane.
    expect(resolveDashboardOrigin('', '4000')).toBe('http://localhost:4000')
  })

  it('does not strip a path prefix from the public URL', () => {
    // An operator might host the dashboard under a sub-path.
    expect(resolveDashboardOrigin('https://example.com/marveen', 3420)).toBe('https://example.com/marveen')
  })

  it('strips trailing slash even from a sub-path URL', () => {
    expect(resolveDashboardOrigin('https://example.com/marveen/', 3420)).toBe('https://example.com/marveen')
  })

  it('accepts a non-default port in the public URL', () => {
    expect(resolveDashboardOrigin('https://example.com:8443', 3420)).toBe('https://example.com:8443')
  })

  // --- AGENT_API_ORIGIN precedence -------------------------------------------
  // The agent-side origin answers a different question than the public URL:
  // "where does an AGENT reach the API from where it runs" vs "where does the
  // BROWSER reach the dashboard". On a single-host install behind NAT these
  // differ -- measured 2026-09-03: the public name was reachable from a phone
  // but not from the host itself (hairpin), so every generated curl example
  // pointed at a dead address.

  it('REGRESSION GUARD: an empty agent origin changes nothing (old behaviour)', () => {
    // This is the test that protects existing k3s/distributed installs: with
    // the key unset, the resolver must behave exactly as before the key existed.
    expect(resolveDashboardOrigin('https://marveen.example.com', 3420, '')).toBe('https://marveen.example.com')
    expect(resolveDashboardOrigin('', 3420, '')).toBe('http://localhost:3420')
  })

  it('the agent origin wins over the public URL when both are set', () => {
    expect(resolveDashboardOrigin('https://marveen.example.com', 3420, 'http://localhost:3420'))
      .toBe('http://localhost:3420')
  })

  it('the agent origin wins even with no public URL', () => {
    expect(resolveDashboardOrigin('', 3420, 'http://dashboard.internal:3420'))
      .toBe('http://dashboard.internal:3420')
  })

  it('strips a trailing slash from the agent origin too', () => {
    expect(resolveDashboardOrigin('', 3420, 'http://localhost:3420/')).toBe('http://localhost:3420')
  })

  it('supports an internal service name (k8s-style) as the agent origin', () => {
    expect(resolveDashboardOrigin('https://marveen.example.com', 3420, 'http://marveen-dashboard.default.svc:3420'))
      .toBe('http://marveen-dashboard.default.svc:3420')
  })

  it('defaults the third argument, so two-argument callers keep working', () => {
    // Existing call sites and tests pass two arguments; that must stay valid.
    expect(resolveDashboardOrigin('https://marveen.example.com', 3420)).toBe('https://marveen.example.com')
  })
})

// ---------------------------------------------------------------------------
// 2. agent-scaffold.ts source -- no literal localhost:3420 in generateClaudeMd
// ---------------------------------------------------------------------------
describe('generateClaudeMd prompt: no hardcoded localhost:3420', () => {
  const src = readFileSync(SCAFFOLD_SRC, 'utf-8')

  // Isolate only the generateClaudeMd function body to avoid flagging
  // other legitimate uses of localhost elsewhere in the same file.
  const fnStart = src.indexOf('export async function generateClaudeMd')
  expect(fnStart, 'generateClaudeMd not found in source').toBeGreaterThan(0)
  const fnEnd = src.indexOf('export async function generateSoulMd')
  expect(fnEnd, 'generateSoulMd terminator not found').toBeGreaterThan(fnStart)
  const fnBody = src.slice(fnStart, fnEnd)

  it('imports DASHBOARD_PUBLIC_URL from config', () => {
    expect(src).toMatch(/import\s*{[^}]*\bDASHBOARD_PUBLIC_URL\b[^}]*}\s*from\s*'\.\.\/config\.js'/)
  })

  it('does not contain the literal localhost:3420 URL in the prompt body', () => {
    // Any surviving literal would bake the wrong host into every scaffolded
    // agent on a non-localhost deployment.
    expect(fnBody).not.toContain('http://localhost:3420')
  })

  it('references dashboardOrigin in the memory API curl example', () => {
    expect(fnBody).toContain('${dashboardOrigin}/api/memories')
  })

  it('references dashboardOrigin in the daily-log API curl example', () => {
    expect(fnBody).toContain('${dashboardOrigin}/api/daily-log')
  })

  it('references dashboardOrigin in the schedules API curl example', () => {
    expect(fnBody).toContain('${dashboardOrigin}/api/schedules')
  })

  it('references dashboardOrigin in the inter-agent messages API curl example', () => {
    expect(fnBody).toContain('${dashboardOrigin}/api/messages')
  })

  it('defines dashboardOrigin using resolveDashboardOrigin, passing AGENT_API_ORIGIN', () => {
    // Ensures the fallback logic lives in one place (resolveDashboardOrigin),
    // not as an ad-hoc inline expression that could diverge from the heartbeat
    // scaffold. The third argument is what lets an operator state the
    // agent-side answer when it differs from the browser-side public URL.
    expect(src).toContain('resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT, AGENT_API_ORIGIN)')
  })

  it('imports AGENT_API_ORIGIN from config', () => {
    expect(src).toMatch(/import\s*{[^}]*\bAGENT_API_ORIGIN\b[^}]*}\s*from\s*'\.\.\/config\.js'/)
  })
})

// ---------------------------------------------------------------------------
// 3. renderHeartbeatClaudeMd with a public-URL dashboardOrigin
// ---------------------------------------------------------------------------
describe('renderHeartbeatClaudeMd: respects dashboardOrigin', () => {
  const BASE: HeartbeatIdentity = {
    ownerName: 'Nina',
    botName: 'Helios',
    mainAgentId: 'helios',
    storeDir: '/srv/app/store',
    dashboardOrigin: 'http://localhost:3420',
    calendarAccount: '',
    metricsScript: '/srv/app/scripts/heartbeat-metrics.sh',
  }

  it('uses a public URL when dashboardOrigin is set to one', () => {
    const id: HeartbeatIdentity = { ...BASE, dashboardOrigin: 'https://marveen.example.com' }
    const out = renderHeartbeatClaudeMd(id)
    expect(out).toContain('https://marveen.example.com/api/messages')
    expect(out).not.toContain('http://localhost:3420/api/messages')
  })

  it('falls back to localhost when dashboardOrigin is the localhost default', () => {
    const out = renderHeartbeatClaudeMd(BASE)
    expect(out).toContain('http://localhost:3420/api/messages')
  })

  it('emits no hardcoded hostname other than the dashboardOrigin host', () => {
    const id: HeartbeatIdentity = { ...BASE, dashboardOrigin: 'https://marveen.example.com' }
    const out = renderHeartbeatClaudeMd(id)
    // The only host that should appear in the output is the one we supplied;
    // no stale 'localhost' sneaks in alongside it.
    expect(out).not.toMatch(/http:\/\/localhost:\d+\/api\//)
  })
})

// ---------------------------------------------------------------------------
// 4. heartbeat-agent-scaffold.ts source -- currentHeartbeatIdentity delegates
// ---------------------------------------------------------------------------
describe('currentHeartbeatIdentity: delegates to resolveDashboardOrigin', () => {
  const src = readFileSync(HEARTBEAT_SRC, 'utf-8')

  it('imports DASHBOARD_PUBLIC_URL from config', () => {
    expect(src).toMatch(/DASHBOARD_PUBLIC_URL/)
  })

  it('imports resolveDashboardOrigin from agent-scaffold', () => {
    expect(src).toMatch(/resolveDashboardOrigin.*agent-scaffold/)
  })

  it('uses resolveDashboardOrigin for dashboardOrigin in currentHeartbeatIdentity', () => {
    // Grep the factory function body for the call.
    const fnStart = src.indexOf('export function currentHeartbeatIdentity')
    expect(fnStart).toBeGreaterThan(0)
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).toContain('resolveDashboardOrigin(DASHBOARD_PUBLIC_URL, WEB_PORT, AGENT_API_ORIGIN)')
  })

  it('does not hardcode localhost:PORT as a string literal in currentHeartbeatIdentity', () => {
    const fnStart = src.indexOf('export function currentHeartbeatIdentity')
    const fnEnd = src.indexOf('\n}', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    // The literal template would be: `http://localhost:${WEB_PORT}` -- that
    // belongs inside resolveDashboardOrigin now, not here.
    expect(fnBody).not.toContain('`http://localhost:')
  })
})
