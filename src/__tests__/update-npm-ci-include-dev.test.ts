import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// AUTOUPDNODEENV905 source guard. With NODE_ENV=production in the caller's
// environment `npm ci` defaults to omit=dev, which prunes the TypeScript
// compiler; the update build then fails, rolls back (reverting the freshly
// pulled update.sh too), and the install repeats the same failure on every
// run while the customer sees green (the old dist keeps serving). Measured
// live on 2026-09-05: five rollbacks over ten days on a customer install.
//
// The defense is two-layered and BOTH layers are load-bearing:
//   1. every `npm ci` inside update.sh carries --include=dev (final, but only
//      effective once the fixed script has arrived);
//   2. the dashboard spawn path deletes NODE_ENV from the child env, because
//      installs still running an OLD update.sh can only be healed by the
//      environment they are launched with.

const ROOT = join(__dirname, '..', '..')

describe('update path survives NODE_ENV=production (AUTOUPDNODEENV905)', () => {
  it('every npm ci in update.sh carries --include=dev', () => {
    const script = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    const ciLines = script.split('\n').filter((l) => /\bnpm ci\b/.test(l) && !l.trim().startsWith('#'))
    expect(ciLines.length).toBeGreaterThan(0)
    for (const line of ciLines) {
      // Error-message hints ("futtasd: npm ci") are prose, not invocations.
      if (/echo/.test(line)) continue
      expect(line, `npm ci without --include=dev: ${line.trim()}`).toContain('--include=dev')
    }
  })

  it('the dashboard update spawn deletes NODE_ENV from the child environment', () => {
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'updates.ts'), 'utf-8')
    const spawnIdx = route.indexOf("spawn('/bin/bash'")
    expect(spawnIdx).toBeGreaterThan(-1)
    const before = route.slice(Math.max(0, spawnIdx - 600), spawnIdx)
    expect(before).toContain("delete updateEnv['NODE_ENV']")
  })
})
