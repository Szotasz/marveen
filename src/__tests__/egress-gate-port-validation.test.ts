// The dashboard port is interpolated into an allowlist PREFIX (`http://localhost:${PORT}/`), so an
// unvalidated value is an egress-gate BYPASS: `WEB_PORT=3420@evil.com` makes `localhost:3420` a URL
// userinfo section and evil.com the resolved HOST, putting an attacker-chosen origin on the built-in
// allowlist (Cybersec MEDIUM, card 266d8248; test rewritten per card 417cf07a).
//
// BEHAVIOURAL, deliberately. The first version of this file asserted against the FILE'S TEXT
// (readFileSync + regex). Cybersec demonstrated that a mutant which keeps every grepped string and
// adds one line -- `if (fromEnv) return fromEnv` after the validated read -- restores the exploit in
// full while all those assertions still pass. A source-grep measures the code's spelling: it goes
// green on a vulnerable mutant and red on a harmless rename. So the load-bearing assertions below
// call isEgressBlocked() and check the ALLOW/BLOCK decision instead.
//
// DASHBOARD_PORT is resolved at MODULE LOAD, so each case sets the env first, then vi.resetModules()
// + a dynamic import to get a freshly-resolved gate.
import { describe, it, expect, vi, afterEach } from 'vitest'

const NO_RUNTIME_LIST = { domains: [], prefixes: [] }

/** Load the gate with WEB_PORT set to `port` (or unset), resolved fresh at import time. */
async function gateWithPort(port: string | undefined) {
  if (port === undefined) delete process.env['WEB_PORT']
  else process.env['WEB_PORT'] = port
  vi.resetModules()
  // The hook is plain ESM JavaScript with no .d.ts, so TS cannot type the dynamic import; the shape
  // we rely on is asserted immediately below.
  // @ts-expect-error -- untyped .mjs hook, intentionally imported for a behavioural test
  const mod = (await import('../../scripts/hooks/egress-gate.mjs')) as unknown
  const gate = mod as { isEgressBlocked: (t: string, i: { url: string }, r?: unknown) => boolean }
  expect(typeof gate.isEgressBlocked).toBe('function')
  return gate
}
const blocked = async (port: string | undefined, url: string) =>
  (await gateWithPort(port)).isEgressBlocked('WebFetch', { url }, NO_RUNTIME_LIST)

afterEach(() => { delete process.env['WEB_PORT'] })

describe('egress-gate dashboard-port validation (cards 266d8248, 417cf07a)', () => {
  it('documents WHY: an @ in the port makes the attacker host the real host', () => {
    // Not our code -- this pins the URL semantics the exploit relies on, so the intent of the
    // validation stays legible. It is documentation, NOT the regression guard.
    expect(new URL('http://localhost:3420@evil.com/').hostname).toBe('evil.com')
    expect(new URL('http://localhost:3420/').hostname).toBe('localhost')
  })

  it('BLOCKS a port that smuggles a host onto the built-in allowlist (the exploit)', async () => {
    expect(await blocked('3420@evil.com', 'http://localhost:3420@evil.com/steal')).toBe(true)
  })

  it('a rejected port cannot put a foreign host on the allowlist, and falls back to the default', async () => {
    // Probe the actual risk: whatever the bad value is, no NEW origin may become reachable, and the
    // default port must still work. (Probing `http://localhost:<bad>/...` would be wrong -- e.g.
    // '3420/../' falls back to 3420 and then legitimately IS the dashboard.)
    for (const bad of ['3420 ', '80#x', '3420/../', 'evil.com', '3420@evil.com']) {
      expect(await blocked(bad, 'http://evil.com/steal')).toBe(true)
      expect(await blocked(bad, 'http://localhost:3420@evil.com/steal')).toBe(true)
      expect(await blocked(bad, 'http://localhost:3420/api/agents')).toBe(false)
    }
  })

  it('does NOT over-correct: a legitimate configured port still reaches the dashboard', async () => {
    // A validation that also broke the dashboard would just trade one outage for another.
    expect(await blocked('8080', 'http://localhost:8080/api/kanban')).toBe(false)
    expect(await blocked('8080', 'http://127.0.0.1:8080/api/kanban')).toBe(false)
  })

  it('a port that is NOT the configured one stays blocked', async () => {
    expect(await blocked('8080', 'http://localhost:3420/api/kanban')).toBe(true)
  })

  it('with WEB_PORT unset the default port is allowed', async () => {
    expect(await blocked(undefined, 'http://localhost:3420/api/agents')).toBe(false)
  })
})
