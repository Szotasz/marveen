// CHANNELSDUP1023 follow-up (b), Dani's review of #2203: a hard restart reports success when
// launchd started a fresh channels.sh that is still rebuilding the session. If that supervisor
// then cannot bring claude up (a login or start failure), nothing re-checked it. So a
// successful hard restart is followed, HARD_RESTART_VERIFY_MS later, by one measurement: is
// claude running in the main pane? If not, the owner is told.
export const HARD_RESTART_VERIFY_MS = 5 * 60_000

/**
 * Pure: is claude running in the main pane? `paneDead` is tmux's `#{pane_dead}` (null when the
 * pane cannot be read); `claudePid` is what the existing liveness reads
 * (getClaudePidForSession: the pane's own process when it is claude, else a child named claude),
 * so this check and the liveness can never disagree about the same pane (Dani, #2204 review).
 */
export function paneRunsClaude(paneDead: boolean | null, claudePid: number | null): boolean {
  return paneDead === false && claudePid !== null
}

let pending: ReturnType<typeof setTimeout> | null = null

/**
 * One check, HARD_RESTART_VERIFY_MS after a successful hard restart. A newer restart replaces a
 * pending check (only the latest one is judged). The timer is unref'd, so it never holds the
 * process open.
 */
export function scheduleHardRestartVerify(probe: () => boolean, onNoClaude: () => void, delayMs = HARD_RESTART_VERIFY_MS): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    if (!probe()) onNoClaude()
  }, delayMs)
  pending.unref?.()
}
