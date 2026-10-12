import { logger } from '../logger.js'
import { MAIN_AGENT_ID, REMOTE_BLIND_ALERT_MIN_RAW } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { agentRunState, captureParkedInputView, captureInputBoxViews, sendEnterToSession, capturePane } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { recoverStuckInputForSession, sendAlert } from './channel-monitor.js'
import { getPendingBacklogByAgent } from '../db.js'
import {
  stuckInputSignature,
  parkedPasteSignature,
  decideStuckInputRecovery,
  detectPaneState,
  classifyInputBox,
  type PaneState,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'

// RIASZTASZAJ819: the owner alert for a parked-past-max-attempts sub-agent
// fired three times in one afternoon at an agent that was WORKING the whole
// time (its outbound messages bracket every alert timestamp). Parked input at
// a BUSY agent is normal: a message that arrives mid-turn sits in the TUI
// until the turn ends and then submits on its own. The recovery Enters are
// harmless and stay; only the OWNER ESCALATION must require an idle pane.
//
// PURE decision, unit-tested: alert exactly once per spell, and only when the
// give-up threshold is spent AND the pane is NOT busy at this tick.
//   - 'busy'            -> suppress (waiting, not wedged). The spell stays
//                          open, so if the turn ends and the input is STILL
//                          parked, a later idle tick fires the alert -- the
//                          real bug is never silenced, only deferred to the
//                          moment it is distinguishable from waiting.
//   - idle/typing/unknown -> alert: parked input at a non-busy pane after all
//                          recovery attempts is the genuine wedge ('unknown'
//                          deliberately alerts -- an unreadable pane with a
//                          stuck spell deserves eyes, not silence).
// REMOTE agents were silent on every failure path (2026-10-11): a remote
// give-up only logged, and a remote agent whose host is unreachable read as
// "not running" and was dropped without a word. The remote alerts below close
// both; this pure decision covers the unreadable case.
//
// A remote agent the watcher cannot see -- its host unreachable (agentRunState
// 'unreachable') or its pane capture failing -- alerts ONCE after windowMs of
// continuous blindness, and re-arms only after a readable tick. The two causes
// are ONE blind spell: a flip between them neither ends it nor starts a new one.
// A transient ssh blip shorter than the window never alerts.
export interface UnreadableState { since: number | null; alerted: boolean }
export const NO_UNREADABLE: UnreadableState = { since: null, alerted: false }

export function decideUnreadableAlert(
  prev: UnreadableState,
  readable: boolean,
  now: number,
  windowMs: number,
): { alert: boolean; next: UnreadableState } {
  if (readable) return { alert: false, next: NO_UNREADABLE }
  const since = prev.since ?? now
  const alert = !prev.alerted && now - since >= windowMs
  return { alert, next: { since, alerted: prev.alerted || alert } }
}

export function shouldAlertParkedGiveUp(opts: {
  attempts: number
  maxAttempts: number
  alreadyAlerted: boolean
  paneState: PaneState | null
}): boolean {
  const { attempts, maxAttempts, alreadyAlerted, paneState } = opts
  if (alreadyAlerted) return false
  if (attempts < maxAttempts) return false
  if (paneState === 'busy') return false
  return true
}

// Backstop recovery for a swallowed Enter on the channel-notification
// path. Inbound Telegram/Slack messages are delivered into the session by
// the channel plugin, NOT by sendPromptToSession, so the post-send
// Enter-retry budget there cannot cover them. After a long thinking turn
// the closing Enter is occasionally dropped and the user's message is
// left parked in the prompt box with no submit. This watcher captures
// each running agent's pane on a timer, and when the SAME text has been
// parked past the confirm window it recovers it.
//
// REMOTE sub-agents: conservative -- bare recovery Enter only (host-aware).
// channel-monitor owns the clear+re-inject escalation at the slower 60s
// cadence, and re-inject (clear + sendPromptToSession) is local-tmux only, so
// a remote-host agent cannot use it here.
//
// LOCAL sessions (the MAIN channels session AND local sub-agents): this fast
// 15s loop drives the FULL robust escalation (Enter-first, then clear +
// re-inject of the COMPLETE <channel> block or, for a sub-agent, any complete
// parked text) via the shared recoverStuckInputForSession. A bare Enter is
// frequently swallowed by the Claude TUI in raw mode, so the previous "Enter
// x3 then give up" left a parked input wedged for minutes until
// channel-monitor's slow escalation (or a manual restart) caught up. Running
// the real re-inject here drops the mean-time-to-recovery from ~3min to
// ~30-45s and actually SUBMITS the message. channel-monitor stays as a slower
// backstop (and owns MAIN's give-up alert + rate-limited hard restart); in
// practice this loop clears the spell long before the 90s-confirm backstop
// escalates, so they do not double-act.
//
// The escalation/decision logic is the pure recoverStuckInputForSession +
// decideStuckInputRecovery (unit-tested in pane-state); this module is only
// the I/O + per-session state map, mirroring channel-health-monitor.ts.

// REMOTE sub-agents: bare-Enter recovery only (no local tmux for re-inject).
const THRESHOLDS: StuckInputThresholds = {
  // The same text must stay parked this long before the first recovery
  // Enter. A real turn transitions typing -> busy within a second or two
  // of submit, so 10s comfortably clears the frame race while still
  // recovering a genuinely swallowed Enter quickly.
  confirmMs: 10_000,
  // Gap between recovery Enters within one spell.
  dedupMs: 12_000,
  // A pane still parked after this many Enters is not the swallowed-Enter
  // case (e.g. a paste placeholder, which detectPaneState already treats
  // as busy and so never reaches here anyway); stop and log.
  maxAttempts: 3,
}

// LOCAL full-escalation thresholds: drive the robust escalation on the fast
// tick for any LOCAL session (the MAIN channels session and local sub-agents).
// confirm/dedup are aligned to the 15s interval so the first Enter fires
// after ~1 confirm window, the two Enter attempts are spent within ~2-3
// ticks, and clear+re-inject escalation begins ~30-45s in (vs ~3min on the
// 60s channel-monitor). maxAttempts leaves room for 2 Enters + 3 re-inject
// attempts before giving up and alerting.
const LOCAL_FAST_THRESHOLDS: StuckInputThresholds = {
  confirmMs: 12_000,
  dedupMs: 12_000,
  maxAttempts: 5,
}

const INITIAL_DELAY_MS = 20_000
const INTERVAL_MS = 15_000
// A remote agent the watcher has been blind to (unreachable / capture failing) for this many minutes is alerted
// ONCE -- and only while it has inbound messages waiting: a laptop asleep with nothing queued for it is not an
// incident. MARVEEN_REMOTE_BLIND_ALERT_MIN=0 (Settings page, .env or the process env) turns the blind alert off; unset, empty or not a non-negative number
// means the default (an invalid value is logged by name, never a silent off).
const REMOTE_BLIND_ALERT_DEFAULT_MIN = 15
export function parseBlindAlertMinutes(raw: string | undefined): { minutes: number; invalid: boolean } {
  if (raw == null || raw.trim() === '') return { minutes: REMOTE_BLIND_ALERT_DEFAULT_MIN, invalid: raw != null }
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return { minutes: REMOTE_BLIND_ALERT_DEFAULT_MIN, invalid: true }
  return { minutes: n, invalid: false }
}
const REMOTE_BLIND_ALERT_MS = (() => {
  const raw = REMOTE_BLIND_ALERT_MIN_RAW   // cfg(): Settings override > .env > process env (config.ts)
  const { minutes, invalid } = parseBlindAlertMinutes(raw)
  if (invalid) logger.warn({ MARVEEN_REMOTE_BLIND_ALERT_MIN: raw, usingMinutes: minutes }, 'stuck-input-watcher: MARVEEN_REMOTE_BLIND_ALERT_MIN is empty or invalid -- using the default (0 turns the blind alert off)')
  return minutes * 60_000
})()

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

const watchState = new Map<string, StuckInputState>()
// One owner alert per spell (RIASZTASZAJ819): entries live while a spell is
// open and are dropped with it, so a NEW spell on the same session alerts
// again. Not persisted -- a dashboard restart may re-alert once, acceptable.
const alertedSpells = new Set<string>()
// REMOTE give-up dedup keyed on the PARKED TEXT (session -> parkedSig): the alert for the SAME stuck text re-arms
// ONLY on a proven-empty box (classifyInputBox 'empty': readable, idle, nothing parked, no ghost). A failed capture,
// 'unreachable', a busy turn, a ghost suggestion or an unrecognisable pane all leave it armed.
// In-process, like alertedSpells above (the upstream convention): a dashboard restart may re-alert ONCE for a still
// parked text or a still blind host -- acceptable, and not persisted on purpose (no new state file for an alert dedup).
const remoteAlertedSig = new Map<string, string>()
// REMOTE blindness per AGENT (key host|agent), whatever the cause: an unreachable host and a failing capture are the
// SAME blind spell -- a flip between the two causes neither ends it nor starts a new one, only a readable tick does,
// so an agent already alerted for is not alerted again while it stays blind. One alert per HOST per sweep: the agents
// of a host crossing the window together (a sleeping laptop -- they go blind in the same sweep) give ONE message.
const blindState = new Map<string, UnreadableState>()

// REMOTE give-up: the bare Enters are spent and the input is still parked. A
// remote host has no clear+re-inject here, so -- unlike a local agent -- the
// spell used to end in a log line nobody reads. Same owner gate as the local
// path (RIASZTASZAJ819: never at a BUSY pane, once per spell). For a parked
// PASTE: parkedPasteSignature already returned null if a real busy indicator
// was on screen. For an INPUT: the signature exists only on a 'typing' pane
// (stuckInputSignature), read from the SAME capture -- a busy pane never opens a
// spell, so it never reaches here. Busy is excluded by construction, not by a
// second capture whose view could disagree with the first.
function maybeAlertRemoteGiveUp(label: string, session: string, host: string, attempts: number, kind: 'input' | 'paste', sig: string): void {
  if (remoteAlertedSig.get(session) === sig) return
  if (!shouldAlertParkedGiveUp({ attempts, maxAttempts: THRESHOLDS.maxAttempts, alreadyAlerted: false, paneState: null })) return
  remoteAlertedSig.set(session, sig)
  logger.warn({ label, session, host, kind }, 'stuck-input-watcher: REMOTE sub-agent input still parked after max recovery Enters, alerting (no clear+re-inject on a remote host)')
  sendAlert(`⚠️ A(z) ${label} távoli agens (${host}) bemenete beragadt: ${THRESHOLDS.maxAttempts} recovery Enter nem küldte el, és távoli gépen nincs clear/re-inject. Kézi beavatkozás kell (nézd meg a pane-t, vagy POST /api/agents/${label}/restart).`)
}

// One sweep's view of one remote agent: readable (its pane was captured) or blind, and why.
interface AgentTick { host: string; name: string; readable: boolean; why: 'unreachable' | 'capture' }

const WHY_TEXT = { unreachable: 'a gép / az ssh nem érhető el', capture: 'a tmux-pane nem olvasható' } as const

// Feed one sweep's per-agent readability into the pure decision. An agent past the window is "due"; the due agents
// of one host are alerted together, once, and only while they have inbound messages waiting
// (getPendingBacklogByAgent) -- until then the clock keeps running and the alert stays armed.
function noteRemoteBlindness(ticks: Map<string, AgentTick>, now: number): void {
  for (const k of [...blindState.keys()]) if (!ticks.has(k)) blindState.delete(k)  // agent left the sweep (stopped)
  if (REMOTE_BLIND_ALERT_MS === 0) { blindState.clear(); return }
  const due = new Map<string, Array<{ key: string; tick: AgentTick; next: UnreadableState }>>()
  for (const [key, tick] of ticks) {
    const prev = blindState.get(key) ?? NO_UNREADABLE
    const { alert, next } = decideUnreadableAlert(prev, tick.readable, now, REMOTE_BLIND_ALERT_MS)
    if (tick.readable) { blindState.delete(key); continue }
    // decideUnreadableAlert answers "blind long enough"; the waiting-messages gate decides whether it is an incident
    blindState.set(key, { since: next.since, alerted: prev.alerted })
    if (!alert) continue
    const list = due.get(tick.host) ?? []
    list.push({ key, tick, next })
    due.set(tick.host, list)
  }
  if (due.size === 0) return
  const backlog = getPendingBacklogByAgent()
  for (const [host, list] of due) {
    const agents = list.map(e => e.tick.name)
    const pending = backlog.filter(b => agents.includes(b.agent)).reduce((s, b) => s + b.pending, 0)
    if (pending <= 0) continue
    for (const e of list) blindState.set(e.key, e.next)
    // the REAL elapsed blindness (the longest of the host's due agents), not the window size
    const minutes = Math.max(...list.map(e => Math.round((now - (e.next.since ?? now)) / 60_000)))
    const why = [...new Set(list.map(e => WHY_TEXT[e.tick.why]))].join(' / ')
    logger.warn({ host, agents, why: list.map(e => e.tick.why), pending, minutes }, 'stuck-input-watcher: REMOTE agent(s) blind past the window with messages waiting, alerting')
    sendAlert(`⚠️ A(z) ${host} távoli gépen futó agens(ek) (${agents.join(', ')}) ${minutes} perce nem láthatók (${why}), és ${pending} bejövő üzenet vár rájuk -- a beragadás-figyelő vak. Ellenőrizd a gépet és az ügynököt.`)
  }
}

// Backstop for a PARKED `[Pasted text #N]` placeholder -- a long inbound prompt
// (e.g. a scheduled-task notice > ~700 chars) the TUI collapsed into a paste
// stub whose trailing Enter was swallowed. detectPaneState reads a placeholder
// as 'busy' (correct for the scheduler: don't pile a second prompt on), so the
// 'typing'-gated recovery in checkLocalSession / bareEnterRecovery NEVER fires
// for it and the stub sat parked until a manual keystroke. This runs FIRST per
// session: a placeholder and a typing-parked box are mutually exclusive (a
// placeholder forces detectPaneState -> 'busy', so stuckInputSignature is null),
// so handling the paste case here and skipping the normal path on the same tick
// cannot double-act on one session.
//
// Recovery is a BARE Enter only -- a placeholder submits on a single Enter even
// though it renders across multiple visual rows, and the collapsed paste body is
// not recoverable from the pane (clear + re-inject would DESTROY it). A bare
// Enter submits the real pasted content verbatim, exactly what the manual
// keystroke does. Host-aware, so a remote sub-agent is covered too. Time-gated
// through the shared decideStuckInputRecovery so a healthy paste that submits on
// its own within the confirm window is never Enter-spammed.
//
// Returns true when a parked-paste spell is active (recovered or still inside
// its confirm/dedup window) so the caller SKIPS the normal recovery this tick;
// false when there is no parked paste (caller runs the normal 'typing' path).
function recoverParkedPaste(
  label: string,
  session: string,
  host: string | null,
  thresholds: StuckInputThresholds,
): boolean {
  // (no banner cut needed here: the placeholder is found between the box separators, not in a bottom tail region,
  // so a pinned /rename banner below the footer does not hide it)
  const pane = captureParkedInputView(session, host)
  const sig = pane == null ? null : parkedPasteSignature(pane)
  if (sig == null) return false

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)
  watchState.set(session, next)

  if (recover) {
    logger.info(
      { label, session, attempt: next.attempts },
      'stuck-input-watcher: parked paste placeholder persisted past confirm window, sending recovery Enter',
    )
    sendEnterToSession(session, host)
  } else if (next.attempts >= thresholds.maxAttempts) {
    if (prev.attempts < thresholds.maxAttempts) {
      logger.warn(
        { label, session },
        'stuck-input-watcher: paste placeholder still parked after max recovery Enters, giving up for this spell',
      )
    }
    if (host != null) maybeAlertRemoteGiveUp(label, session, host, next.attempts, 'paste', sig)
  }
  return true
}

