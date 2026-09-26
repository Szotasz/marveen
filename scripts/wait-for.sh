#!/usr/bin/env bash
# Wait for a background job to finish, without the watcher finding ITSELF.
#
# Why this exists: on 2026-09-23 three `until ... pgrep -f 'build-images.py'`
# loops of mine spun for 242 MINUTES while the build had been finished since
# 13:43. `pgrep -f` matched the watcher's own command line -- the pattern is in
# it -- so the condition could never become false. A watcher that finds itself
# is not a watcher, it is an infinite loop. The lesson was written into a
# handoff the same day and went off again in the same session, because a
# handoff is read at the START of a session and this mistake happens in the
# MIDDLE of one. So the guard goes where the command is typed.
#
# Modes, BEST FIRST -- use the first one that fits:
#   scripts/wait-for.sh pid <PID>...        wait until the process(es) exit.   BEST:
#                                   no pattern, so nothing to match wrongly.
#   scripts/wait-for.sh file <PATH>...      wait until every path EXISTS.      GOOD:
#                                   looks at the result, not at a process.
#   scripts/wait-for.sh gone <PATH>...      wait until every path is GONE (lockfile).
#   scripts/wait-for.sh port <PORT>...      wait until something LISTENS there.
#   scripts/wait-for.sh pattern <PAT>...    wait until no process matches.     LAST
#                                   RESORT: this is the trap, and the only
#                                   mode that has to defend against it.
#
# Options:  --timeout SEC (default 1800)   --interval SEC (default 5)   --quiet
#
# Exit: 0 = the condition came true.  1 = timed out.  2 = usage error.
# Timing out is a RESULT, not a crash: it is reported and it is non-zero, so a
# `&&` chain stops instead of continuing on a job that never finished.
set -u

TIMEOUT=1800
INTERVAL=5
QUIET=0

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

[ $# -ge 1 ] || usage
MODE="$1"; shift

ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --timeout)  TIMEOUT="${2:-}"; shift 2 || usage ;;
        --interval) INTERVAL="${2:-}"; shift 2 || usage ;;
        --quiet)    QUIET=1; shift ;;
        --help|-h)  usage ;;
        --*)        echo "unknown option: $1" >&2; exit 2 ;;
        *)          ARGS+=("$1"); shift ;;
    esac
done
[ "${#ARGS[@]}" -ge 1 ] || usage
case "$TIMEOUT"  in ''|*[!0-9]*) echo "--timeout needs whole seconds" >&2;  exit 2 ;; esac
case "$INTERVAL" in ''|*[!0-9]*) echo "--interval needs whole seconds" >&2; exit 2 ;; esac
[ "$INTERVAL" -ge 1 ] || INTERVAL=1

say() { [ "$QUIET" = "1" ] || printf '%s\n' "$*"; }

# --- self-exclusion, the whole point of the pattern mode -------------------
# Every pid from here to init, so neither this script nor the shell that
# launched it can ever be counted as "the job we are waiting for".
own_chain() {
    local p=$$ guard=0 parent
    # PORTABILITY (macOS, 2026-09-24 review): this used to read PPid from
    # /proc/<pid>/status, which does not exist on macOS -- every ancestor lookup
    # failed there, the walk stopped at once, and the self-exclusion below was
    # left with nothing to exclude. `ps -o ppid=` is the same answer on both.
    # (The /proc/<pid>/stat field-4 trap that predates this is now moot, but
    # worth remembering: `comm` there is unquoted and shifts every later field.)
    while [ "$p" -gt 1 ] && [ "$guard" -lt 64 ]; do
        printf '%s\n' "$p"
        parent="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' \t')"
        case "${parent:-}" in ''|*[!0-9]*) break ;; esac
        p="$parent"
        guard=$((guard+1))
    done
}

