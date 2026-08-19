// GLOBAL SUITE GATE: refuse to run the test suite inside a LIVE install.
//
// 2026-07-27, one full-suite run in the production checkout: settings-store.test.ts
// rmSync'd the live store/config-overrides.json (dropping MAIN_AGENT_ISOLATED_CONFIG
// and ultimately 401-ing the main agent that evening), env.test.ts unlink+rewrote the
// live .env (mode 600 -> 644), and the auth suites pushed real break-glass Telegram
// alerts to the owner. Tests must only ever run from a worktree/CI checkout whose
// store/ carries no runtime state.
//
// Detection is marker-based, not path-based: a live install is recognized by the
// runtime artifacts only a running fleet produces. A fresh clone or worktree has
// none of them, so CI and PR-verify flows are unaffected. This is a HARD failure
// on purpose -- a silent skip would hide that someone is one `npm test` away from
// mutating production state (loaded via vitest `setupFiles`, so it gates every
// worker; per-file guards cannot be forgotten this way).
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const LIVE_MARKERS = [
  join('store', '.dashboard-token'),
  join('store', 'claudeclaw.db'),
  join('store', '.claude-oauth-token'),
]

const found = LIVE_MARKERS.filter((m) => existsSync(join(repoRoot, m)))
if (found.length > 0) {
  throw new Error(
    `REFUSING TO RUN TESTS: ${repoRoot} looks like a LIVE install (found: ${found.join(', ')}). ` +
      'The suite mutates files under the checkout it runs in (store/, .env, .claude/skills/). ' +
      // SUITERED807: this line used to suggest `/tmp/claw-test` -- but the
      // hook-path registration guard (isUnsafeHookCommand) rightly rejects any
      // /tmp-prefixed PROJECT_ROOT, so from a /tmp checkout the four gate test
      // files go falsely red. The tool must not send its user to the one place
      // another of its own guards forbids.
      'Run it from a git worktree or CI checkout UNDER YOUR HOME (not /tmp!), e.g. ' +
      '`git worktree add ~/claw-test && cd ~/claw-test && npm test`. ' +
      'Not /tmp: the hook-path guard rejects /tmp-prefixed roots, so the gate tests would go falsely red there.',
  )
}
