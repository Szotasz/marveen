// Stuck tool-call watchdog for the main channels session (2026-06-02 incident).
//
// Symptom & root cause (from cold-memory entry `marveen,deafness,Worked for`):
//   Marveen's TUI gets stuck at "Worked for 31s" indefinitely. The Telegram
//   reply tool-call hung server-side (no client-side timeout), and the
//   claude TUI render loop blocks on its stdio pipe. CPU drops to 0.3%,
//   IO-wait. The bun channel-plugin poller is still alive, so #240's
//   bun-alive short-circuit hides the freeze from the main recovery cascade --
//   stage 1-4 never fires. Inbound traffic is read by bun and delivered into
//   the prompt buffer, but the TUI can never act on it: Szabi sees "Marveen
//   válaszol, de a válasz nem jön meg Telegramra".
//
// Detection: parse the TUI's "<verb> for Ns" progress line; if the same
// tag+seconds is observed across multiple polls AND the seconds value has
// reached freezeSeconds, the tool-call is wedged. Recovery (#248 fix) is the
// respawn-pane path resumeMarveenSession() -- NOT the launchctl hard-restart.
// `tmux respawn-pane -k` replaces only the pane's claude process: it does NOT
// `tmux kill-session`, so an attached client is never kicked ([exited], the
// #248 user-visible crash), and it runs the pane-attribution detached-claude
// reap first (breaking the orphan->409->freeze doom-loop the env-grep reap on
// the launchctl/channels.sh path never cleaned). A CPU-profile guard skips the
// recovery unless the process matches the idle stdio-wedge profile.
//
// Critical guard (Marveen 2026-06-02 review): a legitimate long-running
// tool-call (slow Anthropic inference, multi-stage research agent) MUST
// NOT trigger this. Two layers of false-positive protection:
//   1. seconds >= freezeSeconds (180s default) -- below that, just record.
//   2. The counter must be STAGNANT for stagnantPolls (2 default) consecutive
//      polls. A real tool-call increments the seconds every TUI redraw
//      (~once per second). A non-incrementing counter across two 30s poll
//      intervals (60s wall clock at least) is the wedge signature.
// A real wedge satisfies BOTH. A real slow-but-progressing tool-call fails
// the second (counter keeps incrementing) so we never act.
//
// Scope, main session: detect AND recover (respawn-pane), as above.
//
// Scope, sub-agents (SUBWAIT925, card c3f8f062): detect and ALERT only, never
// recover. The case materialised on 2026-09-23: a sub-agent in a strict
// permission profile sat on an approval dialog (a held cross-session message)
// for hours, and nothing told the owner -- this watcher was main-only, the
// channel-monitor's menu pass only walks channel-owning agents and does not
// recognise that dialog, and the router's session-stuck alert needs QUEUED
// inter-agent messages, which a cross-session send never leaves behind. Every
// running sub-agent is now swept for three waiting shapes: a tool-permission
// prompt, a held peer message, and a stagnant tool-call counter. A waiting
// prompt is a QUESTION, not a wedge: the alert says who is waiting and what
// it asks, and never sends a keystroke (Escape would answer "no"). A stagnant
// counter on a sub-agent is reported, not respawned: the respawn path
// (stopAgentProcess + startAgentProcess) discards the agent's working memory,
// so that decision stays with a person or the orchestrator.

import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { tmuxStderr } from './tmux-stderr.js'
import { resolveFromPath } from '../platform.js'
import { PROJECT_ROOT } from '../config.js'
import { capturePane, isAgentRunning, agentSessionName } from './agent-process.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { readTranscriptMtimeFromProjectDir } from './active-model.js'
import { MAIN_CHANNELS_SESSION, withoutMainAgent } from './main-agent.js'
import { resumeMarveenSession, sendAlert, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import { sendRoutineAlert } from './routine-alert.js'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  detectPaneState,
  parkedChannelInput,
  parkedMachineOriginInput,
  detectsPermissionDialog,
  detectsHeldPeerMessage,
  permissionPromptSummary,
  decidePaneErrorAlert,
  type StuckToolCallState,
  type StuckToolCallThresholds,
  type PaneErrorAlertState,
  type PaneErrorAlertThresholds,
  type PermissionPromptSummary,
} from '../pane-state.js'