# Processes matching the pattern, MINUS our own chain, minus any process whose
# command line runs this script (a second wait-for.sh watching the same thing
# is not the job either).
matching_pids() {
    local pat="$1" self_name pid cmdline own_list skip o
    self_name="$(basename "$0")"
    # NO mapfile HERE: it is bash 4+, and macOS ships bash 3.2.57. Measured by
    # the reviewer on 2026-09-24: `mapfile: command not found` left `own` unset,
    # `own[@]` tripped `set -u`, the match list came back empty, and the script
    # reported "done after 0s" WHILE THE JOB WAS STILL RUNNING. A watcher that
    # reports success early is worse than one that hangs: the `&&` chain
    # continues on unfinished work. Newline-separated string + `case`, so the
    # code path is identical on bash 3.2 and 5.x.
    own_list="$(own_chain)"
    for pid in $(pgrep -f -- "$pat" 2>/dev/null); do
        skip=0
        for o in $own_list; do [ "$pid" = "$o" ] && { skip=1; break; }; done
        [ "$skip" = "1" ] && continue
        # The pid can exit between pgrep and this read; `ps` then prints nothing
        # and exits non-zero, which is a normal outcome, not an error to report.
        cmdline="$(ps -ww -o command= -p "$pid" 2>/dev/null)" || continue
        [ -n "$cmdline" ] || continue                  # kernel thread: no cmdline
        case "$cmdline" in *"$self_name"*) continue ;; esac
        printf '%s\n' "$pid"
    done
}

# --- is anything LISTENING on this port? ----------------------------------
# `ss` is Linux-only (iproute2). On macOS it does not exist, so this mode could
# never succeed there -- it just timed out after the full timeout and looked
# like a slow service. `lsof` covers macOS and most Linux boxes. If NEITHER is
# present the mode refuses LOUDLY (exit 2) instead of waiting for a condition it
# has no way to observe: an unobservable condition is a measurement gap, not a
# "not yet".
PORT_TOOL=""
port_tool() {
    [ -n "$PORT_TOOL" ] && return 0
    if command -v ss   >/dev/null 2>&1; then PORT_TOOL=ss;   return 0; fi
    if command -v lsof >/dev/null 2>&1; then PORT_TOOL=lsof; return 0; fi
    echo "port mode needs 'ss' or 'lsof', and neither is on PATH" >&2
    echo "  (use 'file'/'pid' mode, or install one of them)" >&2
    exit 2
}
listening() {
    local port="$1"
    port_tool
    case "$PORT_TOOL" in
        ss)   ss -lntH 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {f=1} END{exit !f}' ;;
        lsof) lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 ;;
    esac
}

# --- one evaluation of the condition; 0 = satisfied ------------------------
condition_met() {
    local a
    case "$MODE" in
        pid)
            for a in "${ARGS[@]}"; do kill -0 "$a" 2>/dev/null && return 1; done
            return 0 ;;
        file)
            for a in "${ARGS[@]}"; do [ -e "$a" ] || return 1; done
            return 0 ;;
        gone)
            for a in "${ARGS[@]}"; do [ -e "$a" ] && return 1; done
            return 0 ;;
        port)
            for a in "${ARGS[@]}"; do listening "$a" || return 1; done
            return 0 ;;
        pattern)
            for a in "${ARGS[@]}"; do [ -n "$(matching_pids "$a")" ] && return 1; done
            return 0 ;;
        *) echo "unknown mode: $MODE" >&2; exit 2 ;;
    esac
}

case "$MODE" in
    pid) for a in "${ARGS[@]}"; do
             case "$a" in ''|*[!0-9]*) echo "not a pid: $a" >&2; exit 2 ;; esac
         done ;;
    port) for a in "${ARGS[@]}"; do
             case "$a" in ''|*[!0-9]*) echo "not a port: $a" >&2; exit 2 ;; esac
          done ;;
esac

start=$(date +%s)
say "waiting: $MODE ${ARGS[*]}  (timeout ${TIMEOUT}s, checking every ${INTERVAL}s)"
while :; do
    if condition_met; then
        say "done after $(( $(date +%s) - start ))s: $MODE ${ARGS[*]}"
        exit 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
        echo "TIMEOUT after ${TIMEOUT}s, condition still unmet: $MODE ${ARGS[*]}" >&2
        [ "$MODE" = "pattern" ] && echo "  still matching: $(for a in "${ARGS[@]}"; do matching_pids "$a" | tr '\n' ' '; done)" >&2
        exit 1
    fi
    sleep "$INTERVAL"
done
