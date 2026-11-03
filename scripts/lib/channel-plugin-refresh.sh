# shellcheck shell=bash
# Refresh the marketplace channel plugins on an EXISTING install
# (SLACKPLUGINVER1006). Sourced by update.sh.
#
# Why: `claude plugin install` runs once, at install time, and nothing ran the
# official update afterwards, so a released plugin version (the slack-channel
# fork's 0.2.x line) reached no existing install; ours got it by hand-copying
# into the cache. Measured 2026-10-15 in a sandbox config dir (Claude Code
# 2.1.300): with the version bumped, `claude plugin marketplace update` then
# `claude plugin update <id>` installs the new version into a NEW cache
# directory and repoints the registry; running sessions keep the version they
# loaded until their next restart.
#
# Guarantees (Samu's review conditions on the card):
#  1. The child `claude` runs outside any channel session and cannot reach a
#     live channel: the channel tokens are removed from its environment and the
#     channel state dirs point at an empty temp dir, so even a plugin server it
#     started would find no token and no bot.pid of the live poller. (Measured
#     in the same sandbox: during `plugin update` only git ran from the plugin
#     directory; no plugin server was started.)
#  2. Only where the plugin is already installed: a config dir whose registry
#     (plugins/installed_plugins.json) lists the id. Never `plugin install`.
#  3. Never fatal: a failing or missing `claude` is logged and skipped; the
#     function always returns 0.

CHANNEL_PLUGIN_REFRESH_IDS="${CHANNEL_PLUGIN_REFRESH_IDS:-slack-channel@marveen-marketplace}"

