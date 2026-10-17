# Channel-poller reap helpers for scripts/channels.sh (card cc4d0ddd).
#
# Why this exists: the first reap pass in channels.sh sent TERM and KILL to
# every process whose `ps eww -e` line matched `<STATE_ENV_VAR>=<main channel
# dir>` -- as an awk REGEX, and on the environment alone. That variable is
# exported by the session launcher, so everything the main agent starts
# inherits it: its Bash tools, long-running jobs started from them (four
# campaign drivers died this way on 2026-09-23), builds, test databases -- and
# the tmux SERVER whenever channels.sh itself started it. On 2026-09-24 12:23Z
# the dashboard's reaper (the same rule in src/web/channel-poller-reap.ts)
# killed exactly that server, and every agent session on the host went down.
# Measured the same day: of the processes carrying TELEGRAM_STATE_DIR, all 10
# real pollers also carried CLAUDE_PLUGIN_ROOT=.../telegram/<ver>; none of the
# 27 others did.
#
# The two rules here, both literal (index(), never a regex on a path):
#   1. a candidate needs BOTH the exact state-dir token AND a CLAUDE_PLUGIN_ROOT
#      whose value contains /<provider> followed by `/`, `@` or its end;
#   2. whatever matched, the tmux server, every live pane leader and the parent
#      of every live pane leader are never signalled. On Linux the server names
#      itself "tmux: server", so `pgrep -x tmux` does NOT find it (measured);
#      the parent of a pane and the argv[0] basename both do.
# Every signalled pid is logged with its command line (argv only, never the
# environment; secret-looking values masked, at most 240 characters).
#
# Plain POSIX shell and awk (no `sub` as a variable: BSD awk reserves it), so it
# behaves the same under mawk, gawk and the BSD awk and ps of macOS.

# channel_reap_select_pass1 <ENVVAR=chan-dir> </provider>
# Reads `ps eww -e` lines on stdin; prints the pids that carry both markers.
channel_reap_select_pass1() {
  awk -v state="$1" -v prov="$2" '
    # position of t where it starts a whitespace-delimited token, 0 if nowhere
    function tok_start(s, t,    i, rest, j, b) {
      i = index(s, t)
      while (i > 0) {
        b = (i == 1) ? " " : substr(s, i - 1, 1)
        if (b == " " || b == "\t") return i
        rest = substr(s, i + 1); j = index(rest, t)
        if (j == 0) return 0
        i = i + j
      }
      return 0
    }
    # the rest of the token that starts at i, after its first n characters
    function tail_of(s, i, n,    v, e) {
      v = substr(s, i + n)
      e = match(v, /[ \t]/)
      return (e > 0) ? substr(v, 1, e - 1) : v
    }
    {
      i = tok_start($0, state)
      if (i == 0 || tail_of($0, i, length(state)) != "") next
      r = tok_start($0, "CLAUDE_PLUGIN_ROOT=")
      if (r == 0) next
      root = tail_of($0, r, 19)
      k = index(root, prov); ok = 0
      while (k > 0) {
        c = substr(root, k + length(prov), 1)
        if (c == "" || c == "/" || c == "@") { ok = 1; break }
        rest = substr(root, k + 1); m = index(rest, prov)
        if (m == 0) break
        k = k + m
      }
      if (ok && $1 + 0 > 1) print $1
    }'
}

# channel_reap_tmux_procs
# Prints the pid of every process whose argv[0] basename is tmux (a server or a
# client, on any socket). Exits non-zero when the process table cannot be read:
# an empty table is not "no tmux", it is no answer. CHANNEL_REAP_PS (tests only)
# replaces /bin/ps.
channel_reap_tmux_procs() {
  _crt_table="$("${CHANNEL_REAP_PS:-/bin/ps}" -axo pid=,args= 2>/dev/null)" || return 1
  [ -n "$_crt_table" ] || return 1
  printf '%s\n' "$_crt_table" | awk '{ n = split($2, a, "/"); if (a[n] == "tmux") print $1 }'
}

