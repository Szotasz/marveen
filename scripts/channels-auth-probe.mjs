#!/usr/bin/env node
// Independent backstop auth-dead probe for scripts/channel-watchdog.sh (PLAN.md
// GAP 2b, 2026-07-23 marveen-channels silent outage). Reads captured pane text
// from stdin (not argv -- pane content can contain shell-hostile characters),
// dynamically imports dist/web/reauth-detect.js so there is a single source of
// truth for the marker regexes (reauth-healer.ts uses the same function), and
// reports whether the pane shows a genuine dead-token marker.
//
// Contract (consumed by channel-watchdog.sh):
//   exit 0, no stdout  -- healthy, OR needsReauth but it's the first-run-gate
//                          family (out of scope for this arm -- reauth-healer
//                          escalate-only already owns that case; a respawn here
//                          would just interrupt the picker mid-flow).
//   exit 1, stdout "DEAD:<reason>" -- a genuine dead-token marker was found.
//
// Fail-open: any internal error (missing dist build, stdin read failure, bad
// pane text) exits 0. A probe failure must never masquerade as "confirmed
// dead" and trigger a respawn -- mirrors ensureMainAgentIsolatedConfigDir /
// provisionIsolatedConfigDir's own best-effort-never-a-launch-failure stance.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same first-run-gate family reauth-healer.ts's isFirstRunGate check matches
// (checkSession(): /onboarding picker|sign-in screen/i against reauth.reason).
// Out of scope for this arm: PLAN.md GAP 2b explicitly scopes the watchdog's
// new auth-dead signal to genuine dead-token markers only.
const FIRST_RUN_GATE_RX = /onboarding picker|sign-in screen/i

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const projectRoot = join(__dirname, '..')

  const paneText = await new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })

  const { detectReauthNeeded } = await import(join(projectRoot, 'dist', 'web', 'reauth-detect.js'))
  const result = detectReauthNeeded(paneText)

  if (!result.needsReauth) return
  if (FIRST_RUN_GATE_RX.test(result.reason ?? '')) return

  process.stdout.write(`DEAD:${result.reason ?? 'auth failure'}\n`)
  process.exitCode = 1
}

main().catch(() => {
  // Fail-open: never treat an internal error as "confirmed dead".
  process.exitCode = 0
})
