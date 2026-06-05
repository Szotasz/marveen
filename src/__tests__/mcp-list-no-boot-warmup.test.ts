// STRUCTURAL test — not BEHAVIORAL.
//
// The production invariant: startWebServer() MUST NOT call startMcpListChecker()
// at boot time (not even with a delay). Calling it spawns the Telegram plugin
// for a health-check, which 409-kills the live session-bridge process holding
// the same bot-token (observed: channel offline within 33s on every deploy,
// 2026-06-04).
//
// This test locks the invariant via source-text inspection of web.ts. A
// behavioral test would require fully mocking the http server, all 20+ sub-
// system starts, and module-load-time side effects -- the isolation cost is
// disproportionate to the value here. The source-scan is unambiguous: the
// function call either appears in the file or it doesn't.
//
// Mental-revert evidence: if you re-add `startMcpListChecker()` to web.ts,
// the `callCount` assertion below fails with "Expected 0, Received 1".
//
// Related: PR #269 addresses a different 409 source (runtime poller-flapping).
// These two fixes are complementary.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')
const webTsSrc = readFileSync(join(projectRoot, 'src', 'web.ts'), 'utf-8')

describe('mcp-list boot warmup removal (409 source A)', () => {
  it('web.ts does not call startMcpListChecker() at boot', () => {
    // Count actual call-sites (not import/comment references).
    // The call pattern is: startMcpListChecker() -- optionally preceded by
    // whitespace. We exclude the import line and comment lines.
    const lines = webTsSrc.split('\n')
    const callLines = lines.filter(l => {
      const trimmed = l.trimStart()
      // Skip import declarations and single-line comments
      if (trimmed.startsWith('import ')) return false
      if (trimmed.startsWith('//')) return false
      return /\bstartMcpListChecker\s*\(/.test(l)
    })
    expect(callLines.length).toBe(0)
  })

  it('startMcpListChecker is not imported in web.ts (dead import removed)', () => {
    // Confirm we cleaned up the now-unused import too.
    const importLines = webTsSrc.split('\n').filter(l =>
      l.startsWith('import') && l.includes('startMcpListChecker')
    )
    expect(importLines.length).toBe(0)
  })
})
