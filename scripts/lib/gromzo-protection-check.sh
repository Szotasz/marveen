# shellcheck shell=bash
# MXDAGENTSOCKID1106: the Gromzo token protection in `doctor` (report only, never fails the run).
# mxd's dash status (marveen-mxd main.rs status_agents) carries agents.protected / agents.refused / agents.running
# (slugs only) and a top-level ratchet_unreadable when its protection file could not be read (fail closed: every
# agent counts as protected). Read through the installed mxdctl, the same client the installer uses.

# gromzo_mxdctl_and_sock [<env file>]: "<mxdctl>|<dash.sock>" for this platform, or nothing when mxd is not
# installed. The dash.sock path honours the install's MXD_DASH_SOCK, as the dashboard does (mxd-dash.ts;
# Dani 71532 (2)). GROMZO_MXDCTL overrides the client for the tests only.
gromzo_mxdctl_and_sock() {
  local ctl sock envsock
  if [ "$(uname -s)" = Darwin ]; then
    ctl='/Library/Application Support/Marveen/mxd/mxdctl'; sock='/Library/Application Support/Marveen/mxd-run/dash.sock'
  else
    ctl='/opt/marveen-mxd/mxdctl'; sock='/run/marveen-mxd/dash.sock'
  fi
  [ -z "${GROMZO_MXDCTL:-}" ] || ctl="$GROMZO_MXDCTL"
  if [ -n "${1:-}" ] && [ -f "$1" ]; then
    envsock="$(grep -E '^MXD_DASH_SOCK=' "$1" | tail -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
    [ -z "$envsock" ] || sock="$envsock"
  fi
  # Always rc 0: "not installed" is an answer (an empty line), not a failure (CI has no mxd; Samu 71599).
  if [ -x "$ctl" ] && [ -S "$sock" ]; then printf '%s|%s' "$ctl" "$sock"; fi
  return 0
}

# gromzo_protection_lines: the status JSON on stdin -> "level|message" lines (level: ok, warn, info).
gromzo_protection_lines() {
  python3 -I -S -c '
import json, sys
try:
    s = json.loads(sys.stdin.read() or "{}")
except ValueError:
    print("info|mxd status is not readable JSON"); sys.exit(0)
a = s.get("agents") if isinstance(s.get("agents"), dict) else {}
if "protected" not in a:
    print("info|mxd reports no token protection (an mxd before MXDAGENTSOCKID1106)"); sys.exit(0)
def slugs(k):
    v = a.get(k)
    return sorted(x for x in v if isinstance(x, str)) if isinstance(v, list) else []
if s.get("ratchet_unreadable") is True:
    print("warn|Gromzo: the protection state is unreadable, every agent counts as protected (a plugin without a token is refused); tell your developer")
refused = slugs("refused")
if refused:
    print("warn|Gromzo: refused in the last 10 min, the plugin sends no token: " + ", ".join(refused) + " (update the plugin or restart the session)")
prot = set(slugs("protected"))
running = slugs("running")
unprot = [x for x in running if x not in prot and x not in refused]
if unprot and s.get("ratchet_unreadable") is not True:
    print("info|Gromzo: running without a token yet: " + ", ".join(unprot) + " (protected after its next session restart)")
if prot and not refused and s.get("ratchet_unreadable") is not True:
    print("ok|Gromzo: protected agents: " + ", ".join(sorted(prot)))
'
}
