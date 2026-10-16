// Resume delivery after a restart.
//
// A freshly started session needs ONE prompt to get going again: the context
// guard's resume, or the recovery brief. Both used to wait for a slow clock
// (the guard's 300 s sweep, the brief's fixed 90 s timer), although the pane is
// ready ~11 s after the start (measured: start -> "prompt is up" median 10.9 s,
// max 13.1 s, n=76). Two restart doors (the reconcile auto-start and the API
// restart) had no delivery at all.
//
// deliverWhenReady closes that: look at the pane at firstMs, and while it is not
// ready look again on a backoff. It sends ONLY when the readiness gate says the
// pane is idle, and the send itself must ABORT instead of typing best-effort
// when the pane turns busy between the check and the send (onBusyTimeout:
// 'abort'), so no text ever lands in a busy pane.
//
// Pure on purpose: the readiness check, the send, the clock and the sleep are
// injected, so the module never imports the process layer that calls it
// (agent-process.ts -> restart-recovery-brief.ts -> here) and a test drives it
// with a fake clock.

import { logger } from '../logger.js'

/** What sendPromptToSession answers; only 'sent' means text reached the pane. */
export type DeliverySendOutcome = 'sent' | 'aborted-busy' | 'skipped-locked' | (string & {})

export interface DeliverOptions {
  /** Wait before the FIRST readiness check. Past the identity-setup /rename and
   *  the plugin-unlock keystrokes (start -> /rename max 20.0 s, n=102): a few
   *  seconds of slack past that maximum. */
  firstMs: number
  /** Gaps between the following checks; the last one repeats until the deadline. */
  stepsMs: readonly number[]
  /** Give up this long after the call. */
  deadlineMs: number
}

export const RESUME_DELIVERY_OPTIONS: DeliverOptions = {
  firstMs: 25_000,
  stepsMs: [10_000, 20_000, 30_000],
  deadlineMs: 20 * 60_000,
}

export interface DeliverDeps {
  /** The readiness gate: agent-process.ts isSessionReadyForPrompt. */
  isReady: (session: string) => Promise<boolean>
  /** The send. MUST be the abort-on-busy form (onBusyTimeout: 'abort'). */
  send: (session: string, text: string) => Promise<DeliverySendOutcome>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** False once the obligation is gone (delivered elsewhere, dropped, replaced):
   *  checked before every look so a late loop never sends a stale prompt. */
  stillOwed?: () => boolean
}

export type DeliverResult =
  | { status: 'sent'; attempts: number; elapsedMs: number }
  /** Deadline passed without a send. */
  | { status: 'deadline'; attempts: number; elapsedMs: number }
  /** stillOwed() went false: somebody else delivered or cancelled. */
  | { status: 'withdrawn'; attempts: number; elapsedMs: number }
  /** The text builder returned null: there was nothing to say (the recovery
   *  brief's "no facts, no message" rule), so nothing was typed. */
  | { status: 'nothing-to-say'; attempts: number; elapsedMs: number }
  /** The send threw. NOT retried: a throw can come after part of the text
   *  landed, and a second copy is worse than none. */
  | { status: 'error'; attempts: number; elapsedMs: number; error: unknown }

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })

/**
 * Deliver `text` to `session` as soon as its pane is ready.
 *
 * Gap before check n (0-based): firstMs, then stepsMs[0], stepsMs[1], ...,
 * with the last step repeating. 'aborted-busy' / 'skipped-locked' keep the loop
 * going (nothing was typed); only 'sent' ends it with success.
 */
export async function deliverWhenReady(
  agent: string,
  session: string,
  // A builder runs at SEND time, once the pane is ready, so the text reflects
  // the state then and a null answer ends the delivery quietly.
  text: string | (() => string | null),
  opts: DeliverOptions,
  deps: DeliverDeps,
): Promise<DeliverResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const startedAt = now()
  const elapsed = () => now() - startedAt
  let attempts = 0

  for (let gap = opts.firstMs, i = 0; ; i++) {
    // Never sleep past the deadline: the last look happens AT the deadline.
    const wait = Math.min(Math.max(0, gap), Math.max(0, opts.deadlineMs - elapsed()))
    if (wait > 0) await sleep(wait)

    if (deps.stillOwed && !deps.stillOwed()) {
      return { status: 'withdrawn', attempts, elapsedMs: elapsed() }
    }

    attempts++
    let ready = false
    try {
      ready = await deps.isReady(session)
    } catch (err) {
      // A probe that cannot answer is "not ready", never "ready".
      logger.debug({ err, agent, session }, 'resume-delivery: readiness probe threw; treating as not ready')
    }

    if (ready) {
      // The obligation may have been settled while the probe ran (it takes a
      // couple of hundred ms): re-check synchronously before typing.
      if (deps.stillOwed && !deps.stillOwed()) {
        return { status: 'withdrawn', attempts, elapsedMs: elapsed() }
      }
      let outcome: DeliverySendOutcome
      try {
        const body = typeof text === 'function' ? text() : text
        if (body === null) return { status: 'nothing-to-say', attempts, elapsedMs: elapsed() }
        outcome = await deps.send(session, body)
      } catch (err) {
        logger.warn({ err, agent, session, attempts }, 'resume-delivery: send threw -- not retrying (part of the text may have landed)')
        return { status: 'error', attempts, elapsedMs: elapsed(), error: err }
      }
      if (outcome === 'sent') {
        logger.info({ agent, session, attempts, elapsedMs: elapsed() }, 'resume-delivery: delivered')
        return { status: 'sent', attempts, elapsedMs: elapsed() }
      }
      logger.info({ agent, session, attempts, outcome }, 'resume-delivery: nothing typed (pane turned busy or lane held); will look again')
    }

    if (elapsed() >= opts.deadlineMs) {
      logger.warn({ agent, session, attempts, deadlineMs: opts.deadlineMs }, 'resume-delivery: deadline passed without a delivery -- giving up')
      return { status: 'deadline', attempts, elapsedMs: elapsed() }
    }
    gap = opts.stepsMs.length > 0 ? opts.stepsMs[Math.min(i, opts.stepsMs.length - 1)]! : opts.firstMs
  }
}