const TMUX = resolveFromPath('tmux')

// CPU-profile guard (#248): the genuine wedge is a render loop blocked on stdio
// -- CPU collapses to ~0.3% (IO-wait). A frozen "Worked for Ns" counter on a
// process that is STILL BURNING CPU is not that wedge: it is a session doing
// heavy synchronous work that just hasn't yielded to a TUI redraw. Only recover
// when the process matches the idle wedge profile (CPU <= maxCpuPercent).
// Fail-open: a null sample (ps failed) does NOT block recovery -- the
// counter-stagnation signal stands on its own.
const WEDGE_MAX_CPU_PERCENT = 30

// Pure: does the sampled CPU% match the idle stdio-wedge profile? null (sample
// failed) -> true (fail-open; do not block recovery on a missing sample).
export function confirmsWedgeProfile(cpuPercent: number | null, maxCpuPercent: number): boolean {
  if (cpuPercent === null) return true
  return cpuPercent <= maxCpuPercent
}

// STUCKFREEZE819: last-instant verdict-validity gate, at KILL EXECUTION time
// (deliberately NOT folded into the verdict formation -- that would rebuild
// the same gap smaller). Both false kills measured on 2026-08-19 hit a LIVE
// session with a STALE verdict: stagnation accrued during a parked/idle
// stretch, and by the time the kill executed (~2 minutes after the verdict's
// inputs), the session had woken and was working -- the 20:23:19 kill landed
// ONE second after a healthy tool_result, mid-turn (79s of healthy work); the
// 14:08:59 kill landed 9 seconds after an inbox-wakeup injection. The
// cheapest live-signal is the session transcript's mtime: a working session
// appends constantly (measured ages at the two false kills: ~2s and ~9s),
// while a genuinely wedged TUI writes nothing -- by construction its
// transcript is at least freezeSeconds (180s) old when the verdict fires.
//
// Threshold derivation (not a round guess): must sit ABOVE the largest
// measured false-kill age (9s, with margin) and WELL BELOW the 180s
// stagnation floor of a real wedge. 30s = 3x the measured maximum and 6x
// under the floor; any value in (9s, 180s) discriminates the two measured
// populations.
//
// Known limit, stated not hidden: the mtime is DIRECTORY-level (newest jsonl
// under the main session's project dir), so a hypothetical sibling session
// with the same cwd could mask a real wedge -- for at most one sweep at a
// time, because an abort keeps the spell and the next poll re-fires the
// verdict once the masking writer pauses.
export const STALE_VERDICT_FRESH_MS = 30_000

// Pure: is the recovery verdict stale because the session's transcript shows
// recent activity? null mtime (dir unreadable) -> false: fail-open, the
// stagnation signal stands on its own, same rule as the CPU guard.
export function verdictStaleByTranscript(
  transcriptMtimeMs: number | null,
  nowMs: number,
  freshMs = STALE_VERDICT_FRESH_MS,
): boolean {
  if (transcriptMtimeMs === null) return false
  return nowMs - transcriptMtimeMs < freshMs
}

// Recent CPU% of the main session's pane-leader claude (claudePid == panePid for
// the main channels session). null on any failure (fail-open). `ps -o %cpu=` is
// a recent decaying average on macOS/Linux -- enough to tell a 0.3% IO-wait
// wedge from a process actively burning CPU.
function sampleMainClaudeCpuPercent(session: string): number | null {
  try {
    // TMUXWINDOWATTR920: stderr piped; a failure is logged with the site below.
    const panePid = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')[0]?.trim()
    if (!panePid || !/^\d+$/.test(panePid)) return null
    const out = execFileSync('/bin/ps', ['-o', '%cpu=', '-p', panePid], { timeout: 3000, encoding: 'utf-8' }).trim()
    const cpu = parseFloat(out)
    return Number.isFinite(cpu) ? cpu : null
  } catch (err) {
    logger.warn({ site: 'stuck-tool-call-watcher.sampleMainClaudeCpuPercent', session, tmux: tmuxStderr(err) }, 'tmux list-panes / ps failed')
    return null
  }
}

