// ROOTRESPAWN1001: Claude Code refuses --dangerously-skip-permissions as uid 0
// ("cannot be used with root/sudo privileges for security reasons"), unless
// IS_SANDBOX=1 is set. channels.sh / start.sh exported it into their OWN shell,
// which reaches a tmux pane only when that shell is what CREATES the tmux server:
// a pane gets the server's global environment, not the calling client's (measured
// on tmux 3.6a). When the server already existed without it -- the dashboard
// creating it for the sub-agents, a systemd unit without the variable -- every
// launch and every recovery respawn on a root host died at once, and the main
// pane stayed dead (customer report, 2026-10-01).
//
// So the guard travels INSIDE each launch command and is evaluated by the pane's
// own shell, on the host that runs claude (remote launches included): it holds
// for whoever created the server. It is true for a non-root user too, so it never
// breaks an `&&` chain, and it changes nothing there.
export const ROOT_SANDBOX_ENV = '{ [ "$(id -u)" != 0 ] || export IS_SANDBOX=1; }'
