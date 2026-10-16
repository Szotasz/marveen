# shellcheck shell=bash
# main_extra_settings_flag <install_dir> [plugin_id ...]
#
# SLACKDMVESZT1006: the main agent's co-listen plugins (CHANNEL_PLUGINS_EXTRA)
# must be ENABLED for the main session only. The tracked project
# .claude/settings.json keeps slack-channel false on purpose (#112: every
# sub-agent reads the install-root project settings, so a true there opens one
# Socket Mode connection per agent on the same app). The user scope cannot win
# against that project false, and the local scope (.claude/settings.local.json)
# is ALSO read by every sub-agent -- measured 2026-10-06, 9 of 32 owner DMs
# lost to two sub-agent pollers. A --settings file is a launch flag: only the
# session started with it reads it, and it outranks the project scope
# (measured: `claude --settings <file> plugin list --json`, project false ->
# enabled true; without the flag -> false).
#
# Prints ` --settings "<file>"` (leading space) or nothing when there are no
# extras, so the launch line is byte-identical for an install without them.
# Same file and content as src/web/main-extra-plugins-settings.ts writes.
main_extra_settings_flag() {
  local install_dir="$1"; shift
  [ "$#" -gt 0 ] || return 0
  local file="$install_dir/store/.main-extra-plugins.settings.json"
  mkdir -p "$install_dir/store" || return 0
  python3 - "$file" "$@" <<'PYEOF' || return 0
import json, os, sys, tempfile
path, ids = sys.argv[1], [i for i in sys.argv[2:] if i]
data = {"enabledPlugins": {i: True for i in ids}}
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".main-extra-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF
  printf ' --settings "%s"' "$file"
}
