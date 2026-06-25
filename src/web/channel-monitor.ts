import { existsSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { execSync, execFileSync, spawn } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, BOT_NAME, CHANNEL_PROVIDER, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import {
  agentHasChannel,
  agentSessionName,
  capturePane,
  clearInputBuffer,
  dismissResumeSummaryModalIfPresent,
  isAgentRunning,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
  scheduleIdentitySetup,
} from './agent-process.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import {
  detectPaneState, decidePaneErrorAlert, detectsBlockingMenu, type PaneErrorAlertState, type PaneState,
  stuckInputSignature, decideStuckInputRecovery, parkedChannelInput,
  parkedInputText, shouldClearTruncatedPreamble,
  type StuckInputState, type StuckInputThresholds,
} from '../pane-state.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { notifyChannel } from '../notify.js'
import { getProvider, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { readLastIngestionTimestamp, TRANSCRIPT_DIR } from './inbound-probe.js'
import { shouldAutoRestartDownAgent, parseEtimeToSeconds } from './agent-restart-policy.js'
// getClaudePidForSession + hasChannelPluginAlive live in the shared liveness
// module so the standalone channel-coordinator reuses the exact same probe.
import { getClaudePidForSession, hasChannelPluginAlive } from '../channel-coordinator/liveness.js'
import { getDesiredAgents } from './agent-desired-state.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')

// How long the agent's claude process has been running. Returns -1 when it
// cannot be determined, which the restart policy treats as "do not restart".
function getProcessAgeMs(pid: number): number {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 3000, encoding: 'utf-8' })
    const secs = parseEtimeToSeconds(out)
    return secs < 0 ? -1 : secs * 1000
  } catch {
    return -1
  }
}

function resolveAgentProvider(name: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(name)
  if (perAgent === 'slack' || perAgent === 'telegram' || perAgent === 'discord') return perAgent
  return CHANNEL_PROVIDER
}

// --- Channel Plugin Health Monitor ---
// Detect when the channel plugin grandchild dies under a Claude session
// by walking the process tree. Agents recover via stop+start; for the
// main agent's channels session we can only alert + escalate, because
// killing it would terminate the live agent.

const agentDownSince: Map<string, number> = new Map()
const agentLastRestart: Map<string, number> = new Map()
// Consecutive watchdog restarts (keyed by agent name) that did NOT bring the
// plugin back up. Drives exponential back-off so a plugin that crashes on every
// launch (e.g. a broken third-party channel plugin) is not restarted on a fixed
// short cadence forever -- which restarts the WHOLE agent every few minutes and
// renders it unusable. Reset to 0 the moment the plugin is seen alive again.
const agentRestartFailures: Map<string, number> = new Map()
const AGENT_RESTART_GRACE_MS = 90_000
// Floor frequency for the backed-off restart: even a long-down plugin is still
// retried at least this often, in case an external fix brings it back.
const AGENT_MAX_RESTART_GRACE_MS = 60 * 60 * 1000 // 1h
// A freshly started agent can take well over the first-probe window to bring
// its channel plugin up (a large-context model launched with --continue spawns
// the plugin only after a slow session load). Never restart a process younger
// than this on a "plugin down" reading, or the watchdog crash-loops it.
const AGENT_STARTUP_GRACE_MS = 180_000
const PLUGIN_ALERT_DEDUP_MS = 30 * 60 * 1000

// Stuck channel-input recovery (MAIN session only). A channel notification
// delivered while Boss is busy can be parked as plain text at the ❯ prompt
// without being submitted ('typing' state) -- it wedges the session because
// skipIfBusy heartbeats read 'typing' as not-idle and Boss never processes
// the message. The parked text already carries the full
// <channel ... chat_id=...> block, so recovery only needs to get it SUBMITTED.
let mainStuckInput: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
// Same recovery, per sub-agent session (keyed by tmux session name). A channel
// message can be parked at a sub-agent's ❯ prompt exactly like the main one --
// the sub-agent then "doesn't respond" until manually restarted. Entries are
// dropped once the spell ends so this never grows unbounded.
const agentStuckInput: Map<string, StuckInputState> = new Map()
// Raw Enters tried before escalating to clear+re-inject. Enter is faithful
// (it submits the REAL buffer, no capture-truncation risk); re-inject is the
// fallback for a TUI that swallows the Enter in raw-mode.
const MAIN_STUCK_ENTER_ATTEMPTS = 2
const MAIN_STUCK_THRESHOLDS: StuckInputThresholds = {
  // Same text must stay parked this long before the first recovery action so a
  // turn about to submit on its own is not pre-empted (>=2 observations at the
  // 60s tick).
  confirmMs: 90_000,
  // One recovery action per ~tick.
  dedupMs: 45_000,
  // 2 Enters + up to 2 re-injects, then hold (logged).
  maxAttempts: 4,
}

// --- Stuck-input hard-restart escalation (reliable backstop) ---
// When the soft recovery above (Enter + clear+re-inject) is EXHAUSTED but the
// main channel input is STILL parked, the TUI is hard-wedged: a paste
// placeholder that Enter only expands (never submits), or a state where
// keystrokes no longer register. Soft recovery cannot win there; the only fix
// is a fresh claude process. Escalate to hardRestartMarveenChannels()
// (respawn-pane on Linux -- replaces ONLY the main pane's claude, the tmux
// server + every other agent session stay intact). Rate-limited + capped so a
// wedge a restart cannot clear never becomes a restart loop.
const STUCK_RESTART_MIN_INTERVAL_MS = 5 * 60 * 1000
const STUCK_RESTART_MAX_CONSECUTIVE = 3
let stuckRestartCount = 0
let lastStuckRestartAt = 0

// Pure decision for the stuck-input restart escalation.
//   'restart' -> soft recovery exhausted + input still parked + rate-limit ok
//   'alert'   -> restarts are not clearing the wedge (cap reached) -> surface once
//   'skip'    -> not wedged past soft recovery, rate-limited, or already alerted
export function decideStuckInputRestart(
  parked: boolean,
  attempts: number,
  maxAttempts: number,
  now: number,
  lastRestartAt: number,
  restartCount: number,
  minIntervalMs: number,
  maxConsecutive: number,
): 'restart' | 'alert' | 'skip' {
  if (!parked || attempts < maxAttempts) return 'skip'
  if (now - lastRestartAt < minIntervalMs) return 'skip'
  if (restartCount >= maxConsecutive) return restartCount === maxConsecutive ? 'alert' : 'skip'
  return 'restart'
}

