import { existsSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { makeLazyBinResolver } from '../platform.js'
import { WEB_PORT } from '../config.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID, BOT_NAME, CHANNEL_PROVIDER, PROJECT_ROOT, RESPAWN_ENABLED } from '../config.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from '../config-registry.js'
import { agentDir, listAgentNames, readAgentChannelProvider } from './agent-config.js'
import {
  agentHasChannel,
  agentSessionName,
  capturePane,
  captureParkedInputView,
  clearInputBuffer,
  dismissResumeSummaryModalIfPresent,
  dismissModelConsentDialogIfPresent,
  stampFableOverageConsentSharedRoots,
  isAgentRunning,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
  scheduleIdentitySetup,
  ensureMainAgentIsolatedConfigDir,
  ensureSharedClaudeOnboarded,
  hasFleetOauthToken,
  FLEET_OAUTH_TOKEN_PATH,
  answerFirstRunGates,
  shSingleQuote,
} from './agent-process.js'
import { withSessionSendLock } from './session-send-lock.js'
import { reapChannelOrphans, reapDetachedChannelClaudes, collectPollerEvidence } from './channel-poller-reap.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { schedulePluginUnlockAfterRespawn, wasPluginConfirmedAbsent, clearPluginAbsent } from './channel-plugin-unlock.js'
import { getInjectedPrompt, matchesInjectedPrompt } from './injected-prompt-registry.js'
import {
  detectPaneState, decidePaneErrorAlert, detectsBlockingMenu, detectsFirstRunGate, detectsModelConsentDialog, type PaneErrorAlertState, type PaneState,
  stuckInputSignature, decideStuckInputRecovery, parkedChannelInput,
  parkedInputText, shouldClearTruncatedPreamble,
  parkedInputRowCount, submitLanded, decideStuckInputAction,
  parkedScheduledTaskInput, parkedMachineOriginInput, parkedMainInputHasRemedy,
  type StuckInputState, type StuckInputThresholds, type StuckInputAction,
  type StuckInputActionFacts,
} from '../pane-state.js'
import { MAIN_CHANNELS_SESSION, MAIN_CHANNELS_PLIST } from './main-agent.js'
import { notifyChannel } from '../notify.js'
import { getProvider, channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'
import { readLastIngestionTimestamp, TRANSCRIPT_DIR } from './inbound-probe.js'
import { decideDownAgentAction, AGENT_MAX_RESTART_ATTEMPTS, parseEtimeToSeconds } from './agent-restart-policy.js'
// getClaudePidForSession + hasChannelPluginAlive live in the shared liveness
// module so the standalone channel-coordinator reuses the exact same probe.
import { getClaudePidForSession, hasChannelPluginAlive, probeChannelPluginLiveness, classifyRespawnStampAdvance } from '../channel-coordinator/liveness.js'
import { getDesiredAgents } from './agent-desired-state.js'

// Lazily resolved (see makeLazyBinResolver): a module-level `resolveFromPath`
// const throws at IMPORT time, so any environment where the binary is not
// resolvable -- a transient PATH gap, or CI where no `claude` is installed --
// fails the whole module load and takes every importer down with it. Deferring
// to first use keeps importing this module side-effect free; the resolution
// error then surfaces at the call site that actually needs the binary. This
// mirrors the pattern already used in agent-process.ts.
const tmuxBin = makeLazyBinResolver('tmux')
const claudeBin = makeLazyBinResolver('claude')

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
// Agents already warned about a missing channel token, so the per-sweep probe
// does not repeat the identical WARN every minute forever (observed 2026-07-20:
// teamer, an agent with no channel token bound, emitted the same line ~1440x/day
// and drowned the log). First detection warns; repeats drop to debug. Cleared
// when a token appears so a later un-bind is announced again.
const agentNoTokenWarned: Set<string> = new Set()
// Sessions whose busy-deferral cap has already been reported to the operator, so
// the alert fires once per down-spell instead of every sweep. Cleared when the
// plugin recovers (or when the agent is restarted after it goes idle).
const agentBusyDeferAlerted: Set<string> = new Set()
// Consecutive watchdog restarts (keyed by agent name) that did NOT bring the
// plugin back up. Drives exponential back-off so a plugin that crashes on every
// launch (e.g. a broken third-party channel plugin) is not restarted on a fixed
// short cadence forever -- which restarts the WHOLE agent every few minutes and
// renders it unusable. Reset to 0 the moment the plugin is seen alive again.
// Persisted to disk so a dashboard process restart does not reset the counter and
// restart a channel plugin that has already been given up on (bug: dashboard PID
// bounce wiped in-memory counters, restarting agents indefinitely on every boot).
const agentRestartFailures: Map<string, number> = new Map()
let agentRestartFailuresInitialized = false

function agentFailuresPath(agentName: string): string {
  return join(PROJECT_ROOT, 'store', `.agent-failures-${agentName}`)
}

function loadPersistedAgentFailures(agentName: string): number {
  try {
    const n = parseInt(readFileSync(agentFailuresPath(agentName), 'utf-8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function savePersistedAgentFailures(agentName: string, count: number): void {
  try {
    writeFileSync(agentFailuresPath(agentName), String(count))
  } catch (err) {
    logger.debug({ err, agentName }, 'Failed to persist agent restart failures (non-fatal)')
  }
}

function clearPersistedAgentFailures(agentName: string): void {
  try {
    writeFileSync(agentFailuresPath(agentName), '0')
  } catch { /* best effort */ }
}

function ensureAgentRestartFailuresInitialized(): void {
  if (agentRestartFailuresInitialized) return
  agentRestartFailuresInitialized = true
  for (const a of listAgentNames()) {
    const persisted = loadPersistedAgentFailures(a)
    if (persisted > 0) {
      agentRestartFailures.set(a, persisted)
      logger.info({ agent: a, failures: persisted }, 'channel-monitor: restored persisted restart failure count from disk')
    }
  }
}
// Global stagger for channel-down restarts. On Claude Code 2.1.193 a sub-agent's
// --channels plugin only LOADS on a fresh (no --continue) launch, and several
// such cold-boots at once race on the shared plugin cache so NONE attach a
// poller. Serialise: at most one channel-down restart per this interval,
// fleet-wide, so each fresh cold-boot completes in isolation.
let lastChannelAgentRestartAt = 0
const CHANNEL_RESTART_STAGGER_MS = 90_000
const AGENT_RESTART_GRACE_MS = 90_000
// Floor frequency for the backed-off restart: even a long-down plugin is still
// retried at least this often, in case an external fix brings it back.
const AGENT_MAX_RESTART_GRACE_MS = 60 * 60 * 1000 // 1h
// A freshly started agent can take well over the first-probe window to bring
// its channel plugin up (a large-context model launched with --continue spawns
// the plugin only after a slow session load). Never restart a process younger
// than this on a "plugin down" reading, or the watchdog crash-loops it.
const AGENT_STARTUP_GRACE_MS = 180_000
// A single "down" sample is a suspicion, not a verdict: the probe walks a
// process tree and can miss a poller that is mid-respawn, and ps can time out
// on a loaded box. The sweep runs every 60s, so requiring the down-spell to
// persist this long means at least two consecutive down observations before any
// restart. Measured cost of the old single-sample rule (2026-07-14): 10 agent
// hard-restarts in one day, one of them on a plugin that reported healthy again
// a minute later without ever being restarted -- it was never down.
const AGENT_DOWN_CONFIRM_MS = 150_000
// A restart is a FRESH session: it destroys the work in flight. While the agent
// is actively generating, defer -- a down channel does not stop it working, it
// only stops it hearing. But a permanently busy agent with a dead channel is
// deaf, which is exactly what the watchdog exists to catch, so past this cap the
// watchdog stops choosing and asks the operator.
const AGENT_BUSY_DEFER_MAX_MS = 30 * 60 * 1000 // 30m
// When the unlock probe has confirmed the plugin ABSENT from /mcp (never
// loaded, not merely Failed/disabled), a fresh restart cannot bring it back --
// it comes up absent again, and each restart wipes the agent's session context
// (2026-07-01: rocket + mantis burned 5 fresh-restarts each on an absent plugin
// before the watchdog gave up). Cap the restart budget at ONE for that case so
// the watchdog escalates to the operator after a single attempt instead of the
// full AGENT_MAX_RESTART_ATTEMPTS. The absent verdict is honoured only while
// fresh (re-stamped by each post-respawn probe, cleared on recovery).
const PLUGIN_ABSENT_MAX_RESTART_ATTEMPTS = 1
const PLUGIN_ABSENT_TTL_MS = 15 * 60 * 1000
// Re-alert cadence while the main plugin is STILL down. The first alert is the
// informative one; keep repeats to a few hours (owner request 2026-07-30).
const PLUGIN_ALERT_DEDUP_MS = 3 * 60 * 60 * 1000

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

// Busy-guard over the stuck-input restart decision (false-positive fix,
// 2026-06-26). #452 hard-restarted (respawn-pane / launchctl reload) the main
// session as soon as a parked input survived ~4 soft-recovery ticks -- but a
// parked inbound message is the NORMAL transient case: the channel plugin drops
// it into the prompt box and the Claude TUI, in raw mode, frequently swallows
// the auto-submit Enter, so the same text sits 'typing' across several ticks
// until soft recovery (Enter / clear+re-inject) finally submits it. The hard
// restart pre-empted that recovery with a sledgehammer that destroyed the live
// conversation (~10 reloads in 12h, each losing context).
//
// Defer the restart whenever the pane is busy OR holds parked input it is still
// actively recovering ('typing') -- give soft recovery time to submit instead
// of nuking the session. A session that is genuinely DEAD (not even soft-
// recovering) is still caught by the keepalive-staleness watchdog (~18min), the
// pre-#452 backstop.
//
// DEADLOCK CARVE-OUT (2026-07-25 hermes incident): the blanket 'typing' defer
// muted the channel PERMANENTLY when the parked text had NO soft remedy (a
// multi-row non-<channel> block on the main session -> decideStuckInputAction
// 'hold' forever) -- the keepalive backstop defers on the same 'typing' signal,
// so nothing ever recovered. A 'typing' pane therefore no longer defers when
// BOTH hold: (1) the parked text is identifiably machine-injected (a known
// delivery wrapper prefix -- never a human draft mid-composition), and (2) the
// soft recovery has no move for it ('hold'). Everything else keeps deferring:
// genuine 'busy', a human-looking draft, and any parked text soft recovery can
// still submit/clear on its own.
export function applyStuckRestartBusyGuard(
  paneState: PaneState | null,
  decision: 'restart' | 'alert' | 'skip',
  opts?: { machineOrigin: boolean; softRemedy: boolean },
): 'restart' | 'alert' | 'skip' {
  if (paneState === 'busy') return 'skip'
  if (paneState === 'typing') {
    const unrecoverable = opts != null && opts.machineOrigin && !opts.softRemedy
    return unrecoverable ? decision : 'skip'
  }
  return decision
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
export async function recoverStuckInputForSession(
  session: string,
  prev: StuckInputState,
  thresholds: StuckInputThresholds,
  allowPlainReinject: boolean,
): Promise<StuckInputState> {
  // Ghost-stripped capture: a dim autocomplete hint in an empty box must NOT
  // read as parked input, or the recovery below would re-type + submit it
  // (phantom prompt-injection). See captureParkedInputView / stripGhostSuggestion.
  const pane = captureParkedInputView(session)
  const sig = pane != null ? stuckInputSignature(pane) : null
  const decision = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)
  if (decision.recover && pane != null) {
    const attempt = decision.next.attempts
    const block = parkedChannelInput(pane)
    // Gather the parked-input facts and let the pure decision choose the move.
    // The decision NEVER bare-Enters a multi-row box (that inserts a newline
    // and corrupts the message) and prefers a chat_id-safe re-inject; the
    // truncation-guard (no verbatim re-inject of an incomplete <channel> block)
    // is preserved via blockTruncated.
    // STUCKINPUT827: what the sender actually typed into THIS pane, if it is
    // still on record. A match turns the lossy scrape into a known message and
    // opens the 'reinject-recorded' path (see decideStuckInputAction).
    const recorded = getInjectedPrompt(session)
    const recordedMatch = matchesInjectedPrompt(parkedInputText(pane), recorded)
    const facts: StuckInputActionFacts = {
      escalate: attempt > MAIN_STUCK_ENTER_ATTEMPTS,
      rowCount: parkedInputRowCount(pane),
      blockComplete: block != null && block.complete && block.block != null,
      blockTruncated: block != null && !block.complete,
      truncatedPreamble: shouldClearTruncatedPreamble(pane),
      allowPlainReinject,
      hasPlainText: allowPlainReinject && parkedInputText(pane) != null,
      scheduledTaskBlock: parkedScheduledTaskInput(pane),
      machineOrigin: parkedMachineOriginInput(pane),
      recordedMatch,
    }
    const action = decideStuckInputAction(facts)
    await performStuckInputAction(session, action, pane, block, sig, attempt, recorded?.text ?? null)
  }
  return decision.next
}

// Execute a stuck-input recovery action and verify it landed. The action is
// chosen by the pure decideStuckInputAction(); this does only the tmux side-
// effect plus POST-SUBMIT VERIFICATION (re-capture + submitLanded), so a move
// that did NOT clear the parked text is logged and the next tick escalates
// within the attempts budget (decideStuckInputRecovery caps it). 'hold' and
// 'clear-preamble' submit nothing, so there is nothing to verify there.
async function performStuckInputAction(
  session: string,
  action: StuckInputAction,
  paneBefore: string,
  block: ReturnType<typeof parkedChannelInput>,
  prevSig: string | null,
  attempt: number,
  recordedText: string | null,
): Promise<void> {
  let submitted = false
  try {
    switch (action) {
      case 'reinject-block': {
        logger.warn({ session, chatId: block?.chatId, attempt }, 'Stuck channel input -- clear + verbatim re-inject')
        // DELIVLOCK805: clear+re-inject MUTATES the input box, so it must not
        // race a live delivery into this pane (it could clear a partial send or
        // submit the wrong buffer). Run the clear+re-inject as ONE recover-mode
        // critical section; if a delivery holds the lane, skip and log -- a
        // stuck box recovers on the next tick once the delivery finishes.
        // HOST-KEY CAVEAT (PANEWRITERS805): the lane key is host-scoped
        // (`local::sess` here vs `vps1::sess` for a remote delivery). This
        // recovery only ever targets LOCAL sessions today, so null is correct;
        // if stuck-input recovery is ever extended to remote agents, the real
        // host MUST be threaded here or the fail-closed guarantee silently
        // evaporates (two different keys never contend).
        const res = await withSessionSendLock(session, null, 'recover', async () => {
          await clearInputBuffer(session)
          await sendPromptToSession(session, block!.block!, null, { lockMode: 'held' })
        })
        if (!res.ran) {
          logger.info({ session, attempt }, 'Stuck-input recovery (reinject-block) skipped: a delivery is in flight into this pane (fail-closed)')
          break
        }
        submitted = true
        break
      }
      case 'reinject-plain': {
        const text = parkedInputText(paneBefore)
        if (text != null) {
          logger.warn({ session, attempt }, 'Stuck input (non-channel) -- clear + re-inject parked text')
          const res = await withSessionSendLock(session, null, 'recover', async () => {
            await clearInputBuffer(session)
            await sendPromptToSession(session, text, null, { lockMode: 'held' })
          })
          if (!res.ran) {
            logger.info({ session, attempt }, 'Stuck-input recovery (reinject-plain) skipped: a delivery is in flight into this pane (fail-closed)')
            break
          }
        } else {
          // FABLEFALL1: a bare Enter on the model consent dialog confirms its
          // DEFAULT option, which switches the model. Answer the dialog safely
          // first (no-op when absent); an Enter on the then-idle prompt is
          // harmless.
          await dismissModelConsentDialogIfPresent(session)
          execFileSync(tmuxBin(), ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        }
        submitted = true
        break
      }
      case 'reinject-recorded': {
        // The registry proved this parked text is the message WE typed, so the
        // clear destroys no human draft and the re-inject replays the original
        // rather than a head-lost scrape. Same recover-mode critical section as
        // reinject-block: never race a live delivery into this pane.
        if (recordedText == null || recordedText.length === 0) {
          logger.warn({ session, attempt }, 'Stuck input -- reinject-recorded chosen without a recorded text; holding')
          break
        }
        logger.warn({ session, attempt }, 'Stuck input -- clear + re-inject the recorded prompt (registry-proven)')
        const res = await withSessionSendLock(session, null, 'recover', async () => {
          await clearInputBuffer(session)
          await sendPromptToSession(session, recordedText, null, { lockMode: 'held' })
        })
        if (!res.ran) {
          logger.info({ session, attempt }, 'Stuck-input recovery (reinject-recorded) skipped: a delivery is in flight into this pane (fail-closed)')
          break
        }
        submitted = true
        break
      }
      case 'clear-preamble':
        logger.warn({ session, attempt }, 'Stuck input -- truncated safety preamble, clearing buffer (no re-inject)')
        await clearInputBuffer(session)
        break
      case 'clear-scheduled':
        logger.warn({ session, attempt }, 'Stuck input -- parked scheduled-task tick, clearing buffer (no re-inject; next schedule fire re-delivers)')
        await clearInputBuffer(session)
        break
      case 'enter':
        // FABLEFALL1: same guard as the reinject-plain fallback above -- a bare
        // Enter must never reach the model consent dialog (its default SWITCHES
        // the model). No-op when the dialog is absent.
        await dismissModelConsentDialogIfPresent(session)
        execFileSync(tmuxBin(), ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
        submitted = true
        break
      case 'hold':
        logger.warn({ session, attempt }, 'Stuck input -- multi-row/truncated, holding (no bare-Enter; awaiting keystroke fix)')
        break
    }
  } catch (err) {
    logger.warn({ err, session, action }, 'Stuck-input recovery action failed')
    return
  }
  if (submitted) {
    // submitLanded() handles a null capture internally (-> not landed). prevSig
    // is non-null here in practice (recover only fires on a parked signature),
    // but guard the type narrowing explicitly.
    const landed = prevSig != null ? submitLanded(prevSig, captureParkedInputView(session)) : false
    logger.warn(
      { session, action, attempt, landed },
      landed
        ? 'Stuck input -- recovery action landed'
        : 'Stuck input -- recovery action did NOT land (escalating next tick within budget)',
    )
  }
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
const PANE_ERROR_DEDUP_MS = 3 * 60 * 60 * 1000
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

async function triggerMarveenMemorySave(): Promise<void> {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik).`,
    `MOST mentsd el a ${BOT_NAME} memoriaba amit a kovetkezo sessionnek tudnia kell:`,
    'aktiv feladatok (category hot), friss dontesek/preferenciak (warm), tanulsagok (cold).',
    `Hasznald: curl -s -X POST http://localhost:${WEB_PORT}/api/memories ... (lasd CLAUDE.md).`,
    'Ha kesz vagy, irj egy rovid napi naplo bejegyzest is a /api/daily-log-ra. Utana eleg.',
  ].join(' ')
  try {
    await sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

// Single `KEY=value` lookup in the install's .env, used by the readers below.
// Deliberately dumb (first matching line, trimmed): it mirrors the `grep -E
// '^KEY=' | head -1 | cut -d= -f2-` that scripts/channels.sh already does, so
// both sides read the same file the same way.
function readEnvValue(projectRoot: string, key: string): string {
  try {
    const envPath = join(projectRoot, '.env')
    if (!existsSync(envPath)) return ''
    const line = readFileSync(envPath, 'utf-8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`))
    return line ? line.slice(key.length + 1).trim() : ''
  } catch {
    return ''
  }
}

// Read the main agent's configured model so a soft resume passes --model
// explicitly, mirroring scripts/channels.sh. Without it the respawned session
// falls back to claude-code's built-in default and silently drifts off the model
// the user picked. Returns '' when unset.
//
// PRECEDENCE MUST MATCH channels.sh resolve_main_model(): .env MAIN_AGENT_MODEL
// (per-install, gitignored) wins over .claude/settings.json (tracked, shipped
// with the repo). Reading ONLY settings.json here was a silent split-brain: an
// install that sets its model the documented way -- in .env, precisely so the
// tracked file stays clean for the update preflight -- got that choice honoured
// on the LAUNCH path and ignored on the RESPAWN path. The two only agreed while
// someone kept both files in sync by hand, and nothing detected the drift.
//
// The failure is not hypothetical and not symmetric: the tracked settings.json
// ships a model of its own, so a respawn after an update (which reverts local
// edits to tracked files) can silently move the main agent to a DIFFERENT model
// than the one it launched with -- below the operator's required floor, with no
// dialog, no error and no log line. The launch path would keep saying the right
// thing, which is exactly what makes it hard to see.
//
// RESPAWNMODEL807 (2026-08-07): the parity claim above went stale the day
// MODELDRIFT807 removed the pinned model from the shipped settings.json. The
// launch path had a THIRD layer (the shipped DISTRIBUTION_DEFAULT_AGENT_MODEL,
// #918) -- this function did not, so on a clean install it started returning
// '' and every respawn call site dropped the --model flag entirely. Measured
// live on the hermes soak box: the respawned main session ran a bare `claude`
// and the transcript showed claude-sonnet-4-6 -- neither the fleet default nor
// any configured value, just the CLI's account-tier default. The fix mirrors
// the launch path's final layer from the SAME single source (a TS import of
// the constant the shell path reads out of dist/config-registry.js), so this
// resolver can no longer return empty while a distribution default exists.
export function readConfiguredMainModel(projectRoot: string = PROJECT_ROOT): string {
  const fromEnv = readEnvValue(projectRoot, 'MAIN_AGENT_MODEL')
  if (fromEnv) return fromEnv
  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const model = parsed?.model
      if (typeof model === 'string' && model.trim()) return model.trim()
    }
  } catch {
    // fall through to the distribution default -- an unreadable settings file
    // must degrade the same way as a model-less one, never to a flag-less spawn
  }
  return DISTRIBUTION_DEFAULT_AGENT_MODEL
}

// Secondary channel plugins the main session co-listens on, read from .env
// CHANNEL_PLUGINS_EXTRA (space-separated plugin ids) exactly as scripts/channels.sh
// derives its EXTRA_CHANNELS. Kept OUT of buildMainSessionRespawnCmd so that stays
// pure for the contract test; every respawn call site must pass the result through.
//
// Why this exists: a respawn that omits the extras comes up on the PRIMARY provider
// only, which is a HALF-mute -- outbound still works (the plugin's MCP reply tool is
// loaded) while inbound on every secondary provider is silently dropped ("server not
// in --channels list"). Liveness probes watch the primary, so nothing looks wrong.
// Observed in practice: a context-saturation hard restart dropped the secondary
// inbound for ~20 minutes while the primary channel kept working normally.
export function readExtraChannelPluginIds(projectRoot: string = PROJECT_ROOT): string[] {
  return readEnvValue(projectRoot, 'CHANNEL_PLUGINS_EXTRA').split(/\s+/).filter(Boolean)
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
  /**
   * When set (macOS main-agent isolation on), the respawn exports this isolated
   * CLAUDE_CONFIG_DIR plus the fleet setup-token -- parity with channels.sh CFG_ENV.
   * Without it the RECOVERY respawn brings the main agent up on the shared
   * ~/.claude, which on macOS authenticates from the rotating Keychain OAuth
   * session and periodically 401s ("Please run /login"). null/undefined => keep
   * the shared root (unchanged behaviour for installs with isolation off).
   */
  isolatedConfigDir?: string | null
  /**
   * When true (fleet setup-token file present) and there is NO isolated config
   * dir, the respawn still exports CLAUDE_CODE_OAUTH_TOKEN from the fleet token
   * file. On Linux the isolatedConfigDir is always null (macOS-only), so before
   * this leg a wizard-entered token never reached a respawned main session at
   * all -- it fell back to ~/.claude/.credentials.json (2026-07-15 bootcamp,
   * bug 2 latent path). Keeps main + sub-agents on the SAME auth source.
   */
  fleetToken?: boolean
  /**
   * Secondary plugin ids to co-listen on alongside `pluginId`, from
   * readExtraChannelPluginIds(). Omitting them is what silently half-mutes every
   * non-primary channel after a recovery respawn -- see that helper's comment.
   */
  extraPluginIds?: string[]
}): string {
  return [
    'export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    // MCP startup-batch tuning (parity with channels.sh + startAgentProcess):
    // the --channels plugin is a stdio MCP server; the main session runs the
    // most MCP servers (filesystem/playwright/chrome + claude.ai connectors +
    // the plugin), so without these the channel plugin can be starved out of
    // the default 3-wide blocking startup batch and never register a poller.
    // This respawn-pane path is the RECOVERY launcher -- it must tune the same
    // env as the channels.sh boot path, else a recovery respawn comes up
    // un-tuned and can re-starve under load.
    '&& export MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000',
    // macOS main-agent config isolation -- parity with channels.sh CFG_ENV. The
    // token is read at launch via $(cat) so the secret never lands in argv/`ps`.
    ...(opts.isolatedConfigDir
      ? [`&& export CLAUDE_CONFIG_DIR='${opts.isolatedConfigDir}' && export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')"`]
      : opts.fleetToken
        ? [`&& export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${FLEET_OAUTH_TOKEN_PATH}')"`]
        : []),
    '&&', opts.claudePath,
    ...(opts.continueSession ? ['--continue'] : []),
    '--dangerously-skip-permissions',
    // Escape the model id so a value like `claude-opus-4-8[1m]` is not
    // glob-expanded -- and so a hostile value cannot break out of the quote and
    // inject a command into the string the tmux respawn-pane shell runs. This is
    // the 5th launch sink; it must use the same escaper as the other four (the
    // allowlist is the belt, this is the braces). shSingleQuote makes the value
    // one inert shell word. See model-id-injection.test.ts.
    ...(opts.model ? ['--model', shSingleQuote(opts.model)] : []),
    [`--channels plugin:${opts.pluginId}`, ...(opts.extraPluginIds ?? []).map((p) => `plugin:${p}`)].join(' '),
  ].join(' ')
}

// FRESH respawn of the main channels session, for hosts with no launchd.
//
// Exported for the scheduled auto-restart (auto-restart-runner.ts), whose macOS
// leg is `launchctl kickstart`. On Linux that binary does not exist, so before
// this the main agent's nightly restart threw ENOENT on every due tick and had
// NEVER run -- silently, because the only symptom was a log line.
//
// Deliberately NOT resumeMarveenSession() with a flag: that path is built around
// --continue (resume-summary modal dismissal, post-resume plugin guard) and none
// of it applies to a fresh start. What IS shared -- the two reaps, the onboarding
// re-seed, the respawn command builder, the identity + plugin-unlock follow-ups --
// is called here too, so the two paths cannot drift on the parts that matter.
export function respawnMainSessionFresh(): void {
  const provider = getProvider(getMainAgentProvider())
  // Same rationale as the resume path: respawn-pane -k kills the parent claude
  // but leaves grandchild pollers alive, and two pollers on one bot token race
  // for getUpdates (409). Reap BEFORE respawning, never after.
  try {
    reapChannelOrphans(provider.type, PROJECT_ROOT)
  } catch (err) {
    logger.warn({ err }, 'respawnMainSessionFresh: pre-respawn reap failed (continuing)')
  }
  try {
    reapDetachedChannelClaudes({ tmuxPath: tmuxBin() })
  } catch (err) {
    logger.warn({ err }, 'respawnMainSessionFresh: detached-claude reap failed (continuing)')
  }
  ensureSharedClaudeOnboarded()

  const claudeCmd = buildMainSessionRespawnCmd({
    claudePath: claudeBin(),
    pluginId: provider.pluginId,
    extraPluginIds: readExtraChannelPluginIds(),
    model: readConfiguredMainModel(),
    // The main session always starts a new conversation -- this is the whole
    // point of the nightly restart (drop the accumulated context).
    continueSession: false,
    isolatedConfigDir: ensureMainAgentIsolatedConfigDir(),
    fleetToken: hasFleetOauthToken(),
  })
  execFileSync(tmuxBin(), ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
  // Stamp IMMEDIATELY after the respawn, before the scheduling follow-ups.
  // The stamp is a coordination contract, not bookkeeping: five watchers read
  // lastMainRespawnAt() / store/.channel-last-respawn and suppress themselves
  // during the grace window -- including the systemd-timer channel-watchdog,
  // a separate process that can ONLY see the file. Without it, the ~35-90s
  // cold-boot window while plugins unlock looks to them like a dead session,
  // and they can respawn on top of one that is still coming up.
  writeRespawnStamp()

  logger.warn({ provider: provider.type }, 'Main session respawned FRESH (scheduled auto-restart)')
  // The respawned claude is a brand-new process: it has neither the /name
  // identity nor a guaranteed-loaded channel plugin. Both follow-ups mirror the
  // resume path; skipping them is how a restarted session comes back nameless
  // or with the plugin stuck in `◯ disabled`.
  void scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
  schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
}

// Exported so the stuck-tool-call-watcher recovers a wedged main session via
// this respawn-pane path (reap + `tmux respawn-pane -k --continue`) INSTEAD of
// the launchctl hard-restart. respawn-pane replaces only the claude process in
// the pane: it does NOT `tmux kill-session`, so an attached client is never
// kicked ([exited]) -- the #248 user-visible crash. It also runs the
// pane-attribution detached-claude reap first, breaking the orphan->409->freeze
// doom-loop that the launchctl path (channels.sh env-grep reap) never cleaned.
export async function resumeMarveenSession(): Promise<boolean> {
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
      reapDetachedChannelClaudes({ tmuxPath: tmuxBin() })
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: detached-claude reap failed (continuing)')
    }

    // A respawn onto the shared ~/.claude parks on the first-run "Select login
    // method" picker when ~/.claude.json lost hasCompletedOnboarding (2026-07-15
    // bootcamp mass-"/login"); idempotent re-seed before every respawn.
    ensureSharedClaudeOnboarded()

    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: claudeBin(),
      pluginId: provider.pluginId,
      extraPluginIds: readExtraChannelPluginIds(),
      model: readConfiguredMainModel(),
      continueSession: true,
      // Parity with channels.sh: a recovery respawn must also land on the
      // isolated CLAUDE_CONFIG_DIR (macOS), else it re-authenticates from the
      // rotating Keychain and 401s. Returns null when isolation is off/no token,
      // preserving the prior shared-root behaviour.
      isolatedConfigDir: ensureMainAgentIsolatedConfigDir(),
      fleetToken: hasFleetOauthToken(),
    })
    execFileSync(tmuxBin(), ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })

    // --continue replays the last conversation. When the prior session is large
    // (>200k tokens) Claude Code opens with a "Resume from summary" modal that
    // parks the prompt - the plugin never reaches inbound-ready and stage 3
    // silently times out into stage 4. The agent-process startup path already
    // dismisses this modal; we mirror it here for the resume path.
    try {
      await delay(2000)
      await dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
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
      await delay(2000)
      await dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
    }

    logger.warn({ provider: provider.type }, 'Marveen session respawned with --continue')
    // Re-establish /name on the brand-new claude process (the prior session's
    // identity is gone after respawn-pane; channels.sh sets it on a normal
    // start). /remote-control was dropped (the operator no longer uses it).
    // scheduleIdentitySetup only SCHEDULES delayed timers and returns immediately;
    // fire-and-forget (void) is correct here -- there is nothing to await.
    void scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
    // channels.sh runs an /mcp+Up+Enter+Enter unlock probe after launching
    // the main session to revive a Failed/disabled channel plugin (#231/#232),
    // but THIS code path skips channels.sh entirely - tmux respawn-pane is
    // direct. Schedule the same probe in-process so the plugin doesn't get
    // stuck in `◯ disabled` after an in-process respawn (2026-06-01 18:55).
    schedulePluginUnlockAfterRespawn(MAIN_CHANNELS_SESSION, provider.type)
    // Post-resume guard (CC 2.1.193 regression). A --continue resume can come up
    // WITHOUT the --channels plugin (absent from /mcp, no poller -> deaf main
    // channel). The unlock probe above only revives a Failed/disabled plugin --
    // it cannot help when the plugin never loaded at all. Schedule a liveness
    // probe; if the plugin is still missing after the settle, escalate straight
    // to a FRESH respawn instead of burning the full RESUME_GRACE_MS cascade.
    // Context is dropped only in the bad case; a clean --continue keeps it.
    schedulePostResumePluginGuard(provider.type)
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
    // Attribution input for the external-respawn detector below: a stamp we
    // wrote ourselves must never be reported as an external actor.
    lastSelfStampWriteMs = Date.now()
  } catch { /* best effort */ }
}

// --- external-respawn detector (SOAKRESPAWN819) ---
//
// The stamp is consumed by five watchers purely to SUPPRESS themselves, so a
// respawn performed by anyone but this process (channels.sh relaunched by the
// service manager after a watchdog exit, the systemd-timer channel-watchdog,
// a manual operator launch) leaves no dashboard.log trace at all -- the
// evidence quiets the watchers instead of surfacing. Measured live
// (hermes soak box, 2026-08-19): 210 service-manager restarts at a ~40min
// cadence, zero dashboard.log lines. This detector closes that: every stamp
// advance not attributable to a dashboard-initiated respawn is logged loudly.
// WHY the respawn happened lives in store/channels-respawn.log (producer-side
// mirror written by channels.sh); this line says THAT it happened.
let lastSelfStampWriteMs = 0
let lastSeenRespawnStampMs = -1
function checkExternalMainRespawn(): void {
  const stampMs = fileRespawnStampMs()
  if (lastSeenRespawnStampMs < 0) {
    // Boot baseline: whatever the stamp said before this dashboard started is
    // history, not this boot's news -- without this, every dashboard restart
    // after any respawn would fire a spurious external-actor warning.
    lastSeenRespawnStampMs = stampMs
    return
  }
  const verdict = classifyRespawnStampAdvance({
    stampMs,
    lastSeenStampMs: lastSeenRespawnStampMs,
    lastSelfRespawnMs: Math.max(marveenLastHardRestart, marveenLastKeepaliveRespawn, marveenLastSessionCreate, lastSelfStampWriteMs),
    graceMs: MARVEEN_POST_RESPAWN_GRACE_MS,
  })
  if (verdict === 'none') return
  lastSeenRespawnStampMs = stampMs
  if (verdict === 'external') {
    logger.warn(
      { stampAt: new Date(stampMs).toISOString() },
      'Main-session respawn stamp advanced by an EXTERNAL actor (service-manager relaunch of channels.sh, channel-watchdog timer, or manual launch) -- the main session was recreated outside the dashboard; reason breadcrumb: store/channels-respawn.log (SOAKRESPAWN819)'
    )
  }
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
    execFileSync(tmuxBin(), ['has-session', '-t', MAIN_CHANNELS_SESSION], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// Discriminated result instead of a boolean: 'grace' (already kicked, session
// is booting -- benign) and 'script-missing'/'spawn-failed' (the install is
// broken) must NOT look alike to callers. The onboarding launch endpoint
// reports the former as "starting" and the latter as a hard error; a boolean
// collapsed both into a silent false success (PR #779 review).
export type MainSessionCreateResult = 'started' | 'grace' | 'script-missing' | 'spawn-failed'

export function createMainChannelsSession(): MainSessionCreateResult {
  const now = Date.now()
  if (marveenLastSessionCreate && now - marveenLastSessionCreate < MAIN_SESSION_CREATE_GRACE_MS) {
    return 'grace'
  }
  if (!existsSync(CHANNELS_SCRIPT)) {
    logger.error({ script: CHANNELS_SCRIPT }, 'Cannot recreate main channels session: channels.sh missing')
    return 'script-missing'
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
    return 'started'
  } catch (err) {
    logger.error({ err }, 'Failed to recreate main channels session via channels.sh')
    return 'spawn-failed'
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
    // Same first-run-picker guard as resumeMarveenSession.
    ensureSharedClaudeOnboarded()
    const claudeCmd = buildMainSessionRespawnCmd({
      claudePath: claudeBin(),
      pluginId: provider.pluginId,
      extraPluginIds: readExtraChannelPluginIds(),
      model: readConfiguredMainModel(),
      continueSession: false,
      // Same channels.sh-bypass concern as resumeMarveenSession: this fresh
      // respawn also skips channels.sh, so it must carry the isolated config
      // itself or it 401s on the rotating macOS Keychain. null when off/no token.
      isolatedConfigDir: ensureMainAgentIsolatedConfigDir(),
      fleetToken: hasFleetOauthToken(),
    })
    execFileSync(tmuxBin(), ['respawn-pane', '-k', '-t', MAIN_CHANNELS_SESSION, claudeCmd], { timeout: 15000 })
    logger.warn({ provider: provider.type }, 'Hard restart: marveen session respawned fresh (no --continue)')
    // Re-establish /name on the fresh process (see note in resumeMarveenSession).
    // scheduleIdentitySetup only schedules delayed timers -> fire-and-forget.
    void scheduleIdentitySetup(MAIN_CHANNELS_SESSION, BOT_NAME)
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

// Post-resume guard delay. Must clear the unlock-probe budget (first probe at
// ~35s, retries every 15s up to 2x => ~65s worst case) so a plugin that merely
// loaded `disabled` gets revived BEFORE we declare the resume deaf, yet stay
// well under RESUME_GRACE_MS (240s) so a genuinely-absent plugin escalates
// ~150s sooner than the cascade would. 90s leaves a healthy --continue ample
// time to attach its poller; only a pathologically large (>200k-token) context
// resume risks a false escalation, which still self-heals (fresh respawn).
export const POST_RESUME_GUARD_DELAY_MS = 90_000

// PURE decision for the post-resume guard: after a --continue resume, do we have
// to escalate to a fresh respawn? Yes iff the resumed session is NOT serving the
// channel plugin -- either the claude pid is gone, or the pid is alive but the
// plugin never attached (the CC 2.1.193 regression). A live pid WITH the plugin
// means --continue succeeded and the conversation context is preserved.
export function shouldEscalateAfterResume(f: { claudePid: number | null; pluginAlive: boolean }): boolean {
  if (f.claudePid == null) return true
  return !f.pluginAlive
}

// Scheduled (non-blocking) check fired after a --continue resume. If the
// channels plugin attached, the resume succeeded and the conversation context
// is preserved -- nothing to do. If it did not (CC 2.1.193: --continue does not
// re-init the plugin MCP server), escalate to a FRESH respawn so the main
// channel becomes reachable again. respawnMarveenSessionFresh() writes the
// respawn stamp, so lastMainRespawnAt() suppresses the down-cascade's redundant
// stage-4 hard restart during the ensuing cold boot.
function schedulePostResumePluginGuard(provider: ChannelProviderType): void {
  setTimeout(() => {
    try {
      const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
      const pluginAlive = claudePid != null && hasChannelPluginAlive(claudePid, provider)
      if (!shouldEscalateAfterResume({ claudePid, pluginAlive })) {
        logger.info({ provider }, 'Post-resume guard: channel plugin attached after --continue -- context preserved, no escalation')
        return
      }
      logger.warn({ provider }, 'Post-resume guard: --continue resume came up WITHOUT the channels plugin (CC 2.1.193) -- escalating to fresh respawn (context dropped, memory persists)')
      sendAlert(`⚠️ A --continue resume suketen jott fel (nincs channel plugin). Fresh respawn most a ${MAIN_CHANNELS_SESSION} session-on (a beszelgetes elveszik, memoria marad).`)
      respawnMarveenSessionFresh()
    } catch (err) {
      logger.warn({ err }, 'Post-resume guard probe failed (leaving recovery to the down-cascade)')
    }
  }, POST_RESUME_GUARD_DELAY_MS)
  logger.info({ delayMs: POST_RESUME_GUARD_DELAY_MS }, 'Post-resume plugin guard scheduled after --continue resume')
}

export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {
  // FABLEFALL1: the restarted session boots from the main/worker shared config
  // roots, which the per-agent spawn-time stamp never covers -- stamp them now
  // so the model consent dialog cannot render on the fresh boot (change-only,
  // no-op when already stamped).
  try { stampFableOverageConsentSharedRoots() } catch { /* backstop handlers remain */ }
  // macOS: bounce the launchd job when the plist exists. If the channels session
  // is NOT managed by launchd on this install (plist absent -- only
  // com.jarvis.dashboard exists), fall through to the respawn-pane path below.
  // The previous unconditional launchctl call was a silent no-op: launchctl
  // accepts a non-existent plist with exit 0, leaving the session untouched.
  if (process.platform !== 'linux' && existsSync(MAIN_CHANNELS_PLIST)) {
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

  if (process.platform !== 'linux') {
    logger.warn({ plist: MAIN_CHANNELS_PLIST }, 'Hard restart: launchd channels plist absent -- falling back to respawn-pane')
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
  // Busy-guard: never hard-restart while the main pane is actively generating --
  // a parked <channel> block then is a busy session, not a wedge. See
  // applyStuckRestartBusyGuard. detectPaneState reads 'unknown' for an
  // unreadable pane and the guard fails-open on that, so a broken capture never
  // blocks a genuine recovery.
  const paneContent = capturePane(MAIN_CHANNELS_SESSION)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  // Deadlock carve-out facts: read from the ghost-stripped parked view (same
  // view the soft recovery uses) so a dim autocomplete hint never counts.
  const parkedView = paneState === 'typing' ? captureParkedInputView(MAIN_CHANNELS_SESSION) : null
  const machineOrigin = parkedView != null && parkedMachineOriginInput(parkedView)
  const softRemedy = parkedView != null && parkedMainInputHasRemedy(parkedView)
  const action = applyStuckRestartBusyGuard(paneState, decideStuckInputRestart(
    parked, state.attempts, MAIN_STUCK_THRESHOLDS.maxAttempts,
    Date.now(), lastStuckRestartAt, stuckRestartCount,
    STUCK_RESTART_MIN_INTERVAL_MS, STUCK_RESTART_MAX_CONSECUTIVE,
  ), { machineOrigin, softRemedy })
  if (action === 'skip' && shouldDeferKeepaliveRespawn(paneState)) {
    logger.info(
      { paneState, attempts: state.attempts, machineOrigin, softRemedy },
      paneState === 'busy'
        ? 'Stuck-input restart deferred -- main pane is busy (working, not wedged)'
        : 'Stuck-input restart deferred -- parked input still recoverable or possibly a human draft',
    )
  }
  if (action === 'skip') return
  if (action === 'alert') {
    logger.error({ session: MAIN_CHANNELS_SESSION }, 'Stuck main channel input survived max restart escalations -- manual intervention needed')
    sendAlert(`⛔ A ${MAIN_CHANNELS_SESSION} bemenete beragadt es ${STUCK_RESTART_MAX_CONSECUTIVE} automatikus respawn-pane sem szabaditotta ki. Kezi beavatkozas kell: inditsd ujra a ${SERVICE_ID}-channels szolgaltatast.`)
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

async function handleMarveenDown(): Promise<void> {
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
    await triggerMarveenMemorySave()
    return
  }
  if (marveenDownState.stage === 'save') {
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
    marveenDownState.stage = 'resume'
    marveenDownState.stageStartedAt = now
    marveenDownState.lastAlertAt = now
    logger.warn({ provider: providerLabel }, 'Marveen channel plugin still down -- stage 3 (session resume)')
    await resumeMarveenSession()
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
    sendAlert(`🚨 ${BOT_NAME} ${providerLabel} plugin meg mindig halott. Nezd meg kezzel.`)
  }
}

function handleMarveenUp(): void {
  marveenSuspectFirstSeen = null
  if (marveenDownState) {
    const downedFor = Math.round((Date.now() - marveenDownState.downSince) / 1000)
    const stage = marveenDownState.stage
    const providerLabel = getMainAgentProvider()
    logger.info({ stage, downedFor, provider: providerLabel }, 'Marveen channel plugin recovered')
    // Owner transparency (2026-07-30, "reggeli leallas"): a resume-stage
    // recovery means the main session was actually respawned -- the owner's
    // in-flight messages may have been dropped, so it must not be silent. Short
    // soft/save blips stay quiet, but a LONG outage is reported even when the
    // fix itself was soft: messages sent into that window went unanswered.
    const disruptive = stage !== 'soft' && stage !== 'save'
    if (disruptive || downedFor >= 180) {
      sendAlert(
        `✅ ${BOT_NAME} ${providerLabel} kapcsolat helyreallt (${downedFor}s kieses, ${stage} szint). ` +
        `Ha a kieses alatt irtal es nem jott valasz, mindjart potolom.`,
      )
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
  // FABLEFALL1 boot pass: stamp the main/worker shared config roots that the
  // per-agent spawn path never reaches, so an already-running unstamped install
  // heals on the next dashboard boot instead of never.
  try { stampFableOverageConsentSharedRoots() } catch { /* backstop handlers remain */ }

  const mainProvider = getMainAgentProvider()

  let checkRunning = false
  async function check() {
    // Re-entrancy guard: check() now awaits the tmux-driving sends (async), and
    // setInterval fires on a fixed cadence regardless of whether the prior tick
    // resolved. Skip a tick that lands while the previous one is still in flight
    // so two overlapping sweeps never double-act on the same session (e.g. two
    // stacked restarts / duplicate re-injects). State advances each tick, so a
    // skipped tick is picked up by the next one.
    if (checkRunning) {
      logger.debug('channel-monitor: previous check still running, skipping this tick')
      return
    }
    checkRunning = true
    try {
    // Restore persisted failure counts on first tick so a dashboard restart
    // does not reset the cap and restart agents that have already been given up on.
    ensureAgentRestartFailuresInitialized()

    // Surface main-session respawns performed by anyone but this process
    // (SOAKRESPAWN819) -- must run every sweep, not only when the plugin
    // probe reaches the main target, so an external churn is visible even
    // while the plugin is structurally down.
    checkExternalMainRespawn()

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
      // First-run gates (fresh-install folder-trust / bypass acceptance /
      // login picker) are detected SEPARATELY from generic blocking menus,
      // because the recovery differs: Escape on the trust/bypass dialogs
      // selects "No, exit" and QUITS the TUI -- the session respawns straight
      // back into the same dialog (respawn loop), which is the fresh-install
      // "scheduled tasks pile up" incident (Oligo2000 VPS, 2026-07-22). These
      // panes get the channels.sh-style dialog answers instead; only the
      // login picker is alert-only (nobody can log in on the operator's behalf).
      const firstRunGate = pane != null ? detectsFirstRunGate(pane) : null
      const inMenu = firstRunGate != null || (pane != null && detectsBlockingMenu(pane))
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
        if (firstRunGate === 'login') {
          logger.warn({ session: t.session, agent: label }, 'Session parked on the Claude Code login picker -- operator login needed, alerting (no keystrokes sent)')
          sendAlert(`🔑 A(z) ${label} agentnek Claude-belépés kell (első indítás, "Select login method" képernyő). Lépj be: tmux attach -t ${t.session}, majd válaszd ki a belépési módot. Addig az ütemezett feladatai és üzenetei várakoznak, belépés után maguktól kézbesítődnek.`)
        } else if (firstRunGate) {
          logger.warn({ session: t.session, agent: label, gate: firstRunGate }, 'Session parked on a Claude Code first-run dialog -- answering the dialog chain')
          const res = await answerFirstRunGates(t.session)
          if (res === 'login') {
            sendAlert(`🔑 A(z) ${label} agent első-indítási dialogjait továbbléptettem, de Claude-belépés kell ("Select login method"). Lépj be: tmux attach -t ${t.session}. Utána minden várakozó feladat magától kézbesítődik.`)
          } else {
            sendAlert(`🧭 A(z) ${label} session a Claude Code első-indítási képernyőjén parkolt (${firstRunGate}); automatikusan továbbléptettem. A várakozó ütemezett feladatok a következő körben kézbesítődnek.`)
          }
        } else {
          // FABLEFALL1: the model usage-credit consent dialog is indistinguishable
          // from a stuck menu out here -- its footer says "Esc to cancel", so
          // detectsBlockingMenu matches it. But Escape on that dialog is recorded
          // as choice:"cancelled" and the CLI still continues on the FALLBACK
          // model (measured: 59 ms Escape->fallback-record at a customer; 5 events
          // and 514 silent Sonnet turns on this install). Probe for the dialog
          // first and answer it safely (option 1, keep the configured model);
          // only a genuine menu gets the blind Escape.
          const paneNow = capturePane(t.session)
          if (paneNow != null && detectsModelConsentDialog(paneNow)) {
            logger.warn({ session: t.session, agent: label }, 'Blocking "menu" is the model usage-credit consent dialog -- answering it safely instead of Escape')
            await dismissModelConsentDialogIfPresent(t.session)
            sendAlert(`🎛️ A(z) ${label} session a modell-hozzájárulás dialóguson parkolt; az 1-es opcióval (a beállított modell megtartása) továbbléptettem. Modellváltás NEM történt.`)
          } else {
            logger.warn({ session: t.session, agent: label }, 'Session parked in a blocking interactive menu -- sending Escape to recover')
            try {
              execFileSync(tmuxBin(), ['send-keys', '-t', t.session, 'Escape'], { timeout: 5000 })
            } catch (err) {
              logger.warn({ err, session: t.session }, 'Menu-recovery Escape failed')
            }
            sendAlert(`⌨️ A(z) ${label} session beragadt egy interaktiv menube (pl. /mcp) es nem dolgozott fel uzeneteket. Kikuldtem egy Escape-et, visszateritettem a prompthoz. Ha ismetlodik: tmux attach -t ${t.session}`)
          }
        }
      }
    }

    // Stuck channel-input recovery (main + sub-agents). Recover a channel
    // notification stranded at the ❯ prompt by getting it SUBMITTED. The gate
    // (parkedChannelInput != null) fires ONLY for a parked <channel> block, so
    // a human's own hand-typed draft is never touched. Enter-first (faithful);
    // escalate to clear+re-inject only after MAIN_STUCK_ENTER_ATTEMPTS, and
    // only when the captured block looks COMPLETE -- a truncated capture stays
    // on Enter rather than risk a partial re-inject to the wrong chat_id.
    mainStuckInput = await recoverStuckInputForSession(MAIN_CHANNELS_SESSION, mainStuckInput, MAIN_STUCK_THRESHOLDS, false)
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
      const next = await recoverStuckInputForSession(t.session, prev, MAIN_STUCK_THRESHOLDS, true)
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
            if (shouldEscalateMarveenDown() && createMainChannelsSession() === 'started') {
              marveenDownState = null
              marveenSuspectFirstSeen = null
            }
          } else if (shouldEscalateMarveenDown()) {
            await handleMarveenDown()
          }
        }
        continue
      }
      const liveness = probeChannelPluginLiveness(claudePid, t.provider, t.agentName)
      if (liveness === 'unknown') {
        // The PROBE failed (ps timed out, state dir unreadable) -- that is not
        // evidence about the plugin. Leave every counter untouched (down-since,
        // failure budget, main escalation) and re-probe on the next sweep, so a
        // hiccup in our own monitoring can never hard-restart a healthy agent.
        logger.debug({ session: t.session, provider: t.provider }, 'Channel-plugin liveness unknown (probe failed) -- no action this sweep')
        continue
      }
      if (liveness === 'alive') {
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
          clearPersistedAgentFailures(t.agentName!)
          agentBusyDeferAlerted.delete(t.session)
          // Retire any stale absent verdict too, so a future down-spell starts
          // with the full restart budget rather than the absent-capped one.
          clearPluginAbsent(t.session)
        }
        continue
      }
      if (t.isMarveen) {
        if (shouldEscalateMarveenDown()) await handleMarveenDown()
      } else {
        if (!agentDownSince.has(t.session)) {
          agentDownSince.set(t.session, Date.now())
          // First down observation of this spell: capture WHY before anything is
          // torn down. Without this the restart destroys the evidence and the
          // log can only say "down" -- which is exactly why the 10x/day churn
          // went undiagnosed. Once per spell, not per sweep.
          try {
            const evidence = collectPollerEvidence(t.provider, agentDir(t.agentName!), claudePid)
            logger.warn({ agent: t.agentName, provider: t.provider, claudePid, ...evidence },
              evidence.interpretation === 'in-tree'
                ? 'Plugin-down FORENSICS: a live poller IS in the claude tree -- the liveness probe is wrong, not the plugin'
                : evidence.interpretation === 'orphaned'
                  ? 'Plugin-down FORENSICS: a live poller exists but is OUTSIDE the claude tree (reparented / left over from a previous claude)'
                  : 'Plugin-down FORENSICS: no poller process alive for this channel dir -- the plugin really did exit')
          } catch (err) {
            logger.warn({ err, agent: t.agentName }, 'Plugin-down forensics failed (continuing)')
          }
        }
        const lastRestart = agentLastRestart.get(t.agentName!)
        const failures = agentRestartFailures.get(t.agentName!) ?? 0
        // If the unlock probe confirmed the plugin ABSENT from /mcp (never
        // loaded), fresh-restarting cannot fix it -- cap the budget at one
        // attempt so we escalate to the operator instead of nuking the agent's
        // context 5x. A merely Failed/disabled plugin (still in the list) keeps
        // the full budget: a restart genuinely helps that case.
        const absentConfirmed = wasPluginConfirmedAbsent(t.session, PLUGIN_ABSENT_TTL_MS)
        const maxRestartAttempts = absentConfirmed
          ? PLUGIN_ABSENT_MAX_RESTART_ATTEMPTS
          : AGENT_MAX_RESTART_ATTEMPTS
        const msDown = Date.now() - (agentDownSince.get(t.session) ?? Date.now())
        // Busy-guard input: a pane that is generating must not be hard-restarted
        // out from under its own work. An unreadable pane reads 'unknown', which
        // is NOT busy -- we only defer on positive evidence of work in flight.
        const agentPane = capturePane(t.session)
        const agentPaneState = agentPane != null ? detectPaneState(agentPane) : null
        const agentBusy = shouldDeferKeepaliveRespawn(agentPaneState)
        const action = decideDownAgentAction({
          processAgeMs: getProcessAgeMs(claudePid),
          msSinceLastRestart: lastRestart != null ? Date.now() - lastRestart : null,
          startupGraceMs: AGENT_STARTUP_GRACE_MS,
          restartGraceMs: AGENT_RESTART_GRACE_MS,
          consecutiveFailures: failures,
          maxRestartGraceMs: AGENT_MAX_RESTART_GRACE_MS,
          msDown,
          downConfirmMs: AGENT_DOWN_CONFIRM_MS,
          agentBusy,
          busyDeferMaxMs: AGENT_BUSY_DEFER_MAX_MS,
        }, maxRestartAttempts)
        if (action === 'alert-busy') {
          // The channel has been down past the deferral cap while the agent kept
          // working. Killing it would destroy live work; deferring further would
          // leave it deaf. Ask the operator once, then keep deferring.
          if (!agentBusyDeferAlerted.has(t.session)) {
            logger.error({ agent: t.agentName, provider: t.provider, msDown }, 'Agent channel plugin down past busy-defer cap -- agent still working, alerting operator instead of killing it')
            sendAlert(`⚠️ A(z) ${t.agentName} agens ${t.provider} csatornaja ${Math.round(msDown / 60000)} perce halott, de az agens KOZBEN DOLGOZIK. Nem inditom ujra (a restart FRISS session -- elveszne a folyamatban levo munkaja). Dontsd el: varjuk meg amig vegez (akkor magatol ujraindul), vagy kezzel allitsd meg. Session: ${t.session}.`)
            agentBusyDeferAlerted.add(t.session)
          }
          continue
        }
        if (action === 'skip') {
          logger.debug({ agent: t.agentName, provider: t.provider, failures, msDown, agentBusy, paneState: agentPaneState },
            agentBusy
              ? 'Channel plugin down but agent is BUSY -- deferring restart until it goes idle (never kill work in flight)'
              : msDown < AGENT_DOWN_CONFIRM_MS
                ? 'Channel plugin reported down once -- awaiting confirmation on the next sweep before restarting'
                : 'Channel plugin probe reports down but agent is within startup/restart back-off -- deferring')
          continue
        }
        if (action === 'alert') {
          // The cap is reached: restarting is not bringing the plugin back, and
          // each restart costs the agent its whole session context. Stop the
          // loop and hand it to a human. Tick the counter past the cap so this
          // fires exactly once; a later healthy sweep resets it (re-arming the
          // alert for a future down-spell).
          logger.error({ agent: t.agentName, provider: t.provider, failures, absentConfirmed }, 'Agent channel plugin down after max restart attempts -- giving up, alerting operator')
          sendAlert(absentConfirmed
            ? `⛔ A(z) ${t.agentName} agens ${t.provider} plugin-je BE SEM TOLTODOTT (absent a /mcp listabol), a fresh-restart ezt nem javitja -- tovabb nem probalom (minden restart elveszi a session kontextusat). Kezi TISZTA ujrainditas kell (uresen, mas agens indulasaval nem atlapolva): ${t.session}.`
            : `⛔ A(z) ${t.agentName} agens ${t.provider} csatornaja ${AGENT_MAX_RESTART_ATTEMPTS} automatikus ujrainditas utan sem allt helyre. Tovabb nem indinitom ujra (minden restart elveszi a session kontextusat). Kezi beavatkozas kell: nezd meg a ${t.session} session-t es a ${SERVICE_ID} csatorna-plugint.`)
          agentRestartFailures.set(t.agentName!, failures + 1)
          savePersistedAgentFailures(t.agentName!, failures + 1)
          agentDownSince.delete(t.session)
          agentBusyDeferAlerted.delete(t.session)
          continue
        }
        const agentProvider = resolveAgentProvider(t.agentName!)
        const stateDir = channelStateDir(agentProvider, agentDir(t.agentName!))
        const agentToken = readChannelToken(agentProvider, join(stateDir, '.env'))
        if (!agentToken) {
          // A token-less agent (never paired a channel) trips the down-probe on
          // every sweep; the condition is permanent until an operator binds a
          // token, so warn once and drop the repeats to debug.
          if (!agentNoTokenWarned.has(t.agentName!)) {
            agentNoTokenWarned.add(t.agentName!)
            logger.warn({ agent: t.agentName, provider: agentProvider }, 'Agent has no channel token in state dir -- skipping restart to avoid token conflict (further occurrences logged at debug)')
          } else {
            logger.debug({ agent: t.agentName, provider: agentProvider }, 'Agent has no channel token in state dir -- skipping restart to avoid token conflict')
          }
          continue
        }
        agentNoTokenWarned.delete(t.agentName!)
        // Stagger: only one channel-down restart per CHANNEL_RESTART_STAGGER_MS
        // fleet-wide, so fresh sub-agent cold-boots serialise instead of racing.
        if (Date.now() - lastChannelAgentRestartAt < CHANNEL_RESTART_STAGGER_MS) {
          logger.debug({ agent: t.agentName }, 'Channel-down restart staggered -- deferring to avoid simultaneous cold-boot race')
          continue
        }
        logger.warn({ agent: t.agentName, provider: t.provider, failures }, 'Agent channel plugin down -- auto-restarting')
        try {
          await stopAgentProcess(t.agentName!)
          // Settle before the fresh start. stopAgentProcess already reaps this
          // agent's channel orphans + waits 2s; add more so the shared plugin
          // cache (bun run --cwd <plugin>, .in_use markers) fully releases from
          // the torn-down claude before the new one loads the plugin. A too-short
          // gap is the suspected trigger for the plugin coming up ABSENT on a
          // rapid restart (2026-07-01 rocket/mantis loop). Fleet-wide staggering
          // (CHANNEL_RESTART_STAGGER_MS) means this extra block runs at most once
          // per 90s, so it does not stall the monitor's per-agent sweep.
          // Non-blocking (off the event loop); duration preserved exactly (#481
          // plugin-cache-release wait, added 2026-07-01 -- MUST stay 8s, never 2s).
          await delay(8000)
          lastChannelAgentRestartAt = Date.now()
          // FRESH (no --continue): on CC 2.1.193 a --continue resume does NOT load
          // the --channels plugin MCP server, so the agent comes up with no plugin
          // and no poller (verified: continue -> "Plugin not found" in /mcp; fresh
          // -> plugin loads + poller attaches). Context is dropped, memory persists.
          await startAgentProcess(t.agentName!, { fresh: true })
          agentLastRestart.set(t.agentName!, Date.now())
          agentDownSince.delete(t.session)
          agentBusyDeferAlerted.delete(t.session)
          // Count this restart as failed until a later sweep sees the plugin
          // alive (which resets the counter). Repeated failures back off the
          // next restart exponentially instead of churning every base-grace.
          // Persisted to disk so a dashboard restart does not reset the counter.
          agentRestartFailures.set(t.agentName!, failures + 1)
          savePersistedAgentFailures(t.agentName!, failures + 1)
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
        const reaped = reapDetachedChannelClaudes({ tmuxPath: tmuxBin() })
        if (reaped.length > 0) {
          logger.warn({ reaped }, 'channel-monitor: periodic reap removed detached channel-claude orphans')
        }
      } catch (err) {
        logger.warn({ err }, 'channel-monitor: periodic detached-claude reap failed')
      }
    }
    } finally {
      checkRunning = false
    }
  }
  setTimeout(() => { void check() }, 30000)
  return setInterval(() => { void check() }, 60000)
}

// Start desired-but-missing agents one at a time (~15s apart). The stagger is
// mandatory: starting several channel agents at once makes them all die in the
// resume-from-summary modal race. A single in-flight burst at a time.
let reconcileBurstInProgress = false
const AGENT_RECONCILE_STAGGER_MS = 15000
function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// --- Commit 3 v1: fleet memory gate (safe-mode) ---
// Before starting a desired-but-down agent, ask scripts/fleet-memory-gate.sh
// whether the current MemAvailable + running-agent count allow it. The reconcile
// storm (every agent respawning at once after a user-manager re-init) drove the
// 7.4 GiB WSL VM to a 6.9G peak and an OOM poweroff (2026-07-09); this defers
// non-core starts under memory pressure. The gate exits 0 = allow, 10 = block
// (safe-mode band / hard pause / cap); it NEVER kills or restarts anything.
// FAIL-OPEN: any error/timeout allows the start, so a broken gate can never
// freeze the fleet (worst case = pre-Commit-3 behaviour). The kill-switch
// MARVEEN_MEM_GATE_DISABLE=1 is honoured inside the script.
const MEM_GATE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'fleet-memory-gate.sh')
function memGateAllowsStart(agentName: string): boolean {
  try {
    execFileSync('/bin/bash', [MEM_GATE_SCRIPT, '--check', agentName], { timeout: 5000, stdio: 'ignore' })
    return true // exit 0 -> allow
  } catch (err: unknown) {
    const status = (err as { status?: number } | null)?.status
    if (status === 10) {
      logger.warn({ agent: agentName }, 'Memory gate blocked agent start (safe-mode / hard pause / cap) -- deferring')
      return false
    }
    logger.debug({ err, agent: agentName }, 'Memory gate check errored -- failing open (allow)')
    return true
  }
}

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
      if (!memGateAllowsStart(name)) continue   // Commit 3 v1: safe-mode / memory gate
      logger.warn({ agent: name }, 'Desired agent not running -- auto-starting (reconcile)')
      try {
        const r = await startAgentProcess(name)
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