# channel_reap_protected_pids <pane-pids> <tmux-pids>
# Prints the pids that must never be signalled: live pane leaders, their parents
# (the tmux server) and every process whose argv[0] basename is tmux.
channel_reap_protected_pids() {
  for _crp_p in $1; do
    echo "$_crp_p"
    /bin/ps -o ppid= -p "$_crp_p" 2>/dev/null | tr -d ' '
  done
  for _crp_p in $2; do echo "$_crp_p"; done
}

# channel_reap_kill <logfile> <tag> <tmux-binary> <pid>...
# Spares the protected pids, logs one line per pid it signals, then TERM and,
# after 0.3 s, KILL for the survivors.
# When `tmux list-panes` fails (card 217d8669, decision B):
#   - a tmux process still runs: the server exists but cannot be listed, so the
#     live panes are unknown -> signal nothing (fail-safe);
#   - the process table cannot be read: no answer either -> signal nothing;
#   - no tmux process at all: no server, no pane to protect, and the pollers of a
#     dead server are exactly what this pass exists to clean up -> proceed.
channel_reap_kill() {
  _crk_log="$1"; _crk_tag="$2"; _crk_tmux="$3"; shift 3
  _crk_now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  _crk_panes="$("$_crk_tmux" list-panes -a -F '#{pane_pid}' 2>/dev/null)" && [ -n "$_crk_panes" ] \
    && _crk_panes_ok=1 || _crk_panes_ok=0
  # An unreadable process table is no answer about tmux, and without it neither the
  # argv[0] rule nor the pane parents can be resolved: signal nothing, whatever
  # list-panes said.
  if ! _crk_tmuxp="$(channel_reap_tmux_procs)"; then
    echo "$_crk_now channels.sh reap $_crk_tag: fail-safe, the process table is unreadable; signalled nothing:$(printf ' %s' "$@")" >> "$_crk_log"
    return 0
  fi
  if [ "$_crk_panes_ok" = 0 ]; then
    if [ -n "$_crk_tmuxp" ]; then
      echo "$_crk_now channels.sh reap $_crk_tag: fail-safe, tmux list-panes failed while $(printf '%s\n' "$_crk_tmuxp" | wc -l | tr -d ' ') tmux process(es) run; signalled nothing:$(printf ' %s' "$@")" >> "$_crk_log"
      return 0
    fi
    echo "$_crk_now channels.sh reap $_crk_tag: tmux list-panes failed and no tmux process runs (no server); orphan cleanup proceeds" >> "$_crk_log"
  fi
  _crk_prot=" $(channel_reap_protected_pids "$_crk_panes" "$_crk_tmuxp" | tr '\n' ' ') "
  _crk_kill=""; _crk_spared=""
  for _crk_p in "$@"; do
    case "$_crk_prot" in
      *" $_crk_p "*) _crk_spared="$_crk_spared $_crk_p" ;;
      *) _crk_kill="$_crk_kill $_crk_p" ;;
    esac
  done
  for _crk_p in $_crk_kill; do
    _crk_cmd="$(/bin/ps -o args= -p "$_crk_p" 2>/dev/null \
      | sed -E 's/((TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)[A-Za-z0-9_]*=)[^ ]+/\1<redacted>/g; s/(Bearer[ ]+)[^ ]+/\1<redacted>/g' \
      | cut -c1-240)"
    echo "$_crk_now channels.sh reap $_crk_tag: kill pid=$_crk_p cmd=$_crk_cmd" >> "$_crk_log"
  done
  if [ -n "$_crk_spared" ]; then
    echo "$_crk_now channels.sh reap $_crk_tag: spared (tmux server or live pane):$_crk_spared" >> "$_crk_log"
  fi
  if [ -n "$_crk_kill" ]; then
    # shellcheck disable=SC2086
    /bin/kill -TERM $_crk_kill 2>/dev/null || true
    /bin/sleep 0.3
    # shellcheck disable=SC2086
    /bin/kill -KILL $_crk_kill 2>/dev/null || true
  fi
}
