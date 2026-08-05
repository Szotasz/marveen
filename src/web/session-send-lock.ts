// Per-session async mutex for the pane delivery path.
//
// DELIVLOCK805: two writers streaming a chunked `send-keys -l` message into the
// SAME tmux pane interleave their chunks (proven reproduction: writer B's text
// landed inside writer A's `[Uzenet @marveen-tol]:` frame, and the two messages
// coalesced into one submitted line). Foreign text inside a trusted-sender
// frame is a prompt-injection surface, so the delivery path must be mutually
// exclusive per pane.
//
// SCOPE (measured, do not overstate): an in-process mutex serializes only the
// writers that ACQUIRE it. Same-process is NOT the same as serialized. As of
// this change EXACTLY TWO call sites take the lock (grep -rln withSessionSendLock
// src -> agent-process.ts, channel-monitor.ts): sendPromptToSession's emit span
// (so every caller that delivers through it -- message-router, schedule-runner,
// inbox-nudge-watcher, channel-monitor delivery, context-guard-runner, the
// stuck-input re-inject, agent-worker dispatch, routes/agents /login -- is
// serialized against every other), and channel-monitor's recover-mode
// clear+re-inject. The dashboard singleton (O_EXCL pidfile, index.ts) is what
// makes an in-process mutex sufficient FOR THOSE; no file lock is needed there.
//
// STILL UNGUARDED (in-process writers that hit the pane with a direct tmux
// send-keys and do NOT go through the lock -- tracked as PANEWRITERS805):
// channel-mcp-reconnect.ts, channel-plugin-unlock.ts, reauth-healer.ts,
// agent-worker.ts's /clear, routes/agent-terminal.ts, and sendPromptToSession's
// OWN three modal dismissals (dismissSurveyModal / dismissResumeSummary /
// dismissModelConsent), which run BEFORE the lock is taken. Also NOT covered:
// the channel plugin's own in-band delivery -- a separate bun poller process
// that injects channel text through the plugin runtime and never calls
// sendPromptToSession, so no in-process lock can reach it (a cross-process file
// lock would be a separate change). A reader must not assume the pane is fully
// serialized: it is serialized for the two acquirers above, no more.

const delay = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

// Default fail-open budget: how long a `deliver` caller waits for a busy lane
// before writing WITHOUT the lock. Sized well above a normal chunked delivery
// (a long message is seconds) so fail-open only trips on a genuinely stuck
// holder, never on ordinary queueing.
export const DEFAULT_DELIVER_WAIT_BUDGET_MS = 60_000

interface Lane {
  busy: boolean
  // FIFO waiters; each resolver, when called, hands lane ownership to that waiter.
  queue: Array<() => void>
}

const lanes = new Map<string, Lane>()

function keyFor(session: string, host: string | null): string {
  return `${host ?? 'local'}::${session}`
}

function laneFor(key: string): Lane {
  let lane = lanes.get(key)
  if (!lane) {
    lane = { busy: false, queue: [] }
    lanes.set(key, lane)
  }
  return lane
}

// Hand the lane to the next waiter, or mark it free. Ownership stays "busy"
// while it passes from one holder to the next so no third caller can slip in.
function handOff(lane: Lane): void {
  const next = lane.queue.shift()
  if (next) next()
  else lane.busy = false
}

// 'held' is handled by the caller (sendPromptToSession) as "already inside the
// lane, emit directly" -- it never reaches withSessionSendLock. It lives in the
// union so callers can thread it through the same opts.lockMode field.
export type SendLockMode = 'deliver' | 'recover' | 'held'

export interface SendLockResult<T> {
  // false only in `recover` mode when the lane was busy and we skipped.
  ran: boolean
  // true in `deliver` mode when the wait budget elapsed and we ran WITHOUT the
  // lock (fail-open). The delivery still happened; the caller should log it.
  failedOpen?: boolean
  value?: T
}

export interface WithSessionSendLockOpts {
  waitBudgetMs?: number
  // Injectable for deterministic tests; defaults to real setTimeout.
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `fn` as the sole writer to `session`'s pane.
 *
 * mode 'deliver' (fail-OPEN): normal message delivery. Wait for the lane, but
 *   if the wait exceeds the budget, log-and-run WITHOUT the lock. A stuck
 *   holder must never silence the whole fleet -- a rare re-interleave is the
 *   cheaper failure than a wedged delivery path. `failedOpen:true` marks it.
 *
 * mode 'recover' (fail-CLOSED): input-box-mutating self-healing (clear buffer,
 *   blind Enter, unwedge, re-inject). If the lane is busy, DO NOT run -- return
 *   `{ran:false}`. Acting during a live delivery could submit or clear the
 *   wrong thing, so try once and skip; the caller logs the skip (a skip nobody
 *   logs is not a skip).
 */
export async function withSessionSendLock<T>(
  session: string,
  host: string | null,
  mode: SendLockMode,
  fn: () => Promise<T>,
  opts: WithSessionSendLockOpts = {},
): Promise<SendLockResult<T>> {
  const lane = laneFor(keyFor(session, host))
  const sleep = opts.sleep ?? delay

  // Free lane: take it immediately (both modes).
  if (!lane.busy) {
    lane.busy = true
    try {
      return { ran: true, value: await fn() }
    } finally {
      handOff(lane)
    }
  }

  // Busy lane.
  if (mode === 'recover') {
    return { ran: false }
  }

  // deliver + busy: queue, but bound the wait so a stuck holder cannot wedge us.
  let acquired = false
  let resolver!: () => void
  const waiter = new Promise<void>(res => {
    resolver = () => { acquired = true; res() }
    lane.queue.push(resolver)
  })
  const timedOut = await Promise.race([
    waiter.then(() => false),
    sleep(opts.waitBudgetMs ?? DEFAULT_DELIVER_WAIT_BUDGET_MS).then(() => true),
  ])

  if (timedOut && !acquired) {
    // Fail open: pull our still-pending waiter out of the queue so a later
    // handOff does not resolve a phantom holder, then run WITHOUT the lock.
    const idx = lane.queue.indexOf(resolver)
    if (idx !== -1) lane.queue.splice(idx, 1)
    return { ran: true, failedOpen: true, value: await fn() }
  }

  // Acquired within budget: we now own the lane.
  try {
    return { ran: true, value: await fn() }
  } finally {
    handOff(lane)
  }
}

// Test-only: reset lane state between cases.
export function __resetSessionSendLocks(): void {
  lanes.clear()
}
