// Whether a CHANNEL-having agent may be relaunched with `--continue`
// (CONTRESUME922, narrowing approved by Marveen 2026-09-23, msg 28581).
//
// HISTORY: Claude Code 2.1.193 stopped re-initialising the `--channels` plugin
// MCP server on a `--continue` resume (no /mcp entry, no bun poller, no
// bot.pid -> a bot that is permanently deaf on its channel). Since then every
// channel agent was launched FRESH and paid with its whole conversation
// context on every restart.
//
// MEASURED 2026-09-23 on Claude Code 2.1.280 (three agents, one morning): a
// hand-launched `--continue` session brought the Telegram plugin up (tool
// schema loaded, bun grandchild, bot.pid rewritten), sent a REAL Telegram
// message from the resumed session (jumanji, message_id 23) and kept its
// context (probamcp and jumanji both remembered the previous round). The
// provider-key agent (deeper, DeepSeek) could NOT be measured because its key
// is an ephemeral launch-secret file that the stop removes: a resume of that
// launch command starts with an empty key (401). That is a mechanism, so it is
// a CODE condition here, not a comment.
//
// The three conditions of the approval:
//   1. the installed CLI is measured and >= 2.1.280 (below, or unmeasured: fresh);
//   2. the provider-key branch is excluded in code (usesLaunchSecret);
//   3. after a `--continue` launch the system verifies gates (b) bun poller and
//      (c) bot.pid within a window, and falls back to a fresh launch when they
//      do not appear -- a silently deaf channel agent costs more than a lost context.
import { compareVersions } from '../claude-cli-support.js'

/** The measured floor: the regression was observed on 2.1.193 and absent on 2.1.280. */
export const CONTINUE_MIN_CLI = '2.1.280'
/** How long a resumed session gets to bring its plugin up before the fresh fallback. */
export const CONTINUE_VERIFY_WINDOW_MS = 90_000
export const CONTINUE_VERIFY_INTERVAL_MS = 3_000

export interface ContinueDecisionInput {
  hasPriorSession: boolean
  fresh: boolean
  hasChannel: boolean
  isMainAgent: boolean
  /** The agent's channel provider type ('telegram', 'slack', ...). Only telegram was measured. */
  provider: string
  /** The launch command reads a provider key / API key from a launch-secret file (ephemeral). */
  usesLaunchSecret: boolean
  /** The launch exports the persistent fleet OAuth token (the measured auth path). */
  fleetTokenLaunch: boolean
  /** The channel plugin is loaded through mcp.json + tee instead of --channels (unmeasured path). */
  useMcpJsonForChannel: boolean
  /** Measured installed Claude Code version, null when unmeasured. */
  installedCli: string | null
}

export interface ContinueDecision { useContinue: boolean; reason: string }

/** Pure decision. Every "no" names its reason so the launch log says why a context was dropped. */
export function decideContinueFlag(i: ContinueDecisionInput): ContinueDecision {
  if (!i.hasPriorSession) return { useContinue: false, reason: 'no prior session to continue' }
  if (i.fresh) return { useContinue: false, reason: 'fresh launch requested' }
  if (!i.hasChannel) return { useContinue: true, reason: 'channel-less agent keeps its context' }
  if (i.isMainAgent) return { useContinue: false, reason: 'main agent lifecycle is service-managed; not in scope' }
  if (i.provider !== 'telegram') return { useContinue: false, reason: `provider '${i.provider}' not measured; only telegram was (CONTRESUME922)` }
  if (i.useMcpJsonForChannel) return { useContinue: false, reason: 'mcp.json+tee channel path not measured' }
  if (i.usesLaunchSecret) return { useContinue: false, reason: 'launch reads an ephemeral launch-secret (provider/API key); a resume starts without it (measured 401)' }
  if (!i.fleetTokenLaunch) return { useContinue: false, reason: 'launch is not on the fleet OAuth token path (the measured auth path)' }
  if (!i.installedCli) return { useContinue: false, reason: 'installed Claude Code version unmeasured' }
  if (compareVersions(i.installedCli, CONTINUE_MIN_CLI) < 0) return { useContinue: false, reason: `installed Claude Code ${i.installedCli} is below the measured floor ${CONTINUE_MIN_CLI}` }
  return { useContinue: true, reason: `telegram + fleet token + Claude Code ${i.installedCli} >= ${CONTINUE_MIN_CLI} (measured 2026-09-23)` }
}

export type ContinueVerifyOutcome = 'alive' | 'timeout'

/**
 * Condition 3: poll the plugin-liveness probe until it says 'alive' or the
 * window closes. 'unknown' (a failed ps) and 'down' both keep polling: only a
 * positive verdict ends the wait early. Injected clock/sleep for tests.
 */
export async function verifyContinueLaunch(deps: {
  probe: () => 'alive' | 'down' | 'unknown'
  windowMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<{ outcome: ContinueVerifyOutcome; polls: number; elapsedMs: number }> {
  const windowMs = deps.windowMs ?? CONTINUE_VERIFY_WINDOW_MS
  const intervalMs = deps.intervalMs ?? CONTINUE_VERIFY_INTERVAL_MS
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  let polls = 0
  for (;;) {
    polls += 1
    if (deps.probe() === 'alive') return { outcome: 'alive', polls, elapsedMs: now() - started }
    if (now() - started >= windowMs) return { outcome: 'timeout', polls, elapsedMs: now() - started }
    await sleep(intervalMs)
  }
}