// Session-agnostic stuck-input recovery: capture the pane, and if a channel
// notification is parked at the ❯ prompt, get it SUBMITTED (Enter-first, then
// clear + verbatim re-inject of the COMPLETE block). The gate fires ONLY for a
// parked <channel> block, so a human's own draft is never touched. Returns the
// next StuckInputState. Used for the main session AND every sub-agent session.
// Recover a channel/inter-agent message stranded at the ❯ prompt by getting it
// SUBMITTED. Tracks ANY parked input (stuckInputSignature), Enter-first, then
// escalates after MAIN_STUCK_ENTER_ATTEMPTS. Escalation has three safe paths:
//   1. a COMPLETE <channel> block -> clear + verbatim re-inject (chat_id-safe);
//   2. a truncated/stale safety preamble (no real opening tag) -> clear only,
//      NEVER re-inject (re-injecting it could let a later payload inherit a
//      stale trust preamble -- see shouldClearTruncatedPreamble);
//   3. SUB-AGENTS ONLY (allowPlainReinject): any other complete parked text
//      (e.g. an inter-agent notification) -> clear + re-inject the collapsed
//      text. A sub-agent's input box never holds a human draft, so this is
//      safe; the main session stays conservative (Enter / <channel>-only).
export function recoverStuckInputForSession(
  session: string,
  prev: StuckInputState,
  thresholds: StuckInputThresholds,
  allowPlainReinject: boolean,
): StuckInputState {
  const pane = capturePane(session)
  const sig = pane != null ? stuckInputSignature(pane) : null
  const decision = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)
  if (decision.recover && pane != null) {
    const attempt = decision.next.attempts
    const escalate = attempt > MAIN_STUCK_ENTER_ATTEMPTS
    const block = parkedChannelInput(pane)
    if (escalate && block != null && block.complete && block.block != null) {
      logger.warn({ session, chatId: block.chatId, attempt }, 'Stuck channel input -- escalating to clear + verbatim re-inject')
      try {
        clearInputBuffer(session)
        sendPromptToSession(session, block.block)
      } catch (err) {
        logger.warn({ err, session }, 'Stuck-input re-inject failed')
      }
    } else if (escalate && shouldClearTruncatedPreamble(pane)) {
      logger.warn({ session, attempt }, 'Stuck input -- truncated safety preamble, clearing buffer (no re-inject)')
      try {
        clearInputBuffer(session)
      } catch (err) {
        logger.warn({ err, session }, 'Stuck-input preamble clear failed')
      }
    } else if (escalate && allowPlainReinject && block == null) {
      const text = parkedInputText(pane)
      if (text != null) {
        logger.warn({ session, attempt }, 'Stuck input (non-channel) -- escalating to clear + re-inject parked text')
        try {
          clearInputBuffer(session)
          sendPromptToSession(session, text)
        } catch (err) {
          logger.warn({ err, session }, 'Stuck-input plain re-inject failed')
        }
      } else {
        try { execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 }) } catch { /* no-op */ }
      }
    } else {
      // Enter-first, and the truncation-guard fallback: if escalation was due
      // but the <channel> block looks incomplete, hold on Enter instead.
      const heldForTruncation = escalate && block != null && !block.complete
      logger.warn({ session, attempt, heldForTruncation }, 'Stuck input -- recovery Enter')
      try {
        execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      } catch (err) {
        logger.warn({ err, session }, 'Stuck-input recovery Enter failed')
      }
    }
  }
  return decision.next
}

// Periodic detached-channel-claude reap (CB6CF755 durable fix). The pane-
// attribution reaper (reapDetachedChannelClaudes) already runs at RESPAWN time
// (resumeMarveenSession + agent (re)start), but orphans that accumulate BETWEEN
// respawns -- a --continue respawn that failed to tear down its predecessor --
// linger until the next respawn happens to fire (the "5 orphans over 13 days"
// leak). Running the same reaper on a slow cadence here closes that gap. The
// reaper is fail-safe (no live panes resolved -> reaps nothing) and pane-
// guarded, so a live agent/main session can never be hit. Throttled so the
// ps/tmux snapshot is not taken on every 60s tick.
const DETACHED_REAP_INTERVAL_MS = 10 * 60 * 1000
// Initialised to load time so the first periodic reap fires ~10min after boot,
// letting startup settle (the respawn-time reap already covers boot itself).
let lastDetachedReapAt = Date.now()

// Pure: is it time to run the periodic reap again? Exported for test.
export function shouldRunPeriodicReap(lastAt: number, now: number, intervalMs: number): boolean {
  return now - lastAt >= intervalMs
}

// Per-session tracking for the wedged thinking-block error (a Claude
// session stuck returning `400 ... thinking blocks cannot be modified`
// on every prompt). detectPaneState() classifies such a pane as
// 'error'; the monitor alerts so the operator can reset it. Alert-only
// by design -- auto-reset would destroy the agent's working memory and a
// false positive must not nuke a healthy session.
const paneErrorState: Map<string, PaneErrorAlertState> = new Map()
// Must persist for at least two monitor ticks (60s interval) before the
// first alert, so a one-tick transient never reports. 30 min dedup
// matches the channel-plugin alert cadence. clearMs (5 min) keeps a
// spell alive across brief non-error blips (null capture, mid-flight
// busy) so a flapping but genuinely wedged session still alerts.
const PANE_ERROR_CONFIRM_MS = 120_000
const PANE_ERROR_DEDUP_MS = 30 * 60 * 1000
const PANE_ERROR_CLEAR_MS = 5 * 60 * 1000

// Per-session tracking for a session parked in a blocking interactive menu
// (the /mcp manager, a model/config picker, a permission dialog). Unlike the
// thinking-block error this IS auto-recovered: a single Escape pops the modal
// without touching the conversation, so it is non-destructive. Reuses the
// decidePaneErrorAlert state machine (treat its `alert` as "recover now") so a
// one-tick transient never fires and the Escape is not re-sent every tick.
// confirmMs keeps it to ~2 ticks (~1-2 min) before recovering; dedupMs throttles
// retries if the Escape did not take; clearMs survives brief capture blips.
const paneMenuState: Map<string, PaneErrorAlertState> = new Map()
const MENU_RECOVER_CONFIRM_MS = 45_000
const MENU_RECOVER_DEDUP_MS = 5 * 60 * 1000
const MENU_RECOVER_CLEAR_MS = 2 * 60 * 1000

type MarveenRecoveryStage = 'soft' | 'save' | 'resume' | 'hard' | 'gave_up'
interface MarveenDownState {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
  // Set once we've issued the diagnostic getUpdates probe for this down-cycle,
  // so we don't spam the upstream API every poll while recovery is running.
  conflictProbed?: boolean
}

const SAVE_WINDOW_MS = 60_000
const MARVEEN_DOWN_CONFIRM_MS = 120_000
let marveenSuspectFirstSeen: number | null = null
let marveenDownState: MarveenDownState | null = null

function getMainAgentProvider(): ChannelProviderType {
  return CHANNEL_PROVIDER
}

function softReconnectMarveen(): boolean {
  return attemptChannelMcpReconnect(MAIN_AGENT_ID).ok
}

