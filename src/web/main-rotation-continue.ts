// 8c338dc4: the opt-in "continue" variant of the main agent's plan rotation
// (POST /api/claude-plans/rotate with "continue": true).
//
// The default rotation restarts the main session FRESH (hardRestartMarveenChannels).
// The continue variant restarts it through the existing --continue path
// (resumeMarveenSession: respawn-pane, the two reaps, the first-run-picker guard,
// the resume-summary modal, the identity and plugin follow-ups, the post-resume
// plugin guard), so the agent picks up the SAME conversation. The new plan's
// credentials still apply: the respawn command resolves CLAUDE_CONFIG_DIR and the
// token from the rotation state at respawn time, and the route writes that state
// before it restarts.
//
// Two things decide whether --continue can find that conversation, and both are
// checked BEFORE the route writes anything:
//   1. the CLAUDE_CONFIG_DIR must not change: --continue reads
//      <config dir>/projects/<encoded project>/. Every token-mode plan shares the
//      one generic isolated dir, so a token-to-token switch keeps it; a plan with
//      its own configDir does not, and --continue there would resume a stale
//      conversation of that dir, or nothing at all. Neither does a first plan
//      assignment without the fleet token: until then the main agent runs on the
//      shared ~/.claude, and the token-mode plan moves it to the isolated dir.
//   2. there must be a prior conversation in that dir: on an empty projects dir
//      claude exits at once (the same probe startAgentProcess makes for sub-agents).
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

export type ContinueBlockReason = 'config-dir-changes' | 'no-prior-session'
export type ContinueVerdict = { ok: true } | { ok: false; reason: ContinueBlockReason }

export function mainRotationContinueVerdict(input: {
  /** resolveMainAgentConfigDir(): an explicit MAIN_AGENT_CONFIG_DIR wins over any rotation, before and after. */
  explicitDir: string | null
  /** resolveMainAgentRotatedConfigDir(), read BEFORE the rotation state is written: the active plan's own configDir. */
  activeRotatedDir: string | null
  /** resolveMainAgentRotatedTokenSecretId() !== null, read BEFORE the write: the active plan is a token-mode plan. */
  activeIsTokenPlan: boolean
  /** hasFleetOauthToken(): with no active plan, the main agent has the isolated dir only with the fleet token. */
  fleetToken: boolean
  /** The target plan's own configDir; null for a token-mode plan. */
  targetConfigDir: string | null
  /** The generic isolated dir every token-mode plan shares (mainAgentSharedConfigDir()). */
  sharedDir: string
  /** The main session's working directory, whose encoding names the transcript dir. */
  projectRoot: string
  exists?: (path: string) => boolean
}): ContinueVerdict {
  // The dir now and the dir after the switch, in resolveMainConfigDecision()'s order (the route has
  // already required MAIN_AGENT_ISOLATED_CONFIG=1): the explicit dir, else the plan's own configDir,
  // else the shared isolated dir -- which, with no active plan, needs the fleet token; without it the
  // main agent runs on the shared ~/.claude (null), and no plan can keep that.
  const before = input.explicitDir ?? input.activeRotatedDir
    ?? (input.activeIsTokenPlan || input.fleetToken ? input.sharedDir : null)
  const after = resolve(input.explicitDir ?? input.targetConfigDir ?? input.sharedDir)
  if (before === null || resolve(before) !== after) return { ok: false, reason: 'config-dir-changes' }
  const exists = input.exists ?? existsSync
  const transcripts = join(after, 'projects', encodeClaudeProjectDir(input.projectRoot))
  if (!exists(transcripts)) return { ok: false, reason: 'no-prior-session' }
  return { ok: true }
}

export type ContinueRestartResult =
  | { ok: true; mode: 'continue' | 'fresh-fallback' }
  | { ok: false; mode: 'fresh-fallback'; error: string }

/**
 * The restart itself, with its steps injected so it can be tested without tmux
 * (channel-monitor.ts binds the real ones: restartMainForRotationContinue).
 * The consent stamp first, as hardRestartMarveenChannels does (FABLEFALL1): the
 * respawned claude boots from the same shared roots either way. When the resume
 * fails (e.g. the pane is gone) the fresh hard restart is the fallback: it still
 * lands on the new plan, only the conversation is not kept, and the result says so.
 */
export async function runMainContinueRestart(steps: {
  stampConsent: () => void
  resume: () => Promise<boolean>
  fresh: () => { ok: boolean; error?: string }
  warn: (message: string) => void
}): Promise<ContinueRestartResult> {
  try { steps.stampConsent() } catch { /* backstop handlers remain, as in hardRestartMarveenChannels */ }
  if (await steps.resume()) return { ok: true, mode: 'continue' }
  steps.warn('Claude plan rotation: the --continue resume failed, falling back to a fresh restart (the new plan still applies)')
  const r = steps.fresh()
  return r.ok
    ? { ok: true, mode: 'fresh-fallback' }
    : { ok: false, mode: 'fresh-fallback', error: r.error || 'Main agent restart failed' }
}