# The config dirs that can hold a plugin registry: the user-level one, the main
# channel session's, and each agent's. One line each, symlinks resolved, no
# duplicates (a config dir linked to another is refreshed once).
channel_plugin_config_dirs() { # install_dir home
  local d real seen=""
  for d in "$2/.claude" "$1/.channels-config" "$1"/agents/*/.claude-config; do
    [ -d "$d" ] || continue
    real="$(cd -P "$d" 2>/dev/null && pwd)" || continue
    case "
$seen
" in *"
$real
"*) continue ;; esac
    seen="${seen}
${real}"
    printf '%s\n' "$real"
  done
}

# 0 when the config dir's registry lists the plugin id with an install entry.
channel_plugin_installed() { # config_dir plugin_id
  local reg="$1/plugins/installed_plugins.json"
  [ -f "$reg" ] || return 1
  python3 - "$reg" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    entries = json.load(open(sys.argv[1])).get("plugins", {}).get(sys.argv[2])
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(entries, list) and entries else 1)
PY
}

# The installed plugin's current ref, read from the registry: the basename of
# its installPath, plus "@<first 12 of gitCommitSha>" when the entry has one.
# The user-scope entry is preferred, else the most recently updated one. Prints
# nothing (exit 1) without a registry entry. update.sh's Slack smoke test
# compares this with the ref of the previous update: the cache dir name alone
# misses an official update (it adds a new version dir NEXT TO the old one, and
# the old name still sorts first) and a hand deploy into the same dir.
channel_plugin_current_ref() { # config_dir plugin_id
  local reg="$1/plugins/installed_plugins.json"
  [ -f "$reg" ] || return 1
  python3 - "$reg" "$2" <<'PY2' 2>/dev/null
import json, os, sys
try:
    entries = json.load(open(sys.argv[1])).get("plugins", {}).get(sys.argv[2])
except Exception:
    sys.exit(1)
if not isinstance(entries, list):
    sys.exit(1)
entries = [e for e in entries if isinstance(e, dict) and e.get("installPath")]
if not entries:
    sys.exit(1)
user = [e for e in entries if e.get("scope") == "user"]
e = user[0] if user else max(entries, key=lambda x: str(x.get("lastUpdated") or ""))
ref = os.path.basename(str(e["installPath"]).rstrip("/"))
sha = str(e.get("gitCommitSha") or "")[:12]
print(ref + ("@" + sha if sha else ""))
PY2
}

# How long one child `claude` call may take before it is killed (seconds).
CHANNEL_PLUGIN_TIMEOUT_S="${CHANNEL_PLUGIN_TIMEOUT_S:-300}"

# The perl time limit, for hosts without coreutils `timeout` (stock macOS;
# perl is always there). It runs the command in its OWN process group and, when
# the time is up, kills the whole group (TERM, then KILL), exit 142. Killing
# only the direct child is not enough (Samu, measured on #1967): `claude plugin
# marketplace update` starts git, a git hanging on the network outlives a
# killed claude, keeps the stdout pipe open, and `out="$(...)"` waits for it,
# so update.sh would hang anyway. A normal exit passes its code through; a
# death by signal N becomes 128+N, as in the shell.
_CPR_PERL_LIMIT='
my $t = shift;
my $pid = fork;
defined $pid or exit 127;
if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127 }
$SIG{ALRM} = sub {
  kill "TERM", -$pid;
  for (1 .. 20) { last unless kill 0, -$pid; select(undef, undef, undef, 0.1); waitpid($pid, 1) }
  kill "KILL", -$pid;
  waitpid($pid, 0);
  exit 142;
};
alarm $t;
waitpid($pid, 0);
alarm 0;
exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);
'

# One child `claude` call against one config dir, with no channel reachable,
# bounded in time: a hanging `claude plugin ...` must not hold update.sh, which
# is every install's update path. `timeout` (coreutils) where it exists, else
# the perl limit above. With neither the call runs unbounded, and
# refresh_channel_plugins says so once in the log.
_cpr_claude() { # empty_state_dir config_dir args...
  local empty="$1" cfg="$2"; shift 2
  local limit=()
  if command -v timeout >/dev/null 2>&1; then
    limit=(timeout "$CHANNEL_PLUGIN_TIMEOUT_S")
  elif command -v perl >/dev/null 2>&1; then
    limit=(perl -e "$_CPR_PERL_LIMIT" "$CHANNEL_PLUGIN_TIMEOUT_S")
  fi
  env -u TELEGRAM_BOT_TOKEN -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u DISCORD_BOT_TOKEN \
    CLAUDE_CONFIG_DIR="$cfg" TELEGRAM_STATE_DIR="$empty" SLACK_STATE_DIR="$empty" \
    DISCORD_STATE_DIR="$empty" \
    ${limit[@]+"${limit[@]}"} "$CHANNEL_PLUGIN_CLAUDE_BIN" "$@" < /dev/null
}

refresh_channel_plugins() { # install_dir home
  CHANNEL_PLUGIN_CLAUDE_BIN="${CHANNEL_PLUGIN_CLAUDE_BIN:-$(command -v claude 2>/dev/null)}"
  if [ -z "$CHANNEL_PLUGIN_CLAUDE_BIN" ] || [ ! -x "$CHANNEL_PLUGIN_CLAUDE_BIN" ]; then
    echo "  Csatorna-plugin frissites kihagyva: nincs claude parancs"
    return 0
  fi
  local empty cfg id market out rc updated=0 current=0 failed=0
  if ! command -v timeout >/dev/null 2>&1 && ! command -v perl >/dev/null 2>&1; then
    echo "  (nincs timeout es perl: a plugin-frissites idokorlat nelkul fut)"
  fi
  empty="$(mktemp -d "${TMPDIR:-/tmp}/marveen-plugin-refresh.XXXXXX")" || return 0
  while IFS= read -r cfg; do
    for id in $CHANNEL_PLUGIN_REFRESH_IDS; do
      channel_plugin_installed "$cfg" "$id" || continue
      market="${id#*@}"
      rc=0
      out="$(_cpr_claude "$empty" "$cfg" plugin marketplace update "$market" 2>&1)" || rc=$?
      if [ "$rc" -eq 0 ]; then
        out="$(_cpr_claude "$empty" "$cfg" plugin update "$id" 2>&1)" || rc=$?
      fi
      if [ "$rc" -ne 0 ]; then
        failed=$((failed + 1))
        echo "  FIGYELEM: ${id} frissitese nem sikerult (${cfg}, kilepesi kod ${rc}); a telepitett verzio marad"
        printf '%s\n' "$out" | tail -2 | sed 's/^/    /'
      elif printf '%s' "$out" | grep -q 'updated from'; then
        updated=$((updated + 1))
        echo "  ${id}: $(printf '%s' "$out" | grep -o 'updated from [^ ]* to [^ ]*' | head -1) (${cfg}); a kovetkezo csatorna-indulaskor el"
      else
        current=$((current + 1))
      fi
    done
  done < <(channel_plugin_config_dirs "$1" "$2")
  rm -rf "$empty"
  if [ $((updated + current + failed)) -gt 0 ]; then
    echo "  Csatorna-pluginok: ${updated} frissitve, ${current} naprakesz, ${failed} hibas"
  fi
  return 0
}