function triggerMarveenMemorySave(): void {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik).`,
    'MOST mentsd el a Marveen memoriaba amit a kovetkezo sessionnek tudnia kell:',
    'aktiv feladatok (category hot), friss dontesek/preferenciak (warm), tanulsagok (cold).',
    'Hasznald: curl -s -X POST http://localhost:3420/api/memories ... (lasd CLAUDE.md).',
    'Ha kesz vagy, irj egy rovid napi naplo bejegyzest is a /api/daily-log-ra. Utana eleg.',
  ].join(' ')
  try {
    sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

// Read the main agent's configured model from .claude/settings.json so a
// soft resume passes --model explicitly, mirroring scripts/channels.sh. Without
// it the respawned session falls back to claude-code's built-in default and
// silently drifts off the model the user picked. Returns '' when unset.
function readConfiguredMainModel(): string {
  try {
    const settingsPath = join(PROJECT_ROOT, '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return ''
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const model = parsed?.model
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}

// Build the claude command used to (re)spawn the main channels session via
// `tmux respawn-pane`. Pure + exported so the contract test can LOCK the
// presence of the `$HOME/.bun/bin` PATH export (without it the respawned bun
// telegram bridge can't be found and the session comes up channel-less). The
// PATH and flags mirror scripts/channels.sh. `continueSession` resumes the
// prior conversation (stage-3 recovery) vs a clean start (hard restart).
//
// NOTE: inbound from `--channels` also goes through the allowlist at
// /etc/claude-code/managed-settings.json (allowedChannelPlugins); a plugin not
// listed there has its MCP notifications silently dropped. See channels.sh.
export function buildMainSessionRespawnCmd(opts: {
  claudePath: string
  pluginId: string
  model: string
  continueSession: boolean
}): string {
  return [
    'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    '&&', opts.claudePath,
    ...(opts.continueSession ? ['--continue'] : []),
    '--dangerously-skip-permissions',
    // Single-quote the model id so a value like `claude-opus-4-8[1m]` is not
    // glob-expanded by the shell that tmux respawn-pane spawns the command in.
    ...(opts.model ? ['--model', `'${opts.model}'`] : []),
    `--channels plugin:${opts.pluginId}`,
  ].join(' ')
}

// Exported so the stuck-tool-call-watcher recovers a wedged main session via
// this respawn-pane path (reap + `tmux respawn-pane -k --continue`) INSTEAD of
// the launchctl hard-restart. respawn-pane replaces only the claude process in
// the pane: it does NOT `tmux kill-session`, so an attached client is never
// kicked ([exited]) -- the #248 user-visible crash. It also runs the
// pane-attribution detached-claude reap first, breaking the orphan->409->freeze
// doom-loop that the launchctl path (channels.sh env-grep reap) never cleaned.
export function resumeMarveenSession(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    // Reap any orphan bun/node poller BEFORE we respawn. tmux respawn-pane -k
    // kills the parent claude process but leaves grandchild pollers running -
    // see channel-poller-reap.ts. Without this, the freshly-respawned
    // --continue session would race a still-alive poller for the same bot
    // token (409 Conflict on getUpdates).
    try {
      reapChannelOrphans(provider.type, PROJECT_ROOT)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: pre-respawn reap failed (continuing)')
    }

    // Also reap DETACHED main-session claudes. reapChannelOrphans (env-scan)
    // cannot see the main session: channels.sh launches it without a
    // *_STATE_DIR export, so neither the claude nor its bun poller match the
    // env needle, and bot.pid is never written. A --continue respawn that did
    // not tear down the prior claude leaves it detached (reparented to the tmux
    // server) with a live poller hammering the shared token. Pane attribution
    // spares the live session (this pane) and kills only the leftovers.
    // See project_channels_continue_respawn_leak.
    try {
      reapDetachedChannelClaudes({ tmuxPath: TMUX })
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: detached-claude reap failed (continuing)')
    }

    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: true,
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })

    // --continue replays the last conversation. When the prior session is large
    // (>200k tokens) Claude Code opens with a "Resume from summary" modal that
    // parks the prompt - the plugin never reaches inbound-ready and stage 3
    // silently times out into stage 4. The agent-process startup path already
    // dismisses this modal; we mirror it here for the resume path.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    // --continue replays the last conversation. When the prior session is
    // large (>200k tokens) Claude Code opens with a "Resume from summary"
    // modal that parks the prompt - the plugin never reaches the inbound-
    // ready state, detectPaneState stays 'unknown', and stage 3 silently
    // times out into stage 4. The agent-process startup path already dismisses
    // this modal; we do the same here so the resume path matches.
    try {
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    logger.warn({ provider: provider.type }, 'Marveen session respawned with --continue')
    // Re-establish /name on the brand-new claude process (the prior session's
    // identity is gone after respawn-pane; channels.sh sets it on a normal
    // start). /remote-control was dropped (the operator no longer uses it).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // channels.sh runs an /mcp+Up+Enter+Enter unlock probe after launching
    // the main session to revive a Failed/disabled channel plugin (#231/#232),
    // but THIS code path skips channels.sh entirely - tmux respawn-pane is
    // direct. Schedule the same probe in-process so the plugin doesn't get
    // stuck in `◯ disabled` after an in-process respawn (2026-06-01 18:55).
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    // Stamp the shared respawn timestamp so lastMainRespawnAt() sees this
    // respawn from any caller (down-cascade stage 3, stuck-tool-call-watcher,
    // external systemd-timer watchdog). Without it the watcher cannot defer
    // its own self-respawn-and-recheck within the post-respawn grace, which
    // produced the 2026-06-08 false-positive loop (13 respawns in 8h on
    // residual 3-4s counters left over from the prior respawn's TUI redraw).
    writeRespawnStamp()
    return true
  } catch (err) {
    logger.error({ err }, 'Marveen session respawn failed')
    return false
  }
}

// Grace history: 90s -> 150s -> 240s.
// 2026-06-01 16:31 incident: with the reap+modal-dismiss path landed,
// resumeMarveenSession respawned cleanly, but a >200k-token --continue
// session-load + plugin re-handshake exceeded the 150s window and stage 4
// fired anyway (context lost). Bumped to 240s so the slowest realistic
// large-context resume completes inside the window. The monitor polls every
// 60s, so the effective resolution rounds up to the next poll - 240s gives
// 3-4 polls' worth of slack before the hard restart escalates.
const RESUME_GRACE_MS = 240_000
let marveenLastHardRestart = 0
// Post-respawn cold-start grace. After ANY main-session respawn (keepalive
// fresh-respawn, stage-3 resume, or stage-4 hard restart) the new claude needs
// minutes to load its large context and complete the channel-plugin handshake.
// The 2026-06-01 480s outage was self-inflicted churn: a keepalive fresh-respawn
// at 17:59:20 was followed by a down-detect at 18:03 because this grace was only
// 120s -- it expired mid cold-start, so soft->save->resume->hard piled THREE
// restarts onto a session that was merely still booting. 6 min comfortably
// covers the slowest realistic cold start while staying under the 18-min
// keepalive-staleness net, so a session that is genuinely dead after a respawn
// is still caught by another path. Exported so the stuck-tool-call-watcher
// shares the same post-respawn grace (single source of truth).
export const MARVEEN_POST_RESPAWN_GRACE_MS = 360_000

/**
 * B2 fix: shared cross-path grace accessor.
 * Returns the wall-clock time (ms since epoch) of the most recent main-session
 * respawn, regardless of which path triggered it (keepalive or inbound-probe).
 * Both paths check this before firing so they cannot double-respawn within
 * KEEPALIVE_RESPAWN_GRACE_MS of each other.
 */
export function lastMainRespawnAt(): number {
  return Math.max(marveenLastKeepaliveRespawn, marveenLastHardRestart, fileRespawnStampMs())
}

// Cross-LAYER coordination with the independent systemd-timer watchdog
// (scripts/channel-watchdog.sh). That timer writes RESPAWN_STAMP_FILE (epoch
// SECONDS) when IT respawns; reading it here means an out-of-process respawn
// also suppresses this in-process watchdog for the grace window. Symmetrically,
// hardRestartMarveenChannels writes the same file so the timer defers to us.
// Best-effort: 0 if absent/garbage.
const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')
function fileRespawnStampMs(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0
  } catch {
    return 0
  }
}
function writeRespawnStamp(): void {
  try {
    writeFileSync(RESPAWN_STAMP_FILE, String(Math.floor(Date.now() / 1000)))
  } catch { /* best effort */ }
}

// --- Vanished-session recovery (self-healing main session) ---
//
// The down-cascade (handleMarveenDown) recovers a main session whose claude
// process is alive but whose channel plugin died, by replacing the claude
// process in the EXISTING pane via `tmux respawn-pane`. respawn-pane needs a
// live pane: it cannot bring back a session that has disappeared entirely
// (crash, self-update mid-restart, OOM kill, host reboot). On a deployment
// where nothing supervises the session -- marveen-channels.service disabled,
// or any pure-tmux install -- a vanished session stays gone, and because the
// scheduler skips every task whose target tmux session is missing
// (schedule-runner !sessionExists branch), ALL main-agent scheduled jobs
// (morning briefing, daily-log, dream-engine, audits, heartbeats) silently
// stop firing with no error surfaced anywhere. This closes that gap by
// recreating the session from scratch via the canonical scripts/channels.sh --
// the same path the service uses -- so recovery is channel-independent and
// works even with the service disabled.
const CHANNELS_SCRIPT = join(PROJECT_ROOT, 'scripts', 'channels.sh')
// channels.sh creates the session, runs the first-run dialog auto-accept, sets
// /name, and brings up the channel plugin -- a cold start that takes minutes.
// Throttle relaunches so a session that is still booting is not torn down and
// recreated on the next 60s poll.
const MAIN_SESSION_CREATE_GRACE_MS = 360_000
let marveenLastSessionCreate = 0

export function mainChannelsSessionExists(): boolean {
  try {
    execFileSync(TMUX, ['has-session', '-t', MAIN_CHANNELS_SESSION], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function createMainChannelsSession(): boolean {
  const now = Date.now()
  if (marveenLastSessionCreate && now - marveenLastSessionCreate < MAIN_SESSION_CREATE_GRACE_MS) {
    return false
  }
  if (!existsSync(CHANNELS_SCRIPT)) {
    logger.error({ script: CHANNELS_SCRIPT }, 'Cannot recreate main channels session: channels.sh missing')
    return false
  }
  try {
    // Detached + unref'd: channels.sh is a long-lived supervisor (it tails the
    // session in a wait loop), so it must outlive this check() tick without
    // keeping the dashboard event loop alive. stdio ignored -- channels.sh does
    // its own logging to store/channels-failures.log.
    const child = spawn('/bin/bash', [CHANNELS_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_ROOT,
    })
    child.unref()
    marveenLastSessionCreate = now
    // Fold into the shared cold-start grace so the down-cascade defers to this
    // boot instead of stacking a respawn on a session that is still coming up.
    writeRespawnStamp()
    logger.warn({ session: MAIN_CHANNELS_SESSION }, 'Main channels session absent -- recreating via channels.sh')
    sendAlert(`♻️ A ${MAIN_CHANNELS_SESSION} session eltunt -- ujrainditom (channels.sh). Enelkul minden utemezett feladat csendben kimaradna.`)
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to recreate main channels session via channels.sh')
    return false
  }
}

// Hard-restart fallback when there is no systemd unit to bounce: respawn the
// tmux pane with a FRESH claude (no --continue). Mirrors resumeMarveenSession
// but starts a clean session -- exactly what scripts/channels.sh does -- so a
// wedged plugin gets a brand-new process even on pure-tmux installs. Distinct
// from the stage-3 resume (which keeps --continue) by clearing session state.
function respawnMarveenSessionFresh(): boolean {
  const provider = getProvider(getMainAgentProvider())
  try {
    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: CLAUDE,
      pluginId: provider.pluginId,
      model: readConfiguredMainModel(),
      continueSession: false,
    })
    execFileSync(TMUX, ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn({ provider: provider.type }, 'Hard restart: marveen session respawned fresh (no --continue)')
    // Re-establish /name on the fresh process (see note in resumeMarveenSession).
    scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // Same channels.sh-bypass concern as in resumeMarveenSession: this respawn
    // path does NOT invoke channels.sh, so the post-init plugin unlock probe
    // (#231/#232) never runs. Wire it in-process so the keep-alive-watchdog
    // fresh-respawn path also revives a Failed/disabled plugin instead of
    // leaving the channel offline until manual intervention.
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    writeRespawnStamp() // coordinate with the systemd-timer watchdog (covers the keepalive path too)
    return true
  } catch (err) {
    logger.error({ err }, 'Fresh session respawn failed')
    return false
  }
}

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  // macOS: bounce the launchd job (its own process group -- safe).
  if (process.platform !== 'linux') {
    try {
      execFileSync('/bin/launchctl', ['unload', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
      execFileSync('/bin/launchctl', ['load', MAIN_CHANNELS_PLIST], { timeout: 5000 })
      logger.warn(`Hard restart: launchctl reload of com.${SERVICE_ID}.channels`)
      marveenLastHardRestart = Date.now()
      writeRespawnStamp() // coordinate with the systemd-timer watchdog
      return { ok: true }
    } catch (err) {
      logger.error({ err }, 'Hard restart failed (launchctl)')
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Linux: respawn-pane ONLY -- NEVER `systemctl --user restart`. The channels
  // unit (e.g. marveen-channels.service) runs with KillMode=control-group and
  // the shared tmux SERVER lives in its cgroup, so restarting the unit kills the
  // tmux server and with it EVERY agent session, not just the main one.
  // respawn-pane replaces only the claude process in the main channels pane,
  // leaving the server and all other sessions intact.
  if (respawnMarveenSessionFresh()) {
    marveenLastHardRestart = Date.now()
    return { ok: true }
  }
  return { ok: false, error: 'hard restart failed: tmux respawn-pane failed' }
}

// Escalate a main channel input that survived the full soft recovery to a hard
// restart (respawn-pane). Driven by the pure decideStuckInputRestart; this
// wrapper owns the I/O + counters. Called once per monitor tick right after the
// main stuck-input recovery.
function maybeRestartWedgedMainChannel(state: StuckInputState): void {
  const parked = state.parkedSig !== null
  // A cleared input box ends the spell -> reset the escalation counter so the
  // next genuine wedge starts fresh (and a successful restart is not penalised).
  if (!parked) { stuckRestartCount = 0; return }
  const action = decideStuckInputRestart(
    parked, state.attempts, MAIN_STUCK_THRESHOLDS.maxAttempts,
    Date.now(), lastStuckRestartAt, stuckRestartCount,
    STUCK_RESTART_MIN_INTERVAL_MS, STUCK_RESTART_MAX_CONSECUTIVE,
  )
  if (action === 'skip') return
  if (action === 'alert') {
    logger.error({ session: MAIN_CHANNELS_SESSION }, 'Stuck main channel input survived max restart escalations -- manual intervention needed')
    sendAlert(`⛔ A ${MAIN_CHANNELS_SESSION} bemenete beragadt es ${STUCK_RESTART_MAX_CONSECUTIVE} automatikus respawn-pane sem szabaditotta ki. Kezi beavatkozas kell (pl. systemctl --user restart ${SERVICE_ID}-channels).`)
    stuckRestartCount++ // tick past the cap so the alert fires only once
    return
  }
  logger.warn({ session: MAIN_CHANNELS_SESSION, attempts: state.attempts, restart: stuckRestartCount + 1 }, 'Stuck main channel input survived soft recovery -- escalating to hard restart (respawn-pane)')
  const r = hardRestartMarveenChannels()
  lastStuckRestartAt = Date.now()
  if (r.ok) {
    stuckRestartCount++
    // Reset the tracker so the fresh post-restart pane is re-evaluated cleanly.
    mainStuckInput = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
  } else {
    logger.error({ session: MAIN_CHANNELS_SESSION, err: r.error }, 'Stuck-input hard restart failed')
  }
}

// --- Keep-alive staleness watchdog (deafness safety net, decision #3) ---
//
// The keep-alive (a scheduled edit_message round-trip from the channels
// session) touches store/.channel-keepalive on every success. If that file
// goes stale while the session is otherwise process-alive, the MCP stdio pipe
// is likely wedged -> respawn the pane.
//
// LIMITATION (documented on purpose): this staleness net does NOT catch a clean
// inbound-ONLY deafness, where outbound edit_message still succeeds and keeps the
// file fresh while server->claude notifications are dropped. The keep-alive
// PREVENTS that case (warm pipe); the ACTIVE detector for it now ships as
// src/web/inbound-probe.ts (2026-06-01) -- a userbot sends a marker the watchdog
// verifies in the transcript. This staleness path remains the coarse backstop.
const KEEPALIVE_FILE = join(PROJECT_ROOT, 'store', '.channel-keepalive')
const KEEPALIVE_STALE_MS = 18 * 60 * 1000 // ~3 missed 6-min cycles
const KEEPALIVE_RESPAWN_GRACE_MS = 15 * 60 * 1000 // let a respawned session re-establish the file
let marveenLastKeepaliveRespawn = 0

/**
 * Pure decision: should the keepalive respawn be deferred because the
 * main session pane is actively busy?
 *
 * Returns true (defer) for 'busy' | 'typing'.
 * Returns false (proceed) for 'idle' | 'unknown' | 'error' | null.
 *
 * Fail-OPEN on unknown/error/null: a wedged or unreadable pane must still
 * be recoverable. Never block a respawn because we couldn't read the pane.
 */
export function shouldDeferKeepaliveRespawn(
  paneState: PaneState | null
): boolean {
  return paneState === 'busy' || paneState === 'typing'
}

// Pure decision: respawn only when the file EXISTS but has gone stale (a file
// that was once fresh and stopped updating). A missing file means the keep-
// alive hasn't established a baseline yet (fresh boot) -- never respawn on
// absence, or we'd loop before the first keep-alive runs.
export function shouldRespawnForStaleKeepalive(opts: {
  keepaliveAgeMs: number | null
  stalenessThresholdMs: number
  msSinceLastRespawn: number | null
  respawnGraceMs: number
}): boolean {
  if (opts.keepaliveAgeMs == null) return false
  if (opts.msSinceLastRespawn != null && opts.msSinceLastRespawn < opts.respawnGraceMs) return false
  return opts.keepaliveAgeMs > opts.stalenessThresholdMs
}

// SOURCE FIX (2026-06-01): the staleness watchdog's only health signal was the
// scheduled edit_message round-trip, injected into the SAME busy channels
// session. When the session is busy carrying a real conversation, that prompt
// is skipped/stuck, so the keepalive file ages WHILE THE CHANNEL IS PERFECTLY
// ALIVE -- and the watchdog respawned the live conversation in an idle gap.
//
// Real inbound traffic is direct proof the server->claude pipe is alive (it is
// exactly that pipe which dies in a deafness). So the dashboard advances the
// keepalive file's mtime to the timestamp of the last ingested `<channel
// source=` block. Now an active conversation keeps the file warm -- precisely
// when it used to go stale -- while a genuinely silent/deaf session still ages
// out. Both watchdogs (this one + the systemd timer) key off the file mtime, so
// both benefit. The scheduled edit_message round-trip stays as the IDLE-path
// keep-alive (no organic traffic); its busy-skip no longer causes false
// staleness because organic inbound covers the busy case.

