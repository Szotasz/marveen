/**
 * Is anything actually alive in this tmux session?
 *
 * `agentRunState` answers one question -- does the session name appear in
 * `tmux list-sessions` -- and reports 'running' when it does. tmux keeps a
 * session alive after the Claude CLI inside it exits: the pane falls back to a
 * bare shell prompt. From the outside that is indistinguishable from a healthy,
 * idle agent, so the dashboard shows 'idle' for an agent that will never answer
 * again, and the operator finds out by accident.
 *
 * The signal that survives the CLI's death is the pane's FOREGROUND COMMAND.
 * Measured across the live fleet on 2026-09-06: every healthy agent pane
 * reported `claude.exe`; a session with no CLI in it reported its shell.
 *
 * The reading is deliberately paired with the pane state instead of trusted on
 * its own. `pane_current_command` follows whatever process currently owns the
 * pane's terminal, so a transient child could read as a shell for a moment. A
 * pane that still shows work in progress therefore outranks it: 'dead' is only
 * reported when the shell reading AND a non-working pane agree.
 */

import { detectPaneState } from '../pane-state.js'

export type PaneLiveness = 'alive' | 'dead-shell' | 'unknown'

export type ActivityState = 'stopped' | 'dead' | 'working' | 'idle' | 'unknown' | 'error'

// A login shell arrives as '-zsh'; tmux reports the basename, so no paths here.
const SHELL_COMMANDS = new Set([
  'bash', 'zsh', 'sh', 'fish', 'ksh', 'dash', 'tcsh', 'csh', 'login',
])

export function classifyPaneLiveness(paneCommand: string | null): PaneLiveness {
  const name = (paneCommand ?? '').trim().toLowerCase().replace(/^-/, '')
  if (!name) return 'unknown'
  return SHELL_COMMANDS.has(name) ? 'dead-shell' : 'alive'
}

/**
 * The dashboard's live per-agent label, as one pure decision.
 *
 * Order matters: a stopped session is stopped; a pane that shows work in
 * progress is working even if the foreground command looked like a shell; only
 * then does the shell reading turn 'idle'/'unknown' into 'dead'.
 */
export function activityState(opts: {
  running: boolean
  pane: string | null
  paneCommand: string | null
}): ActivityState {
  const { running, pane, paneCommand } = opts
  if (!running) return 'stopped'

  const liveness = classifyPaneLiveness(paneCommand)
  const paneState = pane === null ? null : detectPaneState(pane)

  if (paneState === 'busy' || paneState === 'typing') return 'working'
  if (liveness === 'dead-shell') return 'dead'
  if (paneState === null) return 'unknown'
  if (paneState === 'idle') return 'idle'
  return paneState // 'unknown' | 'error'
}
