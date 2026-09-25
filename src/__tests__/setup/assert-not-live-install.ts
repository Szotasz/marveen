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
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isTmpRootedPath, TMP_ROOT_PREFIXES } from '../../web/tmp-root-prefixes.js'

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

// SECOND GATE, same file, same shape: refuse to run from a TRANSIENT root.
//
// The message below has warned about /tmp since SUITERED807 -- but only on the
// live-install branch, which is exactly the path a clean /tmp worktree never
// takes. From there the suite simply STARTED, and the hook/gate tests went red,
// with no hint why. On 2026-09-12 that produced nine red files and the reading
// "the develop branch is broken"; a paired counter-measurement (same file, same
// commit, two roots) settled it: 4 failed from /tmp, 16/16 green from home.
//
// The failure this prevents is a WRONG ANSWER, not a wrong action -- and a wrong
// answer about the shared baseline is worse than a refusal, because it is quiet
// and it spreads. So this is a hard failure too, and for the same reason as the
// live-install gate: a warning printed into a red wall of output is not a gate.
//
// Nothing automated runs from here: the only suite runners are the two CI
// workflows, both on a home-rooted checkout (measured 2026-09-12).
// DERIVED, never hardcoded. This file ships to every install, so a literal
// `/Users/<someone>/...` would be wrong on all but one machine -- and there is
// essentially no such literal left in non-test source. Building it from the running
// home makes it concrete on every machine, which is what the verify note on #1297
// actually asked for: a path the reader can paste, not an example to adapt.
// (Deriving it from the current checkout's NAME was the first attempt and was worse:
// from a scratchpad worktree it suggested `<home>/wt775-wt`, which is nobody's
// convention.)
const suggested = join(homedir(), 'claw-suite')

if (isTmpRootedPath(repoRoot)) {
  throw new Error(
    `REFUSING TO RUN TESTS: ${repoRoot} is on TRANSIENT storage (${TMP_ROOT_PREFIXES.join(', ')}). ` +
      'This is not about losing files: the hook-path registration guard deliberately rejects ' +
      'tmp-rooted hook commands, so the hook and gate test files would go FALSELY RED here, ' +
      'and a false red about the shared baseline is worse than no run at all. ' +
      `Run from a worktree UNDER YOUR HOME: \`git worktree add ${suggested} && cd ${suggested} && npm ci && npm test\`. ` +
      'Fleet agents: your scratchpad is tmp-rooted, so it is never a valid place to measure the suite.',
  )
}
