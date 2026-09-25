// The main agent's config-dir decision, made ONCE and reported on the way past.
//
// WHAT THIS MODULE IS FOR (kanban card `guard-respawn-vak`). scripts/channels.sh
// shouts when the main agent comes up on the shared ~/.claude. Every other way
// the main session starts -- the nightly 03:00 respawn, the stage-3 recovery
// resume, the hard restart -- goes through tmux respawn-pane and never touches
// channels.sh, so none of them could shout. On 2026-08-04 that cost four hours
// of silence between 03:00 and 07:58: nothing was broken except the reporting,
// and the missing log line looked exactly like a healthy morning.
//
// WHY A BRANDED TYPE AND NOT A CALLBACK. The obvious fix is to hand
// buildMainSessionRespawnCmd a reporter function. It works, and it is what we
// first agreed -- but it leaves the failure mode this card is ABOUT still
// reachable: a new call site can pass a no-op and go quiet, and the only thing
// standing between us and that is a test that enumerates the known call sites.
// A hand-maintained list of callers is the same shape as the bug (a guard whose
// scope has to be remembered), so it was rejected deliberately.
//
// Instead, buildMainSessionRespawnCmd takes a MainConfigDecision, and the only
// way to obtain one in production is resolveMainConfigDecision(), which reports
// as it resolves. A caller cannot forget the guard, because it cannot build the
// argument without it. Forgetting becomes impossible; DELIBERATELY bypassing
// still is not -- a `as MainConfigDecision` cast or the test factory would do
// it -- but both are loud, greppable, and reviewable, which "I forgot" is not.
//
// THE RESIDUAL GAP, STATED RATHER THAN PAPERED OVER: one resolve could in
// principle be reused across several respawns, which would emit one trace for
// many launches. Nothing does that today; every call site resolves inline.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { createAgentMessage } from '../db.js'
import {
  ensureMainAgentIsolatedConfigDir,
  ensureMainAgentIsolatedConfigDirForRotatedToken,
  resolveMainAgentConfigDir,
  resolveMainAgentRotatedConfigDir,
  resolveMainAgentRotatedTokenSecretId,
  readMainSharedConfigState,
  mainSharedConfigTrigger,
  type MainSharedConfigTrigger,
} from './agent-process.js'

declare const MAIN_CONFIG_DECISION: unique symbol

/**
 * What the main agent's next launch will do about CLAUDE_CONFIG_DIR, plus the
 * verdict on whether that is worth shouting about. The brand is what makes this
 * unforgeable by accident -- see the module header.
 */
export type MainConfigDecision = {
  readonly [MAIN_CONFIG_DECISION]: true
  readonly isolatedConfigDir: string | null
  /** True when isolatedConfigDir came from resolveMainAgentConfigDir() (explicit)
   *  or resolveMainAgentRotatedConfigDir() (rotated) -- both carry their OWN
   *  .credentials.json, same as scripts/main-agent-isolated-config.mjs's
   *  `explicit`/`rotated` modes. The fleet token must NOT be injected on top of
   *  either: that would swap the dir's real login for the flotta's shared one,
   *  which is exactly the CLAUDEPLANWATCHDOG912 bug this field closes (a
   *  rotated plan silently reverting to the flotta identity on the next
   *  watchdog/keep-alive respawn, because this decision used to know only
   *  about the plain isolated dir). False for the generic credential-less
   *  isolated dir, which DOES need the token. */
  readonly ownCredentials: boolean
  /** Vault secret id for a token-mode rotated plan's CLAUDE_CODE_OAUTH_TOKEN,
   *  or null. Set only when ownCredentials is false and isolatedConfigDir is
   *  the generic flotta dir -- a token-mode plan shares that dir and swaps
   *  only which token gets exported. Never both this AND ownCredentials at
   *  once: a configDir-mode rotated plan sets ownCredentials, a token-mode one
   *  sets this. */
  readonly tokenSecretId: string | null
  readonly fleetToken: boolean
  readonly trigger: MainSharedConfigTrigger
}

/** The same file scripts/channels.sh writes to, on purpose: an operator looking
 *  into a silent-channel morning should find every launch path in ONE place.
 *  Resolved per call, not at module load: a path captured at import time is one
 *  a test can never redirect, and an untestable emitter is how we got here. */
const failuresLog = () => join(PROJECT_ROOT, 'store', 'channels-failures.log')
/** Suppresses only the MESSAGE, never the log line -- see noteState(). */
const warnStamp = () => join(PROJECT_ROOT, 'store', '.main-config-guard-warned')
const WARN_COOLDOWN_MS = 6 * 60 * 60 * 1000

const HU_ADVICE: Record<Exclude<MainSharedConfigTrigger, null>, string> = {
  'fleet-token-unused':
    '[GUARD] A fo agens most a KOZOS ~/.claude alol indult ujra, pedig van flotta setup-token (store/.claude-oauth-token). A MAIN_AGENT_ISOLATED_CONFIG nincs beallitva, ezert az auth a rotalodo megosztott credentialbol megy: ez lejarhat, 401-be all a TUI, es a csatorna NEMAN elerhetetlen lesz. Teendo: MAIN_AGENT_ISOLATED_CONFIG=1 beallitasa, majd a fo session ujrainditasa.',
  'isolation-lost':
    '[GUARD] A fo agens most a KOZOS ~/.claude alol indult ujra, pedig letezik izolalt config dir (.channels-config). A MAIN_AGENT_ISOLATED_CONFIG beallitas valoszinuleg elveszett (store/config-overrides.json torlodott es nincs .env kulcs). Az auth a rotalodo shared sessionbol megy, 401-veszely. Teendo: MAIN_AGENT_ISOLATED_CONFIG=1 visszaallitasa, majd a fo session ujrainditasa.',
}

