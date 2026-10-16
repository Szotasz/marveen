// TMUXEXACT1771 (#1771): tmux resolves a bare `-t NAME` as an exact match first
// and, when no session has that name, as a PREFIX match. So a missing
// `agent-foo` was reported alive while `agent-foo2` existed, and a capture-pane
// or send-keys aimed at it landed in the sibling's terminal (measured on tmux
// 3.6a, private socket: has-session -t agent-foo -> 0, list-panes -t agent-foo
// -> agent-foo2). The `=` prefix makes tmux match the session name exactly.
//
// One form for every call: `=NAME:` (the session's current window). Measured
// on tmux 3.6a for each subcommand the fleet uses -- has-session, kill-session,
// list-panes, capture-pane, send-keys, display-message, respawn-pane,
// set-option (the same scope as the bare form), set/show-environment,
// rename-session -- and it is the form display-message needs: `-t =NAME` (no
// colon) answered rc 0 with an EMPTY #{...} format. A target that already names
// a window or pane (`NAME:0.1`) only gets the `=`.

/** The exact-match tmux target for a session (or session:window[.pane]) name. */
export function exactTmuxTarget(target: string): string {
  if (target.startsWith('=')) return target
  return target.includes(':') ? `=${target}` : `=${target}:`
}

/** The bare session name of a target, exact form or not (`=agent-x:0.1` -> `agent-x`). */
export function sessionOfTmuxTarget(target: string): string {
  return target.replace(/^=/, '').split(':')[0]
}
