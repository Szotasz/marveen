# Shared, platform-independent file mtime for shell scripts (PORTSTAT912).
#
# Why this exists. `stat -c %Y` is GNU-only. On macOS it exits 1 with
# "illegal option -- c", and the fallback every caller had written --
# `|| echo 0` -- turned that into mtime=0. A file touched one second ago then
# measured as 56 years old.
#
# What makes this worse than a wrong number: every caller was a GRACE, BACKOFF
# or STALENESS gate, and zero tips all of them the SAME way -- the permissive
# one. channel-watchdog.sh read a fresh keepalive as infinitely stale (respawn
# the pane, every tick), and the very next gate, the respawn-grace stamp meant
# to stop that storm, read zero too and never deferred. watchdog.sh:169 and
# stuck-modal-guard.sh:238 are the same pair. So this is not four independent
# bugs: it is one bug that also disables its own brakes.
#
# Callers read a moment in time, so the helper must never invent one. It
# returns 0 only when neither spelling produced a usable answer, preserving the
# historical "unknown means act" contract -- the callers already treat 0 that
# way, and changing that silently would be a second bug wearing the first one's
# clothes.
#
# Usage:
#   . "$INSTALL_DIR/scripts/lib/portable-stat.sh"
#   m="$(file_mtime "$some_file")"      # epoch seconds, or 0 if unknowable
#
# Test seam: PORTABLE_STAT_DISABLE is a space-separated list of spellings to
# treat as absent ("bsd", "gnu"). It exists because on any single host one of
# the two branches is unreachable -- and a branch that cannot be exercised is a
# branch that rots. Same reasoning as CONTENT_HASH_DISABLE in content-hash.sh,
# which guards the same class of bug (a GNU-only tool answering emptily on
# macOS).
_ps_enabled() {
  case " ${PORTABLE_STAT_DISABLE:-} " in *" $1 "*) return 1 ;; esac
  return 0
}

# Accept a candidate only if the command SUCCEEDED and the output is all
# digits. The exit code alone is not enough, and not as a belt-and-braces
# nicety: under GNU stat `-f` is a valid but entirely different option
# (file-system status), so calling the BSD spelling on a GNU host can print a
# multi-line filesystem report rather than failing outright. A pure
# exit-code implementation would hand that back as if it were a timestamp.
_ps_accept() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *)           return 0 ;;
  esac
}

file_mtime() {
  _ps_f="$1"
  _ps_m=""

  if _ps_enabled bsd; then
    _ps_m="$(stat -f %m "$_ps_f" 2>/dev/null)" || _ps_m=""
    _ps_accept "$_ps_m" || _ps_m=""
  fi

  if [ -z "$_ps_m" ] && _ps_enabled gnu; then
    _ps_m="$(stat -c %Y "$_ps_f" 2>/dev/null)" || _ps_m=""
    _ps_accept "$_ps_m" || _ps_m=""
  fi

  printf '%s\n' "${_ps_m:-0}"
  unset _ps_f _ps_m
}