// Bare-Enter recovery (host-aware). Used for the MAIN session (host null) and
// for REMOTE sub-agents, where the local-tmux clear+re-inject is not
// available. channel-monitor owns the clear+re-inject escalation for these.
// Returns whether the pane was READABLE this tick (the caller feeds that into
// the remote unreadable-alert).
function bareEnterRecovery(label: string, session: string, host: string | null): boolean {
  // Ghost-stripped view: a bare recovery Enter submits whatever is parked, so a
  // dim autocomplete hint read as parked input would be Enter-submitted as a
  // forged message. captureInputBoxViews' `ghostless` is captureParkedInputView's
  // view (SGR-2 ghost removed) with ONE difference: a pinned /rename title banner
  // is cut first (as capturePane does for delivery), so a remote pane under such a
  // banner classifies normally instead of 'unknown' -- a parked input there gets
  // its recovery Enters like any other. The same capture's `withGhost` tells a
  // proven-empty box from a ghost suggestion for the alert re-arm below.
  const views = captureInputBoxViews(session, host)
  const pane = views?.ghostless ?? null
  // A failed capture is treated as "nothing parked" -- it ends any active
  // spell rather than holding stale state across a transient tmux miss.
  const sig = pane == null ? null : stuckInputSignature(pane)

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckInputRecovery(sig, prev, Date.now(), THRESHOLDS)

  if (next.parkedSig === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }
  // the remote alert re-arms only on a PROVEN-empty box -- never on a failed capture, a busy turn, a ghost or 'unknown'
  if (views != null && classifyInputBox(views.ghostless, views.withGhost).state === 'empty') remoteAlertedSig.delete(session)

  if (recover) {
    logger.info(
      { label, session, attempt: next.attempts },
      'stuck-input-watcher: parked input persisted past confirm window, sending recovery Enter',
    )
    sendEnterToSession(session, host)
  } else if (next.parkedSig !== null && next.attempts >= THRESHOLDS.maxAttempts) {
    // Logged at most once per spell: the give-up is recorded on the tick
    // that spent the last attempt (attempts hits maxAttempts there), not
    // every subsequent tick.
    if (prev.attempts < THRESHOLDS.maxAttempts) {
      logger.warn({ label, session }, 'stuck-input-watcher: input still parked after max recovery Enters, giving up for this spell')
    }
    // The remote owner alert is evaluated on EVERY tick past the cap (not just
    // the crossing one); the parked-text dedup (remoteAlertedSig) suppresses repeats.
    if (host != null) maybeAlertRemoteGiveUp(label, session, host, next.attempts, 'input', next.parkedSig)
  }
  return pane != null
}