// Pure decision: should the keepalive file be advanced to the last-inbound
// timestamp? Only when there IS a last inbound and it is newer than the file
// (never move the mtime backward; the scheduled keepalive may be more recent).
export function shouldRefreshKeepaliveFromInbound(
  lastInboundTs: number | null,
  keepaliveMtimeMs: number,
): boolean {
  return lastInboundTs != null && lastInboundTs > keepaliveMtimeMs
}

// Side-effecting: advance store/.channel-keepalive's mtime to the last ingested
// inbound message time, so live conversation proves the pipe healthy. Best
// effort; never throws into the monitor tick.
function refreshKeepaliveFromInbound(): void {
  try {
    const lastInboundTs = readLastIngestionTimestamp(TRANSCRIPT_DIR)
    let mtimeMs = 0
    try { mtimeMs = statSync(KEEPALIVE_FILE).mtimeMs } catch { /* missing -> 0 */ }
    if (!shouldRefreshKeepaliveFromInbound(lastInboundTs, mtimeMs)) return
    if (!existsSync(KEEPALIVE_FILE)) {
      writeFileSync(KEEPALIVE_FILE, String(Math.floor((lastInboundTs as number) / 1000)))
    }
    const when = new Date(lastInboundTs as number)
    utimesSync(KEEPALIVE_FILE, when, when)
  } catch (err) {
    logger.debug({ err }, 'refreshKeepaliveFromInbound failed (non-fatal)')
  }
}

