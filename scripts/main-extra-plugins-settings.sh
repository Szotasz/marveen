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
# The same file carries the main agent's sender-role gate when
# store/main-agent-config.json sets `senderRoleGate` (MIOAPPTEAMSRV1025): one
# session serves the owner and a team chat, and only this session reads the flag.
#
# Prints ` --settings "<file>"` (leading space) or nothing when there are no
# extras and no gate, so the launch line is byte-identical for an install
# without them. Same file and content as src/web/main-extra-plugins-settings.ts
# writes (the test compares the two files).
main_extra_settings_flag() {
  local install_dir="$1"; shift
  local file="$install_dir/store/.main-extra-plugins.settings.json"
  [ -d "$install_dir/store" ] || mkdir -p "$install_dir/store" || return 0
  python3 - "$file" "$install_dir/store/main-agent-config.json" "$@" <<'PYEOF' || return 0
import base64, json, os, sys, tempfile
path, cfg_path, ids = sys.argv[1], sys.argv[2], [i for i in sys.argv[3:] if i]


def b64(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def gate_policy(cfg_path):
    # readMainSenderRoleGatePolicy() in src/web/main-extra-plugins-settings.ts: a file that
    # exists but is not a readable JSON object wires the gate as malformed (fail-closed).
    try:
        with open(cfg_path, encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return b64("unreadable")
    try:
        cfg = json.loads(raw)
    except ValueError:
        return b64("unreadable")
    if not isinstance(cfg, dict):
        return b64("unreadable")
    if "senderRoleGate" not in cfg:
        return None
    gate = cfg["senderRoleGate"]
    if isinstance(gate, dict) and "allowTools" not in gate:
        risky = gate.get("riskyTools")
        if risky is None or risky == []:
            return None
    return b64(gate)


policy = gate_policy(cfg_path)
if not ids and not policy:
    sys.exit(3)
data = {"enabledPlugins": {i: True for i in ids}}
if policy:
    # pythonHookCommand() in src/web/agent-scaffold.ts, for this one script.
    inv = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/sender-role-gate.py" --policy ' + policy
    fail = ("governance-kapu (fail-closed): sender-role-gate.py: a kapu nem 0-val vagy 2-vel lepett ki "
            "(rc=$rc: betoltesi hiba, hianyzo fajl, jel vagy idotullepes). A hivas ezert TILTVA. "
            "Javitas: a kapu fajlja vagy egy fuggosege hibas, a hibauzenet fent.")
    miss = ("governance-kapu: a hook interpretere nem talalhato (python3 nincs a PATH-on). A kapu ezert "
            "BLOKKOL. Javitas: telepitsd a python3-at, vagy inditsd ujra a dashboardot.")
    command = ('command -v python3 >/dev/null 2>&1 || { echo "%s" >&2; exit 2; }; '
               'if command -v timeout >/dev/null 2>&1; then timeout -k 1 8 %s; else %s; fi; rc=$?; '
               '[ "$rc" = 0 ] || [ "$rc" = 2 ] || { echo "%s" >&2; exit 2; }; exit "$rc"' % (miss, inv, inv, fail))
    data["hooks"] = {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 10}]}]}
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".main-extra-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF
  printf ' --settings "%s"' "$file"
}