function line(text: string): void {
  const ts = new Date().toLocaleString('sv-SE').replace('T', ' ')
  appendFileSync(failuresLog(), `${ts} ${text}\n`)
}

/** True at most once per WARN_COOLDOWN_MS. The hard restart can fire in a loop
 *  on a wedged session, and a notice per attempt would bury the first one --
 *  the same shape as the handoff-failure chain of 2026-08-10. */
function warnDueNow(): boolean {
  try {
    const prev = Number(readFileSync(warnStamp(), 'utf-8').trim())
    if (Number.isFinite(prev) && Date.now() - prev < WARN_COOLDOWN_MS) return false
  } catch { /* no stamp yet -> due */ }
  try { writeFileSync(warnStamp(), String(Date.now())) } catch { /* best effort */ }
  return true
}

/**
 * Writes the trace for this launch. A line goes out on EVERY launch, healthy or
 * not: scripts/channels.sh does the same unconditionally (its status line at
 * :477), and that is precisely what made the ABSENCE of a line evidence on
 * 2026-08-04. A guard that only writes when it is unhappy has an ambiguous
 * silence -- "nothing wrong" and "never ran" look identical -- which is the
 * condition this card exists to end.
 */
function noteState(d: Omit<MainConfigDecision, typeof MAIN_CONFIG_DECISION>): void {
  try {
    if (!d.trigger) {
      const mode = d.ownCredentials ? 'own-credential' : d.tokenSecretId ? `rotated-token(${d.tokenSecretId})` : 'isolated'
      line(d.isolatedConfigDir
        ? `main-agent respawn: ${mode} CLAUDE_CONFIG_DIR=${d.isolatedConfigDir}`
        : 'main-agent respawn: shared ~/.claude (no isolation configured, no fleet token) -- expected for a stock install')
      return
    }
    line(`main-agent respawn: WARN ${d.trigger} -- starting on SHARED ~/.claude`)
    if (!warnDueNow()) {
      line(`main-agent respawn: notice suppressed (a ${d.trigger} notice went out within the last 6h)`)
      return
    }
    createAgentMessage('respawn-guard', MAIN_AGENT_ID, HU_ADVICE[d.trigger])
  } catch (err) {
    // A guard must never be the reason a restart fails. Losing the trace is bad;
    // losing the session because the trace could not be written is worse.
    logger.warn({ err }, 'main-config guard: could not record the launch state (continuing)')
  }
}

/**
 * Resolve the main agent's config dir AND report what came out. The only
 * production source of a MainConfigDecision.
 */
export function resolveMainConfigDecision(): MainConfigDecision {
  // Same precedence as scripts/main-agent-isolated-config.mjs (the shell
  // respawners' single source of truth): an explicit dir is a deliberate,
  // permanent identity choice and wins outright; a rotated plan is the next
  // strongest, more specific signal than the generic flotta fallback. Only
  // ensureMainAgentIsolatedConfigDir() PROVISIONS anything on disk, so it is
  // deliberately the last one tried -- neither explicit nor rotated needs
  // (or should get) a freshly-provisioned credential-less dir.
  const explicit = resolveMainAgentConfigDir()
  const rotated = explicit ? null : resolveMainAgentRotatedConfigDir()
  const ownDir = explicit ?? rotated
  // A rotated TOKEN-mode plan carries no configDir of its own -- it shares the
  // generic isolated dir, so it is only worth checking once neither explicit
  // nor a rotated configDir already answered the question.
  const rotatedTokenSecretId = ownDir ? null : resolveMainAgentRotatedTokenSecretId()
  const resolvedDir = ownDir
    ?? (rotatedTokenSecretId ? ensureMainAgentIsolatedConfigDirForRotatedToken() : ensureMainAgentIsolatedConfigDir())
  const state = readMainSharedConfigState(resolvedDir)
  // isolatedDirExists is an INPUT to the verdict, not part of it: carrying it
  // along would invite a later reader to re-derive the trigger from the
  // decision and quietly disagree with mainSharedConfigTrigger.
  const d = {
    isolatedConfigDir: state.isolatedConfigDir,
    ownCredentials: ownDir != null,
    tokenSecretId: rotatedTokenSecretId,
    fleetToken: state.fleetToken,
    trigger: mainSharedConfigTrigger(state),
  }
  noteState(d)
  return d as MainConfigDecision
}

/**
 * A decision WITHOUT the reporting, for tests that are about the respawn command
 * string rather than the guard. Named so an assertion can forbid it in
 * production modules -- if this token appears under src/web/ outside this file,
 * somebody built a decision that never reported.
 */
export function mainConfigDecisionForTest(
  partial: Partial<Omit<MainConfigDecision, typeof MAIN_CONFIG_DECISION>> = {},
): MainConfigDecision {
  const isolatedConfigDir = partial.isolatedConfigDir ?? null
  const fleetToken = partial.fleetToken ?? false
  const ownCredentials = partial.ownCredentials ?? false
  const tokenSecretId = partial.tokenSecretId ?? null
  return {
    isolatedConfigDir,
    ownCredentials,
    tokenSecretId,
    fleetToken,
    trigger: partial.trigger ?? mainSharedConfigTrigger({ isolatedConfigDir, fleetToken, isolatedDirExists: false }),
  } as MainConfigDecision
}