function checkMainKeepaliveStaleness(): void {
  // SAFETY NET first: let any fresh inbound traffic warm the file before we
  // judge staleness, so a busy-but-alive session is never seen as stale-deaf.
  refreshKeepaliveFromInbound()

  // GROUND-TRUTH SHORTCUT (2026-06-01 21:18 incident): if the channel
  // plugin's bun poller is ALIVE under Marveen's claude pid, the channel
  // is healthy by definition -- Telegram traffic CAN reach us. A stale
  // keepalive file with a live poller is just a quiet conversation, NOT
  // deafness. Respawning here would kill the session for nothing (Szabi
  // got "channel keep-alive 18 perce nem frissült" alerts every 30 min
  // during idle periods, each one losing the running --continue context).
  // The bun-child check is the same liveness signal channel-plugin-unlock
  // already uses; reuse it here so the two paths agree on "alive".
  try {
    const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
    if (claudePid != null) {
      const provider = getProvider(getMainAgentProvider())
      if (hasChannelPluginAlive(claudePid, provider.type)) {
        logger.debug({ claudePid, provider: provider.type }, 'Keepalive stale but channel plugin is alive -- skipping respawn')
        return
      }
    }
  } catch (err) {
    // Fail-open: if we couldn't probe liveness, fall through to the
    // existing staleness path so a genuinely dead session still recovers.
    logger.debug({ err }, 'Keepalive liveness shortcut probe failed, falling through')
  }

  let ageMs: number | null = null
  try {
    ageMs = Date.now() - statSync(KEEPALIVE_FILE).mtimeMs
  } catch {
    ageMs = null // file missing -> keep-alive not yet established
  }
  const now = Date.now()
  // B2 fix: cross-path grace — use the later of the two respawn timestamps so
  // an inbound-probe respawn also suppresses the keepalive path for the grace window.
  const msSinceLastRespawn = lastMainRespawnAt() ? now - lastMainRespawnAt() : null
  const respawn = shouldRespawnForStaleKeepalive({
    keepaliveAgeMs: ageMs,
    stalenessThresholdMs: KEEPALIVE_STALE_MS,
    msSinceLastRespawn,
    respawnGraceMs: KEEPALIVE_RESPAWN_GRACE_MS,
  })
  if (!respawn) return
  // Busy-guard: do not respawn a pane that is actively processing a turn.
  // capturePane returns null if the pane can't be read; detectPaneState
  // returns 'unknown' for null input — shouldDeferKeepaliveRespawn is
  // fail-open on unknown, so a broken capture never blocks recovery.
  const paneContent = capturePane(MAIN_CHANNELS_SESSION)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  if (shouldDeferKeepaliveRespawn(paneState)) {
    logger.info({ paneState }, 'Keepalive stale but pane is busy -- deferring respawn')
    return
  }
  const ageMin = Math.round((ageMs ?? 0) / 60000)
  logger.warn({ ageMs, paneState }, 'Channel keep-alive stale -- main session likely wedged/deaf, respawning via respawn-pane')
  sendAlert(`⚠️ A fő channel keep-alive ${ageMin} perce nem frissült -- respawn-pane a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
  if (respawnMarveenSessionFresh()) {
    marveenLastKeepaliveRespawn = now
    // Suppress the process-down handler during the respawn window (reuses the
    // existing hard-restart grace) so the two recovery paths don't collide.
    marveenLastHardRestart = now
  }
}

export function sendAlert(text: string): void {
  notifyChannel(text).catch(() => {})
}

function handleMarveenDown(): void {
  const now = Date.now()
  const providerLabel = getMainAgentProvider()
  // Cold-start guard: defer the ENTIRE down cascade while a recent respawn
  // (from any recovery path -- keepalive fresh-respawn, stage-3 resume, stage-4
  // hard restart, or the external watchdog's file stamp) is still inside its
  // boot window. lastMainRespawnAt() folds all three timestamps together, so a
  // keepalive respawn that did NOT touch marveenLastHardRestart still suppresses
  // escalation. This is what stops the restart-on-restart stacking that caused
  // the 2026-06-01 480s outage (see MARVEEN_POST_RESPAWN_GRACE_MS).
  const lastRespawn = lastMainRespawnAt()
  if (lastRespawn && now - lastRespawn < MARVEEN_POST_RESPAWN_GRACE_MS) {
    return
  }
  if (!marveenDownState) {
    marveenDownState = { downSince: now, stage: 'soft', lastAlertAt: now, softAttempts: 0 }
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin down -- stage 1 (soft /mcp reconnect, silent)')
    // Diagnostic 409 probe (Telegram only). Fire-and-forget so the sync
    // check-loop is not blocked on a network call. Logs explicitly when the
    // upstream returns the orphan-poller's "terminated by other getUpdates
    // request" message, so dashboard.log carries hard evidence of the real
    // cause instead of leaving the operator to infer it from a pane scan.
    if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {
      marveenDownState.conflictProbed = true
      const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
      const tok = readChannelToken(providerLabel, tokenPath)
      if (tok) {
        probeTelegramConflict(tok)
          .then(r => {
            if (r.conflicted) {
              logger.warn(
                { status: r.status, description: r.description },
                'Telegram getUpdates 409 Conflict confirmed -- orphan poller is contending for the bot token. Recovery will reap and respawn.',
              )
            } else if (r.status > 0) {
              logger.info(
                { status: r.status, description: r.description },
                'Telegram getUpdates returned non-409 status on diagnostic probe -- the down state has a different cause than orphan poller contention',
              )
            }
          })
          .catch(err => {
            logger.warn({ err }, 'Telegram conflict probe failed to complete')
          })
      }
    }
    if (softReconnectMarveen()) marveenDownState.softAttempts += 1
    return
  }
  if (marveenDownState.stage === 'soft') {
    if (marveenDownState.softAttempts < 3 && softReconnectMarveen()) {
      marveenDownState.softAttempts += 1
      marveenDownState.lastAlertAt = now
      return
    }
    marveenDownState.stage = 'save'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 2 (memory save)')
    triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 3 (session resume)')
    resumeMarveenSession()
    return
  }
  if (marveenDownState.stage === 'resume') {
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - resumeStartedAt < RESUME_GRACE_MS) return
    marveenDownState.stage = 'hard'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 4 (hard restart)')
    const svcName = process.platform === 'linux' ? 'systemctl' : 'launchctl'
    sendAlert(`⚠️ Session resume nem segitett. Hard restart (${svcName}) most a ${MAIN_CHANNELS_SESSION} session-on...`)
    hardRestartMarveenChannels()
    return
  }
  if (marveenDownState.stage === 'hard') {
    marveenDownState.stage = 'gave_up'
    marveenDownState.lastAlertAt = now
    logger.error({ provider: providerLabel }, 'Marveen channel plugin still down after hard restart -- giving up auto-recovery')
    const serviceCmd = process.platform === 'linux'
      ? `\`systemctl --user status ${SERVICE_ID}-channels\``
      : `\`launchctl list | grep ${SERVICE_ID}\``
    // Issue #189: a plain `tmux attach -t ...` may itself fail with "Permission
    // denied" when the operator is running it from another tmux session. Prefix
    // with `unset TMUX` so the hint works in both nested and non-nested cases.
    sendAlert(`🚨 Hard restart SEM segitett. Kezzel kell megnezni: \`unset TMUX && tmux attach -t ${MAIN_CHANNELS_SESSION}\` es ${serviceCmd}.`)
    return
  }
  if (now - marveenDownState.lastAlertAt > PLUGIN_ALERT_DEDUP_MS) {
    marveenDownState.lastAlertAt = now
    sendAlert(`🚨 Marveen ${providerLabel} plugin meg mindig halott. Nezd meg kezzel.`)
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    const providerLabel = getMainAgentProvider()
    logger.info({ stage, downedFor, provider: providerLabel }, 'Marveen channel plugin recovered')
    if (stage !== 'soft' && stage !== 'save' && stage !== 'resume') {
      sendAlert(`✅ Marveen ${providerLabel} plugin helyrealt (${stage} utan, ${downedFor}s kieses).`)
    }
    marveenDownState = null
  }
}