// LOCAL session: full robust escalation (Enter -> clear + re-inject) on the
// fast tick. Used for the MAIN channels session AND local sub-agents -- both
// are local tmux, so the clear+re-inject applies. This drops the
// mean-time-to-recovery for a swallowed Enter from ~3min to ~30-45s.
//
// alertOnGiveUp: a local SUB-agent that is still parked after maxAttempts
// surfaces a one-shot alert for a manual restart. The MAIN channels session
// passes FALSE here -- its give-up alert AND the rate-limited hard restart are
// owned by channel-monitor (maybeRestartWedgedMainChannel); alerting here too
// would double-escalate. The fast 15s loop (12s confirm) always reaches its
// recovery long before channel-monitor's 90s confirm, so the two layers do not
// double-act on MAIN.
//
// allowPlainReinject: gates the PLAIN-text re-inject branch (re-typing any
// parked non-<channel> text). MAIN passes FALSE -- a dim prompt-suggestion
// ghost in the MAIN box (no CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION env-var there,
// that is sub-agent-spawn-only) would otherwise be re-typed + submitted as a
// forged message (the 2026-06-26 phantom-injection class). With FALSE, MAIN
// still gets the fast clear+re-inject of a COMPLETE parked <channel> block
// (its real goal -- a stranded Telegram message; that path is independent of
// this flag), only the ghost-risky plain-text branch is closed. Local
// sub-agents pass TRUE: the env-var strips their ghost at the source, so their
// plain re-inject (an inter-agent message the TUI failed to submit) is safe.
async function checkLocalSession(label: string, session: string, alertOnGiveUp: boolean, allowPlainReinject: boolean): Promise<void> {
  const prev = watchState.get(session) ?? NO_STATE
  const next = await recoverStuckInputForSession(session, prev, LOCAL_FAST_THRESHOLDS, allowPlainReinject)

  if (next.parkedSig === null) {
    watchState.delete(session)
    alertedSpells.delete(session)
  } else {
    watchState.set(session, next)
    if (alertOnGiveUp && next.attempts >= LOCAL_FAST_THRESHOLDS.maxAttempts) {
      // RIASZTASZAJ819: the owner escalation requires an IDLE pane. A parked
      // input at a busy agent is a message waiting out the current turn, not
      // a wedge -- three false owner alerts in one afternoon came from
      // exactly this (the agent's own outbound messages bracketed every
      // alert). Recovery attempts above are untouched; only the alert gates.
      const pane = capturePane(session)
      const paneState = pane != null ? detectPaneState(pane) : null
      if (shouldAlertParkedGiveUp({
        attempts: next.attempts,
        maxAttempts: LOCAL_FAST_THRESHOLDS.maxAttempts,
        alreadyAlerted: alertedSpells.has(session),
        paneState,
      })) {
        alertedSpells.add(session)
        logger.warn({ label, session, paneState }, 'stuck-input-watcher: sub-agent input still parked after max recovery attempts at a non-busy pane, alerting for manual restart')
        sendAlert(`⚠️ A(z) ${label} agens bemenete beragadt és az auto-recovery (Enter + clear/re-inject) nem szabadította ki. Valószínűleg kézi restart kell: POST /api/agents/${label}/restart vagy a dashboardon.`)
      } else if (paneState === 'busy' && prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts) {
        // Once per spell, at the crossing tick: say WHY no alert went out, so
        // a real wedge investigation finds the suppression instead of a hole.
        logger.info({ label, session }, 'stuck-input-watcher: parked past max attempts but the pane is BUSY -- input is waiting out the turn, owner alert suppressed until an idle tick (RIASZTASZAJ819)')
      }
    }
  }
}