// Defaults chosen against the 2026-06-02 incident profile.
//   - freezeSeconds = 180: long enough that a real slow Anthropic call
//     (multi-thousand-token thinking + tool result) doesn't trip it. The
//     observed wedge sat at 31s, but the seconds value when the freeze
//     actually started is irrelevant -- a wedged 31s sits at 31s forever
//     until we hit freezeSeconds when stagnation IS the signal.
//   - stagnantPolls = 2: with INTERVAL_MS=30s, two consecutive non-
//     incrementing polls means ~60s+ of wall clock without a single TUI
//     redraw advancing the counter. A healthy long-running tool-call
//     redraws every second.
// minPeakSeconds (2026-06-08 fix): the spell's highest observed counter value
// must reach >= this many seconds before recovery can fire. The 2026-06-08
// false-positive loop respawned the session 13 times in 8h on residual TUI
// footers (3-4s every poll, never advancing) left behind by a prior respawn.
// The real 2026-06-02 wedge had climbed to 31s before stalling. 20s sits
// comfortably between the residual band and the real wedge floor.
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
  minPeakSeconds: 20,
}

// Poll cadence. Offset 35s so the three pane-readers (channel-monitor 30s,
// channel-health 45s, stuck-input 15s+20s, this one) don't all hit
// capture-pane on the same tick.
const INITIAL_DELAY_MS = 35_000
const INTERVAL_MS = 30_000

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

// Session-keyed state map. Only the main session ever has an entry today,
// but the map shape leaves room for sub-agents without an API change.
const watchState = new Map<string, StuckToolCallState>()

// Pure: should a hard-restart be deferred because a respawn (any source --
// this watcher, channel-monitor's cascade, channel-watchdog.sh, or the #264
// stuck-modal-guard) happened within the post-respawn grace? lastRespawnMs is
// lastMainRespawnAt()'s epoch-ms (0 when none recorded).
export function shouldDeferForRecentRespawn(
  lastRespawnMs: number,
  nowMs: number,
  graceMs = MARVEEN_POST_RESPAWN_GRACE_MS,
): boolean {
  return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs
}