function shouldEscalateMarveenDown(): boolean {
  const now = Date.now()
  if (marveenSuspectFirstSeen === null) {
    marveenSuspectFirstSeen = now
    return false
  }
  return now - marveenSuspectFirstSeen >= MARVEEN_DOWN_CONFIRM_MS
}

export function startChannelPluginMonitor(): NodeJS.Timeout | null {
  // Respawn/keep-alive is production-only. On any non-production host (e.g. a
  // local dev checkout) we never respawn the main agent or auto-restart
  // sub-agents -- otherwise two machines would fight over the same bot tokens.
  // Applies to ALL agents because the whole monitor loop is skipped here.
  if (!RESPAWN_ENABLED) {
    logger.info({ host: hostname() }, 'Channel plugin monitor disabled (respawn is production-only)')
    return null
  }

  const mainProvider = getMainAgentProvider()

  function check() {
    type Target = { session: string; isMarveen: boolean; agentName?: string; provider: ChannelProviderType }
    const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
    for (const a of listAgentNames()) {
      if (isAgentRunning(a) && agentHasChannel(a)) {
        targets.push({
          session: agentSessionName(a),
          isMarveen: false,
          agentName: a,
          provider: resolveAgentProvider(a),
        })
      }
    }

    // Pane-level thinking-block error detection. Independent of channel
    // plugin liveness: a session can keep a live plugin yet be wedged on
    // the API error, every injected prompt yielding another 400. Detect
    // it via the pane state and alert (never auto-reset).
    for (const t of targets) {
      const pane = capturePane(t.session)
      const isError = pane != null && detectPaneState(pane) === 'error'
      const prev = paneErrorState.get(t.session) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const decision = decidePaneErrorAlert(isError, prev, Date.now(), {
        confirmMs: PANE_ERROR_CONFIRM_MS,
        dedupMs: PANE_ERROR_DEDUP_MS,
        clearMs: PANE_ERROR_CLEAR_MS,
      })
      if (decision.next.firstSeenAt === null) {
        paneErrorState.delete(t.session)
      } else {
        paneErrorState.set(t.session, decision.next)
      }
      if (decision.alert) {
        const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
        logger.error({ session: t.session, agent: label }, 'Agent wedged on thinking-block API error -- manual reset needed')
        sendAlert(`🚨 A(z) ${label} agens elakadt egy thinking-block API hibaban (a session-history korrupt, minden uj prompt ugyanazt a 400-at adja). Kezi reset kell: allitsd le es inditsd ujra, friss session indul. Reszletek: tmux attach -t ${t.session}`)
      }
    }

    // Blocking-menu recovery (main + sub-agents). A session parked in an
    // interactive modal (/mcp manager, model/config picker, permission dialog)
    // is neither busy nor idle, so detectPaneState reads 'unknown' and the
    // scheduler/router silently skip it -- the session goes deaf with nothing
    // alerting (observed: main session sat in /mcp ~6h). A single Escape pops
    // the modal back to the prompt without touching the conversation, so unlike
    // the thinking-block error this is safe to auto-recover. Same debounce
    // machine as the error pass (alert == "recover now") so a one-tick frame
    // never fires and the Escape is not re-sent every tick.
    for (const t of targets) {
      const pane = capturePane(t.session)
      const inMenu = pane != null && detectsBlockingMenu(pane)
      const prev = paneMenuState.get(t.session) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const decision = decidePaneErrorAlert(inMenu, prev, Date.now(), {
        confirmMs: MENU_RECOVER_CONFIRM_MS,
        dedupMs: MENU_RECOVER_DEDUP_MS,
        clearMs: MENU_RECOVER_CLEAR_MS,
      })
      if (decision.next.firstSeenAt === null) {
        paneMenuState.delete(t.session)
      } else {
        paneMenuState.set(t.session, decision.next)
      }
      if (decision.alert) {
        const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
        logger.warn({ session: t.session, agent: label }, 'Session parked in a blocking interactive menu -- sending Escape to recover')
        try {
          execFileSync(TMUX, ['send-keys', '-t', t.session, 'Escape'], { timeout: 5000 })
        } catch (err) {
          logger.warn({ err, session: t.session }, 'Menu-recovery Escape failed')
        }
        sendAlert(`⌨️ A(z) ${label} session beragadt egy interaktiv menube (pl. /mcp) es nem dolgozott fel uzeneteket. Kikuldtem egy Escape-et, visszateritettem a prompthoz. Ha ismetlodik: tmux attach -t ${t.session}`)
      }
    }

    // Stuck channel-input recovery (main + sub-agents). Recover a channel
    // notification stranded at the ❯ prompt by getting it SUBMITTED. The gate
    // (parkedChannelInput != null) fires ONLY for a parked <channel> block, so
    // a human's own hand-typed draft is never touched. Enter-first (faithful);
    // escalate to clear+re-inject only after MAIN_STUCK_ENTER_ATTEMPTS, and
    // only when the captured block looks COMPLETE -- a truncated capture stays
    // on Enter rather than risk a partial re-inject to the wrong chat_id.
    mainStuckInput = recoverStuckInputForSession(MAIN_CHANNELS_SESSION, mainStuckInput, MAIN_STUCK_THRESHOLDS, false)
    // Reliable backstop: if the soft recovery is exhausted and the input is
    // STILL parked, the TUI is hard-wedged -- escalate to a respawn-pane (the
    // automated form of the manual `systemctl restart channels`). Rate-limited.
    maybeRestartWedgedMainChannel(mainStuckInput)
    // Same recovery for every running sub-agent session: a parked channel
    // message wedges a sub-agent ("nem válaszol") exactly as it would the main
    // session. Per-session state lives in agentStuckInput; drop it once the
    // spell ends so the map never grows unbounded.
    for (const t of targets) {
      if (t.isMarveen) continue
      const prev = agentStuckInput.get(t.session) ?? { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }
      const next = recoverStuckInputForSession(t.session, prev, MAIN_STUCK_THRESHOLDS, true)
      if (next.parkedSig === null) agentStuckInput.delete(t.session)
      else agentStuckInput.set(t.session, next)
    }

    for (const t of targets) {
      const claudePid = getClaudePidForSession(t.session)
      if (!claudePid) {
        if (!t.isMarveen && t.agentName) {
          const lastRestart = agentLastRestart.get(t.agentName)
          if (lastRestart && Date.now() - lastRestart < AGENT_RESTART_GRACE_MS) continue
        }
        if (t.isMarveen) {
          // The claude pid is gone. WHY decides recovery: a session that no
          // longer exists at all must be recreated from scratch (respawn-pane,
          // the only tool the down-cascade has on Linux, cannot resurrect a
          // vanished session); a session that still exists with a dead/wedged
          // claude is the down-cascade's job. Without this split a crashed,
          // self-updated or rebooted main session never returns on installs
          // with no supervising service, and every scheduled main-agent task
          // silently skips (scheduler !sessionExists branch).
          if (!mainChannelsSessionExists()) {
            if (shouldEscalateMarveenDown() && createMainChannelsSession()) {
              marveenDownState = null
              marveenSuspectFirstSeen = null
            }
          } else if (shouldEscalateMarveenDown()) {
            handleMarveenDown()
          }
        }
        continue
      }
      const alive = hasChannelPluginAlive(claudePid, t.provider, t.agentName)
      if (alive) {
        if (t.isMarveen) {
          handleMarveenUp()
          // Process-alive does NOT prove the inbound MCP pipe is healthy (the
          // deafness blind spot). Cross-check the keep-alive freshness.
          checkMainKeepaliveStaleness()
        } else {
          if (agentDownSince.has(t.session)) {
            logger.info({ session: t.session, provider: t.provider }, 'Agent channel plugin recovered')
            agentDownSince.delete(t.session)
          }
          // Healthy observation clears the exponential back-off so the next
          // down-spell starts again at the base grace.
          agentRestartFailures.delete(t.agentName!)
        }
        continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) handleMarveenDown()
      } else {
        if (!agentDownSince.has(t.session)) agentDownSince.set(t.session, Date.now())
        const lastRestart = agentLastRestart.get(t.agentName!)
        const failures = agentRestartFailures.get(t.agentName!) ?? 0
        const restart = shouldAutoRestartDownAgent({
          processAgeMs: getProcessAgeMs(claudePid),
          msSinceLastRestart: lastRestart != null ? Date.now() - lastRestart : null,
          startupGraceMs: AGENT_STARTUP_GRACE_MS,
          restartGraceMs: AGENT_RESTART_GRACE_MS,
          consecutiveFailures: failures,
          maxRestartGraceMs: AGENT_MAX_RESTART_GRACE_MS,
        })
        if (!restart) {
          logger.debug({ agent: t.agentName, provider: t.provider, failures }, 'Channel plugin probe reports down but agent is within startup/restart back-off -- deferring')
          continue
        }
        const agentProvider = resolveAgentProvider(t.agentName!)
        const stateDir = channelStateDir(agentProvider, agentDir(t.agentName!))
        const agentToken = readChannelToken(agentProvider, join(stateDir, '.env'))
        if (!agentToken) {
          logger.warn({ agent: t.agentName, provider: agentProvider }, 'Agent has no channel token in state dir -- skipping restart to avoid token conflict')
          continue
        }
        logger.warn({ agent: t.agentName, provider: t.provider, failures }, 'Agent channel plugin down -- auto-restarting')
        try {
          stopAgentProcess(t.agentName!)
          execSync('sleep 2', { timeout: 4000 })
          startAgentProcess(t.agentName!)
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
          // Count this restart as failed until a later sweep sees the plugin
          // alive (which resets the counter). Repeated failures back off the
          // next restart exponentially instead of churning every base-grace.
          agentRestartFailures.set(t.agentName!, failures + 1)
        } catch (err) {
          logger.error({ err, agent: t.agentName }, 'Failed to auto-restart agent after channel plugin down')
        }
      }
    }

    // Desired-state reconciliation: bring back agents the operator wants
    // running but whose tmux session vanished entirely (shared tmux server
    // killed by a channels-unit restart, or a machine reboot). The per-target
    // loop above only handles sessions that still exist with a dead plugin.
    // Staggered to avoid the simultaneous-start race that kills agents.
    void reconcileDesiredAgents()

    // Periodic detached-channel-claude reap (CB6CF755). Throttled; reuses the
    // respawn-time reaper so orphans accumulating between respawns are cleaned
    // up on a slow cadence too. Fail-safe + pane-guarded inside the reaper.
    if (shouldRunPeriodicReap(lastDetachedReapAt, Date.now(), DETACHED_REAP_INTERVAL_MS)) {
      lastDetachedReapAt = Date.now()
      try {
        const reaped = reapDetachedChannelClaudes({ tmuxPath: TMUX })
        if (reaped.length > 0) {
          logger.warn({ reaped }, 'channel-monitor: periodic reap removed detached channel-claude orphans')
        }
      } catch (err) {
        logger.warn({ err }, 'channel-monitor: periodic detached-claude reap failed')
      }
    }
  }
  setTimeout(check, 30000)
  return setInterval(check, 60000)
}

