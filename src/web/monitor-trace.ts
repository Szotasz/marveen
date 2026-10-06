// Tick-trace decisions for the channel-monitor (MODALOROSHATOKOR922).
//
// MEASURED 2026-09-22 12:47-12:57: an agent session sat ten minutes on a
// tool-permission prompt. The monitor's blocking-menu pass walks that session
// (it was in the target set), the detectors classify the pane (blockingMenu and
// permissionDialog both true), and by design the pass sends no keystroke there,
// it only alerts. Yet the log holds ZERO menu-pass lines for the whole window --
// none that day at all, the last one two days earlier -- while the router's
// slower 10-minute path did fire. From the outside the two candidate causes
// cannot be told apart: the re-entrancy guard skipping ticks behind a hung
// await (logged at DEBUG, invisible at INFO), or the live 45-line pane reading
// as busy. A missing log line is not a finding until the reporter's threshold
// is known, and here the reporter had no threshold at all.
//
// THIS TRACE DOES NOT FIX THAT SILENCE. It makes it measurable: a rate-limited
// INFO line per menu pass (targets walked, how many read as a menu) and an INFO
// line once the guard has skipped several ticks in a row. The next parked pane
// will then show WHICH of the two it was. The pure decisions live here, with
// zero imports, so they are testable without the monitor's I/O.

export const SKIP_TRACE_THRESHOLD = 3
export const SKIP_TRACE_REPEAT_EVERY = 10
export const MENU_PASS_TRACE_INTERVAL_MS = 5 * 60 * 1000

export interface SkipTraceState { consecutive: number }

/** One skipped tick. Emit at the threshold, then every REPEAT_EVERY-th skip, so a
 *  permanently wedged check() shows up once and keeps showing up without flooding. */
export function decideSkipTrace(
  state: SkipTraceState,
  threshold: number = SKIP_TRACE_THRESHOLD,
  repeatEvery: number = SKIP_TRACE_REPEAT_EVERY,
): { next: SkipTraceState; emit: boolean } {
  const consecutive = state.consecutive + 1
  const emit = consecutive === threshold || (consecutive > threshold && (consecutive - threshold) % repeatEvery === 0)
  return { next: { consecutive }, emit }
}

/** The menu pass ran once more. Emit the trace line at most every intervalMs;
 *  the very first pass after boot emits too, so a dashboard that never reaches
 *  the pass is distinguishable from one that reaches it and sees nothing. */
export function decideMenuPassTrace(lastEmittedAt: number | null, now: number, intervalMs: number = MENU_PASS_TRACE_INTERVAL_MS): boolean {
  if (lastEmittedAt === null) return true
  return now - lastEmittedAt >= intervalMs
}