export function startStuckInputWatcher(): NodeJS.Timeout {
  async function sweep() {
    // The main agent's channels session is named `<id>-channels`, not
    // `agent-<id>`, so isAgentRunning (which checks the agent- prefix)
    // does not apply. Check it directly; capturePane returns null when it
    // is not up, which ends any spell without acting. Main is always local,
    // so it gets the FULL escalation (Enter -> clear + re-inject of the parked
    // <channel> block) here -- previously it was bare-Enter-only and a
    // swallowed Enter could leave an inbound channel message parked until the
    // 60s channel-monitor re-injected it. allowPlainReinject=false: MAIN gets
    // the <channel>-block re-inject but NOT the ghost-risky plain-text branch
    // (no prompt-suggestion env-var on the main session). The give-up alert +
    // the rate-limited hard restart stay owned by channel-monitor (alert=false).
    try {
      // Parked paste placeholder takes precedence (mutually exclusive with a
      // typing-parked box); only run the normal 'typing' recovery when there is
      // no stuck paste this tick.
      if (!recoverParkedPaste(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, null, LOCAL_FAST_THRESHOLDS)) {
        await checkLocalSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, false, false)
      }
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    const remoteTicks = new Map<string, AgentTick>()
    const agentTick = (host: string, name: string, readable: boolean, why: 'unreachable' | 'capture') => {
      remoteTicks.set(host + '|' + name, { host, name, readable, why })
    }
    for (const name of listAgentNames()) {
      const session = resolveAgentSession(name)
      const host = readAgentRemoteHost(name)
      // Tri-state on purpose: for a REMOTE agent 'unreachable' (ssh down) is
      // not 'stopped' -- it is an agent the watcher cannot see, and staying
      // silent about it is how a remote agent sat unwatched for hours.
      const run = agentRunState(name)
      if (run !== 'running') {
        watchState.delete(session)
        // a STOPPED session is gone: a restarted agent parking the same text again is a new incident, not the old one
        // ('unreachable' keeps it -- the session is most likely still alive with the same box)
        if (run === 'stopped') remoteAlertedSig.delete(session)
        if (host != null && run === 'unreachable') agentTick(host, name, false, 'unreachable')
        continue
      }
      try {
        // Local sub-agents get the full robust escalation (with a give-up
        // alert); remote-host ones (no local tmux for clear+re-inject) stay on
        // the host-aware bare Enter. In both cases a parked paste placeholder is
        // handled first via a time-gated bare Enter (the 'typing'-gated paths
        // below never see it -- a placeholder reads as 'busy').
        if (host == null) {
          if (!recoverParkedPaste(name, session, null, LOCAL_FAST_THRESHOLDS)) {
            await checkLocalSession(name, session, true, true)
          }
        } else {
          // recoverParkedPaste returns true only on a readable pane holding a
          // paste; otherwise bareEnterRecovery reports the readability.
          const readable = recoverParkedPaste(name, session, host, THRESHOLDS) || bareEnterRecovery(name, session, host)
          agentTick(host, name, readable, 'capture')
        }
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-input-watcher: agent check error')
        // a check that keeps THROWING is a blind spot too: it must still reach the blind clock, not drop out of it
        if (host != null) agentTick(host, name, false, 'capture')
      }
    }
    try {
      noteRemoteBlindness(remoteTicks, Date.now())
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: remote host check error')
    }
  }

  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(() => { void sweep() }, INTERVAL_MS)
}