// Start desired-but-missing agents one at a time (~15s apart). The stagger is
// mandatory: starting several channel agents at once makes them all die in the
// resume-from-summary modal race. A single in-flight burst at a time.
let reconcileBurstInProgress = false
const AGENT_RECONCILE_STAGGER_MS = 15000
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function reconcileDesiredAgents(): Promise<void> {
  if (reconcileBurstInProgress) return
  const desired = getDesiredAgents()
  if (desired.size === 0) return
  const down = [...desired].filter((name) => !isAgentRunning(name))
  if (down.length === 0) return
  reconcileBurstInProgress = true
  try {
    for (const name of down) {
      if (isAgentRunning(name)) continue
      const last = agentLastRestart.get(name)
      if (last != null && Date.now() - last < AGENT_RESTART_GRACE_MS) continue
      logger.warn({ agent: name }, 'Desired agent not running -- auto-starting (reconcile)')
      try {
        const r = startAgentProcess(name)
        agentLastRestart.set(name, Date.now())
        if (!r.ok && r.error !== 'Agent is already running') {
          logger.error({ agent: name, error: r.error }, 'Reconcile start failed')
        }
      } catch (err) {
        logger.error({ err, agent: name }, 'Reconcile start threw')
      }
      await delay(AGENT_RECONCILE_STAGGER_MS)
    }
  } finally {
    reconcileBurstInProgress = false
  }
}

// Backward-compatible alias
export const startTelegramPluginMonitor = startChannelPluginMonitor
