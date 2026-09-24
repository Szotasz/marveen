// The one line tmux wrote, for the structured log (TMUXWINDOWATTR920, 2026-09-20).
//
// execFileSync WITHOUT a stdio option copies the child's stderr onto the parent's
// stderr as well as attaching it to the thrown error (measured with a Node probe).
// For the dashboard the parent stderr is dashboard.error.log, so every caught
// "can't find window/session: ..." from a tmux poller landed there undated and
// unattributed (133 "window" + ~3500 "session" lines measured on the host). The
// callers now pipe stderr and log THIS through the logger with the call site and
// the session -- the signal stays, it just gets a timestamp and an owner.
export function tmuxStderr(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown }
  const raw = typeof e?.stderr === 'string' ? e.stderr : (e?.stderr != null ? String(e.stderr) : '')
  const line = raw.trim() || (typeof e?.message === 'string' ? e.message : String(err))
  return line.slice(0, 200)
}
