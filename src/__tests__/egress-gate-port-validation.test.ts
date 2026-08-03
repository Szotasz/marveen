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
// exercise the ALLOW/BLOCK decision instead.
//
// SUBPROCESS, deliberately (not `await import('.../egress-gate.mjs')`). `egress-gate.mjs` carries a
// `#!/usr/bin/env node` shebang because it also runs as a directly-invoked hook. On this toolchain
// (vitest 2.1.9 / vite 5.4.21 / Node v25.2.1) vite-node's SSR transform only blanks a leading shebang
// when the transformed output still starts with `#`; the isValidPort/DASHBOARD_PORT block changes
// esbuild's transform shape enough that the shebang line no longer stays first, so vite-node's dynamic
// `import()` throws `SyntaxError: Invalid or unexpected token` -- a vite-node collection artifact, not
// a defect in the hook. Spawning the file as a real child process sidesteps vite-node's transform
// entirely and exercises the exact code path production uses (JSON on stdin, WEB_PORT via env, an
// ALLOW/DENY decision on exit).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hooks', 'egress-gate.mjs')

/**
 * Run the hook exactly as the PreToolUse harness does: `tool_name`/`tool_input` JSON on stdin,
 * WEB_PORT via env. The hook always exits 0; it writes a deny payload to stdout only when blocking,
 * and writes nothing when allowing (see `allow()`/`deny()` in egress-gate.mjs).
 */
function runGate(port: string | undefined, url: string): 'ALLOW' | 'DENY' {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (port === undefined) delete env['WEB_PORT']
  else env['WEB_PORT'] = port
  const input = JSON.stringify({ tool_name: 'WebFetch', tool_input: { url } })
  const stdout = execFileSync(process.execPath, [HOOK_PATH], { env, input, encoding: 'utf8' })
  return stdout.trim() === '' ? 'ALLOW' : 'DENY'
}

describe('egress-gate dashboard-port validation (cards 266d8248, 417cf07a)', () => {
  it('documents WHY: an @ in the port makes the attacker host the real host', () => {
    // Not our code -- this pins the URL semantics the exploit relies on, so the intent of the
    // validation stays legible. It is documentation, NOT the regression guard.
    expect(new URL('http://localhost:3420@evil.com/').hostname).toBe('evil.com')
    expect(new URL('http://localhost:3420/').hostname).toBe('localhost')
  })

  it('BLOCKS a port that smuggles a host onto the built-in allowlist (the exploit)', () => {
    expect(runGate('3420@evil.com', 'http://localhost:3420@evil.com/steal')).toBe('DENY')
  })

  it('a rejected port cannot put a foreign host on the allowlist, and falls back to the default', () => {
    // Probe the actual risk: whatever the bad value is, no NEW origin may become reachable, and the
    // default port must still work. (Probing `http://localhost:<bad>/...` would be wrong -- e.g.
    // '3420/../' falls back to 3420 and then legitimately IS the dashboard.)
    for (const bad of ['3420 ', '80#x', '3420/../', 'evil.com', '3420@evil.com']) {
      expect(runGate(bad, 'http://evil.com/steal')).toBe('DENY')
      expect(runGate(bad, 'http://localhost:3420@evil.com/steal')).toBe('DENY')
      expect(runGate(bad, 'http://localhost:3420/api/agents')).toBe('ALLOW')
    }
  })

  it('does NOT over-correct: a legitimate configured port still reaches the dashboard', () => {
    // A validation that also broke the dashboard would just trade one outage for another.
    expect(runGate('8080', 'http://localhost:8080/api/kanban')).toBe('ALLOW')
    expect(runGate('8080', 'http://127.0.0.1:8080/api/kanban')).toBe('ALLOW')
  })

  it('a port that is NOT the configured one stays blocked', () => {
    expect(runGate('8080', 'http://localhost:3420/api/kanban')).toBe('DENY')
  })

  it('with WEB_PORT unset the default port is allowed', () => {
    expect(runGate(undefined, 'http://localhost:3420/api/agents')).toBe('ALLOW')
  })
})