async function checkSession(label: string, session: string): Promise<void> {
  const pane = capturePane(session)
  const sig = pane == null ? null : stuckToolCallSignature(pane)

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckToolCallRecovery(sig, prev, Date.now(), THRESHOLDS)

  if (next.tag === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }

  if (recover) {
    // Idle-prompt guard (2026-06-22 false-positive loop): the signature only
    // sees a frozen "<verb> for Ns" footer -- it cannot tell an ACTIVELY-wedged
    // tool-call (the 2026-06-02 incident) from the RESIDUAL footer a COMPLETED
    // turn leaves on screen while the session sits idle waiting for its next
    // heartbeat. Both read as a stagnant counter. The discriminator is the input
    // box: a genuine mid-turn wedge has no ready prompt (detectPaneState != idle,
    // the box is replaced by the busy/working indicator), whereas a completed
    // turn's residual sits ABOVE a live `❯` idle prompt. If the pane is idle, the
    // user can interact -- it is not the user-facing freeze this watcher targets
    // -- so respawning is pure churn (this is what drove ~150 spurious respawns/
    // week, each leaving a fresh residual footer that re-armed the loop). Clear
    // the stale spell so the residual stops re-triggering every poll. Fail-open:
    // a null pane (capture failed) does NOT block recovery.
    if (pane != null && detectPaneState(pane) === 'idle') {
      logger.info(
        { label, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds },
        'stuck-tool-call-watcher: counter stagnant but pane is at the idle prompt (residual footer of a completed turn, not a wedge) -- skipping recovery',
      )
      watchState.delete(session)
      return
    }
    // Parked-channel-input guard (2026-08-15, owner-observed false positive).
    // The idle-prompt guard above is the ONLY thing holding back a residual
    // footer -- and it stops holding the instant an inbound channel message is
    // injected into the prompt box, because detectPaneState then reads 'typing',
    // not 'idle'. Measured sequence that day: the counter had been frozen at 49s
    // since ~14:52 and was correctly skipped as residual at 14:52, 14:56 and
    // 15:00; the owner's message landed at 15:03:06; at 15:04:05 the guard no
    // longer applied, CPU was still low (the turn had not started yet), and this
    // watcher respawned the pane -- taking the not-yet-processed message with it.
    // So the ARRIVAL of a message opened the gate on evidence that predated it.
    // A parked channel block is not wedge evidence: it means the session is
    // about to be driven, and that case belongs to stuck-input-watcher, which
    // has its own escalation (Enter -> clear+re-inject -> respawn). Clear the
    // stale spell so the residual cannot re-arm on the next poll.
    // STUCKSCHED831: the guard was CHANNEL-ONLY, and that is narrower than the
    // reason it exists. parkedChannelInput() matches `<channel source="plugin:`
    // and nothing else, so a parked SCHEDULED-TASK injection (heartbeat, audit,
    // dream-engine) slipped through every gate: the pane is no longer 'idle'
    // (so the idle-prompt guard above stops applying), it is not a channel
    // block (so this guard missed it), and CPU is still low because the turn
    // has not started yet. Measured on this install 2026-08-18: 14:11:08 the
    // idle-prompt guard correctly skipped, 14:15:08 the watcher respawned an
    // idle session, and the first input after the respawn came back TRUNCATED
    // and fused with the next command -- the same damage shape as the
    // 2026-08-15 channel-message case this guard was written for.
    // The discriminator was never "is it a channel message" but "is something
    // machine-injected parked in the box", i.e. the session is about to be
    // driven. parkedMachineOriginInput() is exactly that predicate and is a
    // strict superset (its prefix list includes the channel regex), so the
    // 2026-08-15 behaviour is preserved.
    if (pane != null && (parkedChannelInput(pane) != null || parkedMachineOriginInput(pane))) {
      logger.info(
        { label, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds },
        'stuck-tool-call-watcher: counter stagnant but machine-injected input is parked in the prompt (stuck-input-watcher owns this) -- skipping recovery',
      )
      watchState.delete(session)
      return
    }
    // Post-respawn grace: defer if a respawn (this watcher, channel-monitor's
    // cascade, channel-watchdog.sh, or the #264 stuck-modal-guard on Linux)
    // happened within the grace window. Two reasons: (1) a freshly respawned
    // session's TUI counter can read as a fresh "spell" while it is still
    // booting -- re-restarting it would churn; (2) it symmetrizes coordination
    // with every other respawner via the shared lastMainRespawnAt() stamp, so a
    // recent external respawn can't be double-acted here (bounded the worst
    // case to a single overlap; this closes it). A genuine re-wedge is still
    // caught: the stagnation detection (freeze threshold + 2 stagnant polls)
    // restarts the clock, so it fires again once the grace has elapsed.
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, Date.now())) {
      logger.info(
        { label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'stuck-tool-call-watcher: recent respawn within grace, deferring recovery (avoid double-respawn / boot churn)',
      )
      return
    }
    // CPU-profile guard (#248): the genuine wedge is a render loop blocked on
    // stdio (CPU ~0.3%, IO-wait). A counter that froze while the claude is still
    // burning CPU is heavy synchronous work / render starvation, not the wedge
    // -- respawning it is churn. Skip unless the process matches the idle
    // profile. Fail-open on a null sample.
    const cpuPercent = sampleMainClaudeCpuPercent(session)
    if (!confirmsWedgeProfile(cpuPercent, WEDGE_MAX_CPU_PERCENT)) {
      logger.info(
        { label, session, cpuPercent, maxCpuPercent: WEDGE_MAX_CPU_PERCENT, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: counter stagnant but claude is CPU-active (not the idle wedge profile) -- deferring recovery',
      )
      return
    }
    // STUCKFREEZE819: last-instant validity re-check at the kill boundary.
    // Every earlier guard sampled state at VERDICT time; this one samples at
    // EXECUTION time, because the two are ~2 minutes apart and both measured
    // false kills happened exactly in that gap (the session woke up between
    // verdict and kill). Abort keeps the spell: a real wedge re-fires on the
    // next poll, so this gate can only delay a true recovery by one sweep.
    const transcriptMtime = readTranscriptMtimeFromProjectDir(PROJECT_ROOT)
    if (verdictStaleByTranscript(transcriptMtime, Date.now())) {
      logger.warn(
        { label, session, transcriptAgeMs: transcriptMtime ? Date.now() - transcriptMtime : null, freshMs: STALE_VERDICT_FRESH_MS, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: verdict stale -- the session transcript was written moments ago, the session is alive; ABORTING recovery (STUCKFREEZE819)',
      )
      return
    }
    // Audit log requested by Marveen 2026-06-02: every respawn this watcher
    // decides on must record the input that led to it, so a regression
    // (spurious respawn during legitimate long work) is easy to spot.
    logger.warn(
      {
        label,
        session,
        tag: next.tag,
        seconds: next.lastSeconds,
        spellPeakSeconds: next.spellPeakSeconds,
        stagnantPolls: next.stagnantPolls,
        cpuPercent,
        thresholds: THRESHOLDS,
      },
      'stuck-tool-call-watcher: TUI counter stagnant past freeze threshold + idle wedge profile -- recovering main channels session (respawn-pane, no client-kick)',
    )
    // Recover via the respawn-pane path (resumeMarveenSession), NOT the launchctl
    // hard-restart. respawn-pane -k replaces only the pane's claude process: no
    // `tmux kill-session`, so an attached client is never kicked ([exited], the
    // #248 user-visible crash). resumeMarveenSession also runs the
    // pane-attribution detached-claude reap FIRST, breaking the
    // orphan->409->freeze doom-loop that the launchctl/channels.sh env-grep reap
    // never cleaned (the loop's launchctl path never reaped the main orphans).
    const ok = await resumeMarveenSession()
    if (!ok) {
      logger.error({ label, session }, 'stuck-tool-call-watcher: respawn-pane recovery failed')
    }
    // Owner transparency (2026-07-30, "reggeli leallas"): every wedge recovery
    // used to be silent, so the owner discovered a dead morning session only by
    // messaging into the void and then spent the morning pasting logs. One
    // proactive report replaces that whole loop. Sent on both outcomes -- a
    // FAILED recovery is exactly when the owner must know.
    // A SUCCEEDED recovery is routine: throttled, so a session that keeps
    // wedging reports once with a count instead of once per wedge. A FAILED
    // recovery is never throttled -- that is exactly when the owner must know.
    if (ok) {
      // A számot ne úgy írjuk ki, mintha időtartam lenne: a lastSeconds a
      // KIJELZŐN BEFAGYOTT számláló értéke, a beavatkozás küszöbe viszont a
      // stagnálás wall-clock hossza (freezeSeconds). A korábbi szöveg ("49s óta
      // nem haladt") azt sugallta a tulajnak, hogy 49 másodperc után
      // újraindítunk -- 2026-08-15-én pontosan ezt kérdezte vissza.
      sendRoutineAlert(
        `main-stuck-tool-call:${session}`,
        `🔧 A fő session beragadt: a kijelző számlálója ${Math.round(next.lastSeconds ?? 0)}s-nál megállt, és több mint ${THRESHOLDS.freezeSeconds}s-ig nem mozdult. Automatikusan újraindítottam a beszélgetés megtartásával. Ha volt megválaszolatlan üzeneted, mindjárt válaszolok rá.`,
      )
    } else {
      sendAlert(`🚨 A fő session beragadt, és az automatikus újraindítás NEM sikerült. Kézi beavatkozás kellhet: tmux attach -t ${session}, vagy scripts/stop.sh && scripts/start.sh a marveen mappából.`)
    }
  }
}

// ---- sub-agents: alert-only (SUBWAIT925, card c3f8f062) ---------------------

export type AgentWaitKind = 'permission' | 'peer-message'

// Pure: which waiting shape, if any, the pane shows. The tool-permission card
// is checked first because it is the more specific shape (question + Yes/No);
// the held-peer-message dialog is the 2026-09-23 incident shape.
export function classifyAgentWait(pane: string | null): AgentWaitKind | null {
  if (pane == null) return null
  if (detectsPermissionDialog(pane)) return 'permission'
  if (detectsHeldPeerMessage(pane)) return 'peer-message'
  return null
}

// A prompt answered within a few minutes is the strict profile's normal
// rhythm, not an incident; the confirm window keeps those quiet. A prompt
// still open after it is exactly what the owner asked to hear about. The
// dedup window re-reports a prompt that is STILL open (with the routine-alert
// count), and the clear window rides out a flapping capture.
export const AGENT_WAIT_THRESHOLDS: PaneErrorAlertThresholds = {
  confirmMs: 3 * 60 * 1000,
  dedupMs: 30 * 60 * 1000,
  clearMs: 2 * 60 * 1000,
}

export function formatAgentWaitAlert(
  agent: string,
  session: string,
  kind: AgentWaitKind,
  waitingMs: number,
  ask: PermissionPromptSummary | null,
): string {
  const min = Math.max(1, Math.round(waitingMs / 60000))
  if (kind === 'peer-message') {
    return `⏸️ A(z) ${agent} ágens ${min} perce egy másik sessionből érkezett üzenet jóváhagyására vár. Nem hiba: a session él, csak egy igen/nem kérdés áll a bemenet előtt, és azt csak ember válaszolhatja meg. Nem nyomtam meg semmit (az Escape ott elutasítást jelentene). Döntsd el: tmux attach -t ${session}`
  }
  const what = ask ? ` Amit kér: ${ask.title}: ${ask.reason}.` : ''
  return `⏸️ A(z) ${agent} ágens ${min} perce egy tool-engedélykérésre vár.${what} Nem hiba: a session él, egy igen/nem kérdés áll a bemenet előtt, és azt csak ember válaszolhatja meg. Nem nyomtam meg semmit (az Escape ott NEM-et jelentene). Döntsd el: tmux attach -t ${session}`
}

export function formatAgentStuckAlert(agent: string, session: string, state: StuckToolCallState, thresholds: StuckToolCallThresholds): string {
  return `🔧 A(z) ${agent} ágens tool-hívása beragadt: a kijelző számlálója ${Math.round(state.lastSeconds ?? 0)}s-nál megállt, és több mint ${thresholds.freezeSeconds}s-ig nem mozdult. NEM indítottam újra automatikusan (az eldobná a futó munkáját). Nézd meg: tmux attach -t ${session}; ha tényleg beragadt, a dashboardról indítsd újra.`
}

export interface SubAgentSweepDeps {
  listAgents: () => string[]
  isRunning: (agent: string) => boolean
  capture: (agent: string, session: string) => string | null
  now: () => number
  alertWait: (agent: string, session: string, kind: AgentWaitKind, waitingMs: number, ask: PermissionPromptSummary | null) => void
  alertStuck: (agent: string, session: string, state: StuckToolCallState) => void
  waitThresholds?: PaneErrorAlertThresholds
  stuckThresholds?: StuckToolCallThresholds
}

// Per-agent state. Waiting spells and stagnant-counter spells are tracked
// separately: a session can show a frozen residual counter above a fresh
// permission prompt, and the prompt must win (it is the actionable fact).
const agentWaitState = new Map<string, PaneErrorAlertState>()
const agentStuckState = new Map<string, StuckToolCallState>()

export function resetSubAgentWatchState(): void {
  agentWaitState.clear()
  agentStuckState.clear()
}

// One sweep over every running sub-agent. Pure apart from the injected deps,
// so the tests drive it with canned panes and a fake clock. Never throws for
// one agent's sake: a capture failure on one session must not skip the rest.
export function sweepSubAgents(deps: SubAgentSweepDeps): void {
  const waitThresholds = deps.waitThresholds ?? AGENT_WAIT_THRESHOLDS
  const stuckThresholds = deps.stuckThresholds ?? THRESHOLDS
  let agents: string[]
  try {
    agents = withoutMainAgent(deps.listAgents())
  } catch (err) {
    logger.debug({ err }, 'stuck-tool-call-watcher: sub-agent list failed')
    return
  }
  const seen = new Set<string>()
  for (const agent of agents) {
    try {
      if (!deps.isRunning(agent)) continue
      seen.add(agent)
      const session = agentSessionName(agent)
      const pane = deps.capture(agent, session)
      const now = deps.now()

      // 1. Waiting on a person (permission prompt / held peer message).
      const kind = classifyAgentWait(pane)
      const prevWait = agentWaitState.get(agent) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
      const wait = decidePaneErrorAlert(kind != null, prevWait, now, waitThresholds)
      if (wait.next.firstSeenAt === null) agentWaitState.delete(agent)
      else agentWaitState.set(agent, wait.next)
      if (wait.alert && kind != null) {
        const ask = kind === 'permission' && pane != null ? permissionPromptSummary(pane) : null
        logger.warn({ agent, session, kind, waitingMs: now - (wait.next.firstSeenAt ?? now) }, 'stuck-tool-call-watcher: sub-agent is waiting on a person (no keystrokes sent) -- alerting')
        deps.alertWait(agent, session, kind, now - (wait.next.firstSeenAt ?? now), ask)
      }
      if (kind != null) {
        // A prompt replaces the working indicator, so a counter spell cannot
        // be observed meanwhile; drop it rather than let it go stale.
        agentStuckState.delete(agent)
        continue
      }

      // 2. Stagnant tool-call counter: report only, never respawn.
      const sig = pane == null ? null : stuckToolCallSignature(pane)
      const prevStuck = agentStuckState.get(agent) ?? NO_STATE
      const { recover, next } = decideStuckToolCallRecovery(sig, prevStuck, now, stuckThresholds)
      if (next.tag === null) agentStuckState.delete(agent)
      else agentStuckState.set(agent, next)
      if (!recover) continue
      // Same residual-footer and parked-input guards as the main path: an
      // idle prompt or machine-injected input means the session is not wedged.
      if (pane != null && (detectPaneState(pane) === 'idle' || parkedChannelInput(pane) != null || parkedMachineOriginInput(pane))) {
        agentStuckState.delete(agent)
        continue
      }
      logger.warn({ agent, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds, stagnantPolls: next.stagnantPolls }, 'stuck-tool-call-watcher: sub-agent TUI counter stagnant past freeze threshold -- alerting (no recovery for sub-agents)')
      deps.alertStuck(agent, session, next)
      // One report per spell: the routine-alert cooldown throttles repeats,
      // and a fresh spell (the counter moves and freezes again) re-arms.
      agentStuckState.delete(agent)
    } catch (err) {
      logger.debug({ err, agent }, 'stuck-tool-call-watcher: sub-agent check error')
    }
  }
  // Forget agents that stopped, so a restart begins with a clean spell.
  for (const key of [...agentWaitState.keys(), ...agentStuckState.keys()]) {
    if (!seen.has(key)) { agentWaitState.delete(key); agentStuckState.delete(key) }
  }
}

const LIVE_SUB_AGENT_DEPS: SubAgentSweepDeps = {
  listAgents: listAgentNames,
  isRunning: isAgentRunning,
  capture: (agent, session) => capturePane(session, readAgentRemoteHost(agent)),
  now: () => Date.now(),
  alertWait: (agent, session, kind, waitingMs, ask) => {
    sendRoutineAlert(`agent-wait:${agent}`, formatAgentWaitAlert(agent, session, kind, waitingMs, ask))
  },
  alertStuck: (agent, session, state) => {
    sendRoutineAlert(`agent-stuck-tool-call:${agent}`, formatAgentStuckAlert(agent, session, state, THRESHOLDS))
  },
}

export function startStuckToolCallWatcher(): NodeJS.Timeout {
  async function sweep() {
    try {
      await checkSession('main', MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: main session check error')
    }
    try {
      sweepSubAgents(LIVE_SUB_AGENT_DEPS)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: sub-agent sweep error')
    }
  }
  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(() => { void sweep() }, INTERVAL_MS)
}
