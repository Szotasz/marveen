#!/bin/bash
# Main agent Channels -- Claude Code channel bridge in a tmux session.
#
# Supports Telegram (default) and Slack providers. The provider is read
# from CHANNEL_PROVIDER in .env; when absent, defaults to "telegram" for
# full backward compatibility.
#
# A LaunchAgent (macOS) vagy a systemd user unit (Linux) hívja. Működés:
# 1. Tmux session indul a claude processzel
# 2. A script vár amíg a session él
# 3. Ha a claude kilép, a tmux session záródik, a script is kilép
# 4. A launchd KeepAlive újraindítja -- kilépési kódtól függetlenül.
#    A systemd oldalon ez NEM volt igaz: a unit Restart=always nélkül a nulla
#    kilépési kódot "kész, nem kell újraindítani"-ként olvasta, így a csatorna
#    némán, véglegesen leállt. Ezért ad a watchdog-ág mostantól nem-nulla kódot,
#    és ezért Restart=always a unit -- a két platform szemantikája így egyezik.
#
# Kézzel rácsatlakozás: tmux attach -t <MAIN_AGENT_ID>-channels (pl. marveen-channels)

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read MAIN_AGENT_ID and CHANNEL_PROVIDER from .env WITHOUT exporting
# every variable into the shell environment. `set -a && source .env`
# would also export TELEGRAM_BOT_TOKEN, which then leaks into the tmux
# server's global environment and gets inherited by every sub-agent tmux
# session the dashboard starts later -- they'd all use the main agent's
# token and fight over the same getUpdates slot, 409 Conflict in a loop.
if [ -f "$INSTALL_DIR/.env" ]; then
  MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  # Optional extra channel plugins to co-listen alongside the PRIMARY provider
  # (space-separated plugin IDs, e.g. "discord@claude-plugins-official"). The
  # primary provider still drives the orphan-reaper + liveness watchdog logic
  # below unchanged; the extras are best-effort co-listeners on the same session.
  CHANNEL_PLUGINS_EXTRA="$(grep -E '^CHANNEL_PLUGINS_EXTRA=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  # Optional per-install model override for the MAIN agent. Lives here rather
  # than in .claude/settings.json because that file is TRACKED: an install that
  # writes its model choice there carries a permanent local diff, which blocks
  # the update preflight's clean-tree check and silently reverts to the
  # repository's value on the next update. .env is per-install and gitignored.
  MAIN_AGENT_MODEL="$(grep -E '^MAIN_AGENT_MODEL=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  # Claude Code auth: pass API key or OAuth token so the tmux-spawned
  # claude process can authenticate. These are safe to export -- unlike
  # TELEGRAM_BOT_TOKEN they don't cause cross-session conflicts.
  _api_key="$(grep -E '^ANTHROPIC_API_KEY=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  [ -n "$_api_key" ] && export ANTHROPIC_API_KEY="$_api_key"
  _oauth="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  # Fallback: the fleet setup-token file (written by the wizard / auth.sh /
  # the boot-time credentials sync). Keeps the MAIN agent on the same stable
  # token the sub-agents launch with, instead of the rotating
  # ~/.claude/.credentials.json, even when .env carries no auth key
  # (2026-07-15 bootcamp: terminal-pasted setup-token never reached .env).
  if [ -z "$_oauth" ] && [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then
    _oauth="$(cat "$INSTALL_DIR/store/.claude-oauth-token")"
  fi
  [ -n "$_oauth" ] && export CLAUDE_CODE_OAUTH_TOKEN="$_oauth"
  unset _api_key _oauth
fi
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
SESSION="${MAIN_AGENT_ID:-marveen}-channels"

# Resolve plugin ID from provider.
#
# PLUGIN_ID is the marketplace-qualified id the `--channels` flag takes.
# PLUGIN_PANE_ID is the *MCP server* id the /mcp TUI renders, which is a
# DIFFERENT string (`plugin:<plugin>:<mcp-server>`). Keep this map in sync with
# `pluginPaneId` in src/channel-provider.ts -- the post-init unlock below greps
# the /mcp pane for it.
resolve_plugin_ids() {
  case "$1" in
    slack)    PLUGIN_ID="slack-channel@marveen-marketplace"; PLUGIN_PANE_ID="plugin:slack-channel:marveen-marketplace" ;;
    whatsapp) PLUGIN_ID="whatsapp@marveen-marketplace";      PLUGIN_PANE_ID="plugin:whatsapp:marveen-marketplace" ;;
    teams)    PLUGIN_ID="teams@marveen-marketplace";         PLUGIN_PANE_ID="plugin:teams:marveen-marketplace" ;;
    discord)  PLUGIN_ID="discord@claude-plugins-official";   PLUGIN_PANE_ID="plugin:discord:discord" ;;
    *)        PLUGIN_ID="telegram@claude-plugins-official";  PLUGIN_PANE_ID="plugin:telegram:telegram" ;;
  esac
}
resolve_plugin_ids "$CHANNEL_PROVIDER"

# --- pure classifier for the /mcp pane ----------------------------------------
# Takes a captured pane as $1 and sets MCP_PLUGIN_STATE (failed|ok) plus the row
# it judged in MCP_PLUGIN_ROW for logging. Assigns rather than prints so the
# caller keeps the row without a subshell. Extracted so it is testable without a
# live tmux session (see scripts/__tests__/channels-mcp-unlock.test.sh) -- the
# previous inline matcher went stale against a Claude Code TUI change and no
# test could have caught it.
#
# Only the plugin's OWN row is considered, and only the status word decides:
#   - The row label is the MCP server id, not the marketplace id. Claude Code
#     2.1.159 rendered `plugin:telegram@claude-plugins-official`, 2.1.220
#     renders `plugin:telegram:telegram`. Both are accepted.
#   - The failure marker moved from `✗ Failed` (U+2717, capitalised) to
#     `✘ failed` (U+2718, lowercase), so the glyph is not matched at all. The
#     status vocabulary mirrors PLUGIN_FAILED_RX in
#     src/web/channel-health-monitor.ts.
# The status-marker pre-filter keeps a scrollback mention of the plugin id (the
# "Listening for channel messages from:" banner) from being read as the /mcp
# row; `tail -1` prefers the menu, which renders at the bottom of the pane.
MCP_PLUGIN_ROW=""
MCP_PLUGIN_STATE="ok"
classify_mcp_plugin_row() {
  MCP_PLUGIN_ROW="$(printf '%s\n' "$1" \
    | grep -F -e "$PLUGIN_PANE_ID" -e "plugin:$PLUGIN_ID" \
    | grep -iE 'failed|error|disconnected|connected|disabled' \
    | tail -1)"
  case "$(printf '%s' "$MCP_PLUGIN_ROW" | tr '[:upper:]' '[:lower:]')" in
    *failed*|*error*|*disconnected*) MCP_PLUGIN_STATE="failed" ;;
    *)                               MCP_PLUGIN_STATE="ok" ;;
  esac
}

# Test hook: classify a pane from stdin and exit before anything touches tmux,
# the store or a live session.
# Resolve the main agent's model. Precedence: MAIN_AGENT_MODEL from .env
# (per-install, gitignored) over .claude/settings.json (tracked, shipped with
# the repo). Without the .env route an install that wants a different model has
# to edit a tracked file, which then blocks the update preflight's clean-tree
# check and gets reverted by the next update.
#
# Kept as a function so `--resolve-main-model` can exercise exactly the code
# the launch path uses, with no tmux, store or network involved.
resolve_main_model() {
  if [ -n "${MAIN_AGENT_MODEL:-}" ]; then
    printf '%s' "$MAIN_AGENT_MODEL"
    return 0
  fi
  local _m=""
  if [ -f "$INSTALL_DIR/.claude/settings.json" ]; then
    # python3 fallback: jq is not guaranteed on the host (stock WSL/minimal
    # Debian images ship without it). Behind a `command -v jq` guard alone the
    # settings.json read silently resolves EMPTY on such a host: MODEL_FLAG is
    # omitted, the main agent launches on the CLI's built-in default, and every
    # status surface keeps naming the configured model -- a silent model drift
    # with no error anywhere. python3 is already a hard dependency of the hooks,
    # so it is always available as the fallback reader.
    if command -v jq >/dev/null 2>&1; then
      _m="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
    else
      _m="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model") or "")' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
    fi
  fi
  if [ -n "$_m" ]; then
    printf '%s' "$_m"
    return 0
  fi
  # MODELMIGRATE806: settings.json has no model -> fall back to the SHIPPED
  # distribution default (DISTRIBUTION_DEFAULT_AGENT_MODEL). This is what lets a
  # model bump reach EXISTING installs through a plain code update: their
  # settings.json (shipped before the model field existed) stays model-less, and
  # WITHOUT this fallback they would silently keep the CLI default forever. We do
  # NOT write the value into a per-install file -- that would pin an inherited
  # default and cut those machines off from the NEXT bump. The shipped TS
  # constant stays the single source of truth; node reads it (node is already a
  # hard dependency on this launch path, and the read is ~one-time per restart).
  # The .env override above still wins, so a hand-set model is untouched.
  if command -v node >/dev/null 2>&1 && [ -f "$INSTALL_DIR/dist/config-registry.js" ]; then
    node -e 'try { process.stdout.write(String(require(process.argv[1]).DISTRIBUTION_DEFAULT_AGENT_MODEL || "")) } catch (e) {}' "$INSTALL_DIR/dist/config-registry.js" 2>/dev/null
  fi
}

# Test seam: print the resolved model and exit before any side effect.
if [ "${1:-}" = "--resolve-main-model" ]; then
  resolve_main_model
  echo
  exit 0
fi

if [ "${1:-}" = "--classify-mcp-pane" ]; then
  resolve_plugin_ids "${2:-$CHANNEL_PROVIDER}"
  classify_mcp_plugin_row "$(cat)"
  echo "$MCP_PLUGIN_STATE"
  exit 0
fi

# --- input-line probe for the /mcp unlock (MCPDUP806) -------------------------
# Classifies a COLOURED capture (`tmux capture-pane -e -p`) of the main session.
# Typing "/mcp" only opens the MCP manager when the pane sits at an EMPTY idle
# prompt; into any other state the literal text lands in the input box instead.
# On a fresh 0.3.9 install two consecutive boots did exactly that: each left a
# parked "/mcp", the second appended to the first ("/mcp/mcp"), the combined
# text was submitted as a PROMPT, and while parked it also made the message
# router read the session as busy -- muting inter-agent delivery.
#
# Delegates to the compiled pane-state.js instruments (stripGhostSuggestion /
# idleConsideringDimGhost / detectPaneState / parkedInputText) -- the same code
# the dashboard recovery stack trusts -- rather than re-deriving TUI parsing in
# shell. The coloured capture matters: Claude Code renders ghost/placeholder
# hints dim (SGR 2) inside an EMPTY box, and a plain capture cannot tell them
# from genuinely parked text.
#
# stdout, exactly one line:
#   idle           -- input box live and provably empty; safe to type
#   parked:<text>  -- text parked in the box (collapsed, truncated for logs)
#   busy|unknown|… -- detectPaneState verdict; not safe to type
#   unverifiable   -- node or dist/pane-state.js unavailable; not safe to type
probe_pane_input_state() {
  local _node _pane_js
  _node="$(command -v node || true)"
  # Test seam: the suite points this at a real build outside the checkout
  # (dist/ is a build product, absent from a fresh clone). Runtime installs
  # always carry dist/ -- the dashboard itself runs from it.
  _pane_js="${CHANNELS_PANE_STATE_JS:-$INSTALL_DIR/dist/pane-state.js}"
  if [ -z "$_node" ] || [ ! -f "$_pane_js" ]; then
    echo "unverifiable"
    return 0
  fi
  "$_node" -e '
    const ps = require(process.argv[1])
    let raw = ""
    process.stdin.on("data", (d) => { raw += d })
    process.stdin.on("end", () => {
      const plain = ps.stripAllAnsi(raw)
      const view = ps.stripGhostSuggestion(raw)
      if (ps.idleConsideringDimGhost(plain, view)) { console.log("idle"); return }
      const state = ps.detectPaneState(plain)
      if (state === "typing") {
        const parked = ps.parkedInputText(view) || ps.parkedInputText(plain) || ""
        console.log("parked:" + parked.replace(/\s+/g, " ").slice(0, 120))
        return
      }
      console.log(state)
    })
  ' "$_pane_js" 2>/dev/null || echo "unverifiable"
}

# True (exit 0) when $1 is nothing but our own unlock-probe residue -- one or
# more "/mcp" fragments and whitespace. The post-unlock cleanup may only ever
# clear text WE parked; anything else (a human draft, a delivered channel
# message) is left alone for the stuck-input recovery stack.
is_own_probe_residue() {
  printf '%s' "$1" | grep -Eq '^[[:space:]]*(/mcp[[:space:]]*)+$'
}

# Test seams: drive the two helpers from stdin with no tmux / store / session.
if [ "${1:-}" = "--probe-input-state" ]; then
  probe_pane_input_state
  exit 0
fi

if [ "${1:-}" = "--classify-unlock-residue" ]; then
  if is_own_probe_residue "$(cat)"; then echo "own"; else echo "foreign"; fi
  exit 0
fi

# Self-healing guard: ensure PLUGIN_ID is enabled in the PROJECT settings.json
# before launch. A PR review-reset or branch-switch that reverts
# .claude/settings.json can silently drop the entry and disable the channel
# plugin, leaving Claude running with no active channel; this re-adds it.
#
# Deliberately PROJECT-SCOPED only ($INSTALL_DIR/.claude/settings.json). We do
# NOT force-enable in the user-global ~/.claude/settings.json: that would make
# EVERY Claude context (all sub-agent sessions) load the channel plugin, and a
# provider that opens a single Socket-Mode connection (Slack) would then have
# multiple sessions fighting over one workspace socket -- a duplicate-socket /
# 409 hazard.
_ensure_plugin_enabled() {
  local settings_file="$1"
  [ -f "$settings_file" ] || return 0
  python3 - "$settings_file" "$PLUGIN_ID" <<'PYEOF'
import json, os, sys, tempfile

path, plugin_id = sys.argv[1], sys.argv[2]

# SKIP-ON-PARSE-FAILURE: if the file is unreadable or not valid JSON (e.g. a
# concurrent writer caught mid-write, or a genuinely corrupt file), NEVER fall
# back to an empty object and write it back -- that would clobber the user's
# hooks / model / permissions. Leave the file untouched; the next launch retries.
try:
    with open(path, "r") as f:
        data = json.load(f)
except (OSError, ValueError):
    print("channels.sh: settings.json unreadable/invalid, guard skipped: %s" % path,
          file=sys.stderr, flush=True)
    sys.exit(0)

if not isinstance(data, dict):
    sys.exit(0)

plugins = data.get("enabledPlugins")
if not isinstance(plugins, dict):
    plugins = {}
    data["enabledPlugins"] = plugins

if plugins.get(plugin_id) is True:
    sys.exit(0)  # already enabled -> no write, no needless churn

plugins[plugin_id] = True

# ATOMIC write: serialize to a temp file in the SAME directory, then os.replace
# (atomic rename on POSIX). A reader -- or the hook-registration guard (#565)
# running concurrently -- never observes a half-written settings.json.
dir_name = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=dir_name, prefix=".settings-", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise

print("channels.sh: enabled %s in %s" % (plugin_id, path), flush=True)
PYEOF
}
_ensure_plugin_enabled "$INSTALL_DIR/.claude/settings.json"
unset -f _ensure_plugin_enabled

# Build the extra --channels args from CHANNEL_PLUGINS_EXTRA (space-separated
# plugin IDs). Each becomes an additional `plugin:<id>` token appended to the
# --channels list. `claude --channels` accepts a space-separated plugin list,
# so one session can co-listen on several providers (e.g. Telegram + Discord).
# NOTE: co-listen also requires each extra plugin to be enabled in
# .claude/settings.json enabledPlugins (true) -- CHANNEL_PLUGINS_EXTRA alone is
# not enough; Claude Code only starts plugins marked true there.
EXTRA_CHANNELS=""
for _p in $CHANNEL_PLUGINS_EXTRA; do
  [ -n "$_p" ] && EXTRA_CHANNELS="$EXTRA_CHANNELS plugin:$_p"
done
unset _p

# ROOT-CAUSE NOTE (kali-linux WSL, claude-code 2.1.152, 2026-05-27):
# Inbound MCP notifications from the `--channels` plugin go through a SECOND
# gate beyond --dangerously-skip-permissions / --dangerously-load-development-
# channels: claude-code checks `/etc/claude-code/managed-settings.json`
# allowedChannelPlugins and SILENTLY DROPS notifications from any plugin not
# in that list. The plugin still sends the MCP notification successfully
# (confirmed by debug-logging the plugin), but the session never ingests it.
# Symptom: bot online, plugin debug shows "MCP notification SENT successfully",
# but claude pane shows no <channel source="..."> inbound and the bot never
# replies. Fix is to add the plugin to managed-settings.json (requires sudo).
# Once that's done, the dev-channels flag is unnecessary -- this is why
# the earlier DEVCHANNELS_FLAG block was removed.

# Extra safety net for existing installs whose tmux server already has a
# polluted global env -- scrub channel tokens so new child sessions don't
# inherit them. The main agent's plugin will still load its token from
# ~/.claude/channels/<provider>/.env via the plugin's own bootstrap.
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u SLACK_BOT_TOKEN 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u DISCORD_BOT_TOKEN 2>/dev/null || true
unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN

# Issue #189: when this script runs from inside an existing tmux session (the
# user's own work session, for example), the inherited TMUX env var points at
# the parent client's socket. Any `tmux new-session` we spawn then tries to
# attach to that socket and fails with "Permission denied" (different uid,
# different socket dir, or just the new-session-from-inside-tmux block). The
# child marveen-channels session must live on a fresh tmux client context, so
# scrub the env var before any tmux command runs.
unset TMUX

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Root VPS / container: Claude Code refuses --dangerously-skip-permissions when
# running as uid 0 ("cannot be used with root/sudo privileges"), so the tmux
# claude session below dies instantly and the bot never comes online. On a
# root-only host there is no non-root user to drop to, so opt into the
# documented sandbox escape hatch. Harmless for non-root (guarded by uid check).
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

# AVX-less x86 host: the install pinned a Node-based claude (cli.js entrypoint,
# see install-linux.sh CLAUDE_PIN) because the Bun standalone binary SIGILLs
# without AVX. The auto-updater would swap the pin for the latest Bun binary on
# first run, killing every session -- disable it here so all agent sessions
# inherit the guard via tmux. No-op on AVX-capable and ARM hosts.
if grep -qE '^flags[[:space:]]*:' /proc/cpuinfo 2>/dev/null && ! grep -qiw avx /proc/cpuinfo 2>/dev/null; then
  export DISABLE_AUTOUPDATER=1
fi

# Disable Claude Code's "Prompt Suggestions" (the grayed-out/DIM suggested command
# shown in the input box, picked from git history / conversation). For headless
# agent sessions it is pure noise AND it caused a false-positive incident: the
# stuck-input recovery read the dim suggestion as a "parked input" and escalated a
# phantom to the operator (2026-06-30, "Köszi a halakat."). Killing it at the
# source removes the phantom entirely. Inherited by every sub-agent via the tmux
# global env set below.
export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false

CLAUDE="$(command -v claude)"
TMUX="$(command -v tmux)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
[ -z "$TMUX" ]   && echo "ERROR: tmux not found on PATH" >&2 && exit 1

# MCP startup-batch tuning for the MAIN session (2026-06-26).
#
# The --channels telegram plugin registers as a stdio MCP server. Claude Code
# connects stdio MCP servers in batches of MCP_SERVER_CONNECTION_BATCH_SIZE
# (default 3) and, by default, blocks on each connection. The main session runs
# the MOST MCP servers of any agent (filesystem + playwright + chrome + the
# claude.ai Gmail/Calendar/Drive connectors + the channel plugin), so the slow
# remote connectors starve the telegram plugin out of the startup batch / push
# it past MCP_TIMEOUT -- it never registers, no poller spawns, and the main bot
# goes silent (observed 2026-06-26: ~2h outage, auto-recovery exhausted).
#
# startAgentProcess already sets these for every sub-agent (which is why their
# channels come up); channels.sh did NOT, so the main session never got the
# mitigation. Set them inline on the launch command -- the tmux SERVER predates
# this script and does not inherit its environment, so exporting here alone
# would not reach the new claude. Mirrors the sub-agent launch.
#
# CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false also added here: the sub-agent spawn
# (startAgentProcess) sets it to suppress the DIM ghost-text autocomplete, but
# the MAIN channels session never got it -- so a dim ghost in the main box was
# the one place the pane-scrape recovery could still misread it (the v1.15.0
# dim-strip catches it on the recovery side, but killing it at the SOURCE on MAIN
# too closes the gap end-to-end). Parity with the sub-agent launch.
MCP_BATCH_ENV="export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000 && "

# Resolve the main agent's model so we can pass --model explicitly. Without
# --model claude-code falls back to its built-in default, which can drift
# across versions. Passing the flag makes the choice deterministic and visible
# in `ps`.
#
# Precedence: MAIN_AGENT_MODEL from .env (per-install, gitignored) wins over
# .claude/settings.json (tracked, shipped with the repo). Without the .env
# route an install that wants a different model has to edit a tracked file,
# which then blocks the update preflight and gets reverted by the next update.
MAIN_MODEL="$(resolve_main_model)"
MODEL_FLAG=""
# Single-quote the model id so values like `claude-opus-4-8[1m]` survive the
# tmux command-string round-trip without the inner shell glob-expanding `[1m]`.
[ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "

# Main-agent config isolation (OPT-IN, default OFF).
#
# By default the main channels agent keeps the shared ~/.claude and
# authenticates from whatever on-process credential refreshes that shared root
# -- the ROTATING macOS Keychain OAuth session, or (Linux) the shared
# ~/.claude/.credentials.json -- both periodically expire and 401 the main bot
# ("Please run /login"), while the isolated sub-agents (long-lived fleet
# setup-token) never do (confirmed root cause of the 2026-07-23 marveen-channels
# silent outage). The helper provisions an isolated CLAUDE_CONFIG_DIR (same code
# path as the sub-agents, via dist/web/agent-process.js) and authenticates the
# main agent from the fleet setup-token instead.
#
# The decision lives ENTIRELY in the helper, which prints "<mode>\t<path>" (or
# nothing) and covers the two mutually exclusive ways the main agent can get its
# own CLAUDE_CONFIG_DIR:
#
#   explicit -- MAIN_AGENT_CONFIG_DIR points at an EXISTING dir the operator has
#     already logged into (the bot has its OWN Claude account, separate from the
#     fleet's). That dir carries its own .credentials.json, so we must NOT inject
#     the fleet token: doing so would authenticate the bot as the fleet. Works on
#     every platform.
#   isolated -- MAIN_AGENT_ISOLATED_CONFIG=1 (any platform) with a fleet
#     setup-token: the helper provisions a credential-less dir and we export the
#     fleet token (same code path as the sub-agents), so the bot stops depending
#     on the rotating/shared on-disk credential.
#
# Both settings resolve through the settings-store (dashboard toggle in
# store/config-overrides.json OR a hand-set .env key -- resolution override>.env>
# default), and explicit wins over isolated. When neither applies the helper
# prints nothing, CFG_ENV stays EMPTY and the agent keeps the shared ~/.claude --
# strict no-op for existing installs (no setting, no fleet token, no dist build).
CFG_ENV=""
mkdir -p "$INSTALL_DIR/store" 2>/dev/null || true
_node_bin="$(command -v node || true)"
if [ -n "$_node_bin" ] && [ -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then
  _cfg_line="$("$_node_bin" "$INSTALL_DIR/scripts/main-agent-isolated-config.mjs" "$CHANNEL_PROVIDER" 2>>"$INSTALL_DIR/store/channels-failures.log" || true)"
  _cfg_mode="${_cfg_line%%	*}"
  _cfg_dir="${_cfg_line#*	}"
  if [ -n "$_cfg_line" ] && [ -d "$_cfg_dir" ]; then
    if [ "$_cfg_mode" = "explicit" ]; then
      CFG_ENV="export CLAUDE_CONFIG_DIR='$_cfg_dir' && "
    else
      # Seed the token from the SAME 0600 file the isolated dir is gated on, so
      # the config dir and the active token always match (the isolated dir carries
      # no .credentials.json). $(cat) is evaluated in the launched shell so the
      # secret never lands in the argv/`ps` command string.
      CFG_ENV="export CLAUDE_CONFIG_DIR='$_cfg_dir' && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$INSTALL_DIR/store/.claude-oauth-token')\" && "
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh: main-agent $_cfg_mode CLAUDE_CONFIG_DIR=$_cfg_dir" >> "$INSTALL_DIR/store/channels-failures.log"
  fi
  # LOUD REGRESSION GUARD, in two triggers. Both mean the same thing: this boot
  # resolved to the shared ~/.claude, so the main agent rides the rotating
  # shared credential session -- exactly how the 2026-07-27 evening 401 outage
  # started, unnoticed for hours because the owner simply got no replies. Both
  # surface it at START time: a failures-log line plus a best-effort inter-agent
  # message. Measured, not assumed: the only combination silent on BOTH is an
  # install that never ran isolated AND carries no fleet setup-token -- which is
  # the plain default setup, so that one still sees no new noise. Note trigger 2
  # does fire without a token when the .channels-config dir is there, which is
  # correct: that dir means isolation once worked here.
  #
  # Trigger 1 (below): a FRESH install. A fleet setup-token exists while the
  # resolution came back empty. The token is the thing isolation is gated on, so
  # carrying one and still landing on the shared root means the setting is
  # missing, not that isolation was declined. This is the shape issue #835 is
  # about, and trigger 2 is structurally blind to it.
  if [ -z "$CFG_ENV" ] && [ ! -d "$INSTALL_DIR/.channels-config" ] && [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh: WARN main-agent starting on SHARED ~/.claude although a fleet setup-token exists (store/.claude-oauth-token) -- MAIN_AGENT_ISOLATED_CONFIG is unset, so the main bot authenticates from the rotating shared credential and can 401 into a silent channel." >> "$INSTALL_DIR/store/channels-failures.log"
    if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
      _guard_port="$(grep -E '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
      curl -s --max-time 5 -X POST "http://localhost:${_guard_port:-3420}/api/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $(cat "$INSTALL_DIR/store/.dashboard-token")" \
        -d "{\"from\":\"channels-sh-guard\",\"to\":\"${MAIN_AGENT_ID:-marveen}\",\"content\":\"[GUARD] A fo agens a KOZOS ~/.claude alol indult, pedig van flotta setup-token (store/.claude-oauth-token). A MAIN_AGENT_ISOLATED_CONFIG nincs beallitva, ezert az auth a rotalodo megosztott credentialbol megy: ez lejarhat, 401-be all a TUI, es a csatorna NEMAN elerhetetlen lesz. Teendo: MAIN_AGENT_ISOLATED_CONFIG=1 beallitasa, majd channels session restart.\"}" \
        >/dev/null 2>&1 || true
      unset _guard_port
    fi
  fi
  # Trigger 2 (below): an install that HAS run isolated before. Its
  # .channels-config dir is still on disk, yet this boot resolved to the shared
  # root -- so the isolation setting was LOST, e.g. store/config-overrides.json
  # deleted with no .env key backing it. Needing that dir is what makes this
  # trigger blind on a fresh install, hence trigger 1.
  if [ -z "$CFG_ENV" ] && [ -d "$INSTALL_DIR/.channels-config" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh: WARN main-agent starting on SHARED ~/.claude although isolated dir $INSTALL_DIR/.channels-config exists -- MAIN_AGENT_ISOLATED_CONFIG resolution came back empty (overrides/.env key lost?). Auth rides the rotating shared session and can 401." >> "$INSTALL_DIR/store/channels-failures.log"
    if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
      _guard_port="$(grep -E '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
      curl -s --max-time 5 -X POST "http://localhost:${_guard_port:-3420}/api/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $(cat "$INSTALL_DIR/store/.dashboard-token")" \
        -d "{\"from\":\"channels-sh-guard\",\"to\":\"${MAIN_AGENT_ID:-marveen}\",\"content\":\"[GUARD] A channels session most a KOZOS ~/.claude alol indult, pedig letezik izolalt config dir (.channels-config). A MAIN_AGENT_ISOLATED_CONFIG beallitas valoszinuleg elveszett (store/config-overrides.json torlodott es nincs .env kulcs). Az auth a rotalodo shared sessionbol megy, 401-veszely. Teendo: MAIN_AGENT_ISOLATED_CONFIG=1 visszaallitasa, majd channels session restart.\"}" \
        >/dev/null 2>&1 || true
      unset _guard_port
    fi
  fi
  unset _cfg_line _cfg_mode _cfg_dir
fi
unset _node_bin

# Re-seed hasCompletedOnboarding in the SHARED ~/.claude.json BEFORE launching
# the main claude. If the key was lost (2026-07-15 bootcamp incident), the
# fresh TUI parks on the first-run "Select login method" picker -- and the
# first-run guard below would blindly Enter it into a browser sign-in screen
# no headless box can complete. Atomic tmp+rename; an unparseable file is left
# for Claude Code to recover. Mirrors ensureSharedClaudeOnboarded() (the
# in-process respawn paths); this covers the channels.sh cold-boot path.
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs")
    const p = require("path").join(require("os").homedir(), ".claude.json")
    try {
      let j = {}
      if (fs.existsSync(p)) j = JSON.parse(fs.readFileSync(p, "utf-8"))
      if (j.hasCompletedOnboarding !== true) {
        j.hasCompletedOnboarding = true
        const t = p + ".tmp-" + process.pid
        fs.writeFileSync(t, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 })
        fs.renameSync(t, p)
      }
    } catch (e) { /* unparseable/unwritable: leave for Claude Code */ }
  ' 2>/dev/null || true
fi

# Régi session takarítás
$TMUX kill-session -t "$SESSION" 2>/dev/null

# Reap orphan main-agent channel pollers (bun/node grandchildren of the
# previous tmux server). A tmux kill-session does not always tear them down,
# they keep polling getUpdates with the same bot token, and the fresh poller
# we spawn below 409-Conflicts on every cycle until the old one exits. The
# poller env contains *_STATE_DIR=<this main agent's channel dir>; argv does
# not, so `pkill -f` against the env var never matches. We grep `ps eww -e`
# instead, which surfaces each process environment on macOS BSD ps.
MAIN_CHAN_DIR="$INSTALL_DIR/.claude/channels/$CHANNEL_PROVIDER"
case "$CHANNEL_PROVIDER" in
  slack)    STATE_ENV_VAR="SLACK_STATE_DIR" ;;
  whatsapp) STATE_ENV_VAR="WHATSAPP_STATE_DIR" ;;
  teams)    STATE_ENV_VAR="TEAMS_STATE_DIR" ;;
  discord)  STATE_ENV_VAR="DISCORD_STATE_DIR" ;;
  *)        STATE_ENV_VAR="TELEGRAM_STATE_DIR" ;;
esac
ORPHAN_PIDS="$(/bin/ps eww -e 2>/dev/null | awk -v needle="${STATE_ENV_VAR}=${MAIN_CHAN_DIR}" '$0 ~ needle { print $1 }')"
if [ -n "$ORPHAN_PIDS" ]; then
  # shellcheck disable=SC2086
  /bin/kill -TERM $ORPHAN_PIDS 2>/dev/null || true
  /bin/sleep 0.3
  # shellcheck disable=SC2086
  /bin/kill -KILL $ORPHAN_PIDS 2>/dev/null || true
fi

# Second reap pass for plugin builds that DON'T set *_STATE_DIR in the poller
# env (e.g. telegram@0.0.1). Those pollers carry CLAUDE_PLUGIN_ROOT=.../<provider>
# instead, so the STATE_DIR grep above never matches and orphans accumulate
# across restarts -> multiple getUpdates long-polls -> 409 Conflict -> the bot
# goes silent/flaky.
#
# Scope to THIS (main) agent only. The tmux server is SHARED across the fleet,
# and every sub-agent runs its OWN provider poller out of
# $INSTALL_DIR/agents/<name>/. Those processes carry that agent dir in their
# environment; the main agent's pollers do not. CLAUDE_PLUGIN_ROOT points at the
# shared user-level plugin cache for every agent, so it cannot tell main from
# sub on its own -- without the agents/ exclusion this pass SIGKILLs every live
# sub-agent poller on a main restart (they would only recover on each
# sub-agent's own next restart). A main orphan from an old build has no agent
# dir, so it is still reaped. index() is a literal (non-regex) substring test so
# an install path with regex metacharacters can't break the exclusion. The var
# is named `subdir` (not `sub`) because `sub` is a reserved awk function name and
# BSD/macOS awk syntax-errors on it.
ORPHAN_PIDS2="$(/bin/ps eww -e 2>/dev/null | awk -v needle="CLAUDE_PLUGIN_ROOT=" -v prov="/${CHANNEL_PROVIDER}" -v subdir="${INSTALL_DIR}/agents/" '$0 ~ needle && $0 ~ prov && index($0, subdir) == 0 { print $1 }')"
if [ -n "$ORPHAN_PIDS2" ]; then
  # shellcheck disable=SC2086
  /bin/kill -TERM $ORPHAN_PIDS2 2>/dev/null || true
  /bin/sleep 0.3
  # shellcheck disable=SC2086
  /bin/kill -KILL $ORPHAN_PIDS2 2>/dev/null || true
fi

# P1 FIX: put the Claude auth token into the tmux SERVER global env BEFORE
# new-session. A new session inherits the tmux SERVER's global environment, not
# this shell's. The tmux server is SHARED across every agent, so if a sub-agent
# created the server first, this shell's `export CLAUDE_CODE_OAUTH_TOKEN` (above)
# never reaches the channels claude -> "Not logged in" until the hourly restart.
# Setting it -g makes the launch order irrelevant. Safe to share globally: every
# agent uses the same Claude login (unlike the channel tokens scrubbed above,
# which DO conflict and are -u'd).
#
# `start-server` first, because the "no server yet -> new-session inherits this
# shell's env" assumption below is only safe when NOTHING ELSE creates the
# server in between. At boot it does: systemd starts marveen-channels and
# marveen-dashboard in the same second, and the dashboard's worker sessions win
# the race about half the time. Then `set-environment -g` silently no-ops (no
# server), the dashboard creates the server WITHOUT the token, and our
# new-session inherits that empty global env instead of this shell's -- the
# channels claude comes up "Not logged in - Please run /login" and the Telegram
# plugin dies in a restart loop, on a headless box where /login is impossible.
# Creating the server ourselves makes set-environment -g always land, which is
# what the fix intended. start-server is idempotent and cheap.
$TMUX start-server 2>/dev/null || true
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  $TMUX set-environment -g CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  $TMUX set-environment -g ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" 2>/dev/null || true
fi
# Propagate the prompt-suggestion disable to every sub-agent tmux session.
$TMUX set-environment -g CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION false 2>/dev/null || true

# Hybrid channel-coordinator model: the native plugin stays the PRIMARY inbound
# path (it always polls getUpdates here -- never outbound-only). The standalone
# marveen-channel-coordinator only BACKFILLS while this session's plugin is
# down, so there is never a second concurrent poller in steady state. Nothing to
# set here: the coordinator gates itself on native liveness.

# Tmux session indítás
#
# Always start a fresh conversation. --continue is intentionally omitted:
# the cwd-based project dir may contain the user's own CLI sessions, and
# resuming one of those loses the --channels activation state, causing
# "Channel notifications skipped: server not in --channels list" errors.
#
# Idempotent launch: the service runs KillMode=process so a `systemctl stop`
# no longer cgroup-kills the SHARED tmux server (which would tear down every
# sibling agent session on this host -- the 2026-06-26 fleet-wide outage). The
# trade-off is that a prior "$SESSION" can survive into this relaunch, so kill
# just THIS session first -- never the server, never another agent's session --
# otherwise new-session below fails with "duplicate session".
$TMUX kill-session -t "$SESSION" 2>/dev/null || true
$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "${MCP_BATCH_ENV}${CFG_ENV}$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${PLUGIN_ID}${EXTRA_CHANNELS}"

# Session startup guard: a Claude Code first-run dialogusait auto-accept-eljuk
# kulonben a headless session orokre parkolna a prompton es a Telegram plugin
# soha nem toltodne be. Tobb fajta dialog elofordulhat:
#  - "Bypass Permissions mode" (--dangerously-skip-permissions confirmation,
#    valasz: 2 Enter = "Yes, I accept")
#  - "Do you trust the files in this folder?" / "trust" prompts (Y Enter)
#  - "Welcome to Claude Code" / kezdo vezetes (Enter a folytatashoz)
# 12 sec timeout ket retry-jal, mert WSL/tmux paint slow lehet first-run-on.
#
# EPERM fallback (Claude Code 2.1.183+ regression): launching --channels in a
# trusted project directory throws EPERM before any dialog appears. Detected
# below; one auto-restart from /tmp where the trust dialog fires instead.
_eperm_restarted=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 1
  pane=$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)
  case "$pane" in
    *"EPERM"*|*"Operation not permitted"*|*"operation not permitted"*)
      if [ "$_eperm_restarted" = "0" ]; then
        _eperm_restarted=1
        $TMUX kill-session -t "$SESSION" 2>/dev/null
        _CHANNELS_STARTDIR="$(mktemp -d /tmp/marveen-channels-XXXXXX)"
        # Carry the project CLAUDE.md into the fallback cwd so the session keeps
        # Marveen's instructions/personality instead of running as a generic,
        # context-less assistant (the biggest degradation of the /tmp fallback).
        # Best-effort: a symlink failure degrades to the prior behaviour and
        # never blocks startup. The trust dialog for the fresh /tmp path still
        # fires and is handled by the guard below; EPERM is keyed on the
        # registered project path, not on file presence, so seeding CLAUDE.md
        # does not re-trigger it.
        #
        # NOTE: the project-scoped MCP servers (gmail/calendar) are NOT restored
        # here. Claude Code keys those by project PATH in ~/.claude.json, not in
        # the project .mcp.json, so a random /tmp path has no entry and symlinking
        # files cannot bring them back. Restoring them needs a separate, more
        # invasive change (a stable fallback dir + a seeded ~/.claude.json project
        # entry); see the PR description / card 7EB18437.
        [ -e "$INSTALL_DIR/CLAUDE.md" ] && ln -sf "$INSTALL_DIR/CLAUDE.md" "$_CHANNELS_STARTDIR/CLAUDE.md" 2>/dev/null || true
        $TMUX new-session -d -s "$SESSION" -c "$_CHANNELS_STARTDIR" \
          "${MCP_BATCH_ENV}${CFG_ENV}$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${PLUGIN_ID}${EXTRA_CHANNELS}"
        unset _CHANNELS_STARTDIR
      fi
      continue
      ;;
    *"Bypass Permissions mode"*"Yes, I accept"*)
      $TMUX send-keys -t "$SESSION" "2" Enter
      sleep 1
      continue
      ;;
    *"Do you trust the files in this folder?"*)
      $TMUX send-keys -t "$SESSION" "1" Enter
      sleep 1
      continue
      ;;
    *"Welcome to Claude Code"*)
      $TMUX send-keys -t "$SESSION" Enter
      sleep 1
      continue
      ;;
    *"Listening for channel messages"*)
      break
      ;;
  esac
done
unset _eperm_restarted

# Set agent name once the session is ready. (/remote-control dropped: the operator no
# longer uses Remote Control.)
_bot_name="${BOT_NAME:-${MAIN_AGENT_ID:-marveen}}"
sleep 1
$TMUX send-keys -t "$SESSION" "/name ${_bot_name}" Enter
unset _bot_name

# Reset the keep-alive watchdog baseline so a session that was just restarted
# is not immediately judged stale by the dashboard's checkMainKeepaliveStaleness
# (channel-monitor.ts, ~18min threshold). The dashboard's hardRestartMarveenChannels
# path writes both files when it triggers the restart, but a manual
# `launchctl kickstart -k com.marveen.channels` (or the launchd KeepAlive's own
# restart after a crash) bypasses the dashboard - those code paths never touched
# the watchdog baseline, and the old mtimes survived into the fresh session,
# triggering a false-positive respawn loop within minutes (2026-06-01 18:26).
#
# touch + epoch-write happens unconditionally here so every channels.sh launch
# (manual or dashboard-driven) leaves a consistent baseline. The scheduled
# edit_message keep-alive (every ~6min) takes over from there.
mkdir -p "$INSTALL_DIR/store"
touch "$INSTALL_DIR/store/.channel-keepalive"
date +%s > "$INSTALL_DIR/store/.channel-last-respawn"

# POST-INIT PLUGIN UNLOCK (2026-06-01 Szabi 15:24 incident workaround):
# Claude Code 2.1.159 + telegram-plugin 0.0.6: the `--channels` parameter
# announces "Listening for channel messages from: plugin:telegram@..." in the
# TUI, but the plugin server itself is NOT always spawned on fresh-session
# init - it lands in /mcp's Failed state with no bun-poller child. Manually
# opening /mcp, moving the cursor up to the failed plugin row, and pressing
# Enter twice (enter submenu, press Reconnect) brings the plugin live -
# Szabi's empirical sequence that fixed the 16:31 hard-restart aftermath.
#
# Two-stage detection, both must indicate "no plugin" before we fire keystrokes:
#
#   1. pgrep -P claude_pid bun   -- looks for a bun child of the marveen-channels
#      claude process. This catches the case the env-var grep misses: Claude Code
#      does NOT inherit TELEGRAM_STATE_DIR into the spawned poller on the main
#      session (only on sub-agents), so an env-var-needle scan reports "no
#      poller" even when one is running. A direct child-of-claude pgrep is the
#      authoritative signal.
#
#   2. capture-pane after `/mcp` shows the plugin's own row in a failed state.
#      Connected/Enabled rows must NOT trigger the keystroke sequence, because
#      then `Up`+`Enter`+`Enter` would land on "Disable" in the submenu and
#      disable the plugin instead of reconnecting it (Szabi msg 427).
#
# We sequence the checks, log the decision, and fire only when all agree.
# The subshell is detached so the main script keeps moving to the wait-loop.
#
# MCPDUP806 hardening (2026-08-06, fresh-0.3.9 incident): the round is
# bracketed by input-line proofs.
#   - PRE-FLIGHT: "/mcp" is only typed into a PROVABLY empty idle prompt.
#     Into any other pane state the literal text parks in the input box, the
#     next boot's probe appends to it ("/mcp/mcp"), the combined text gets
#     submitted as a prompt, and while parked it reads as busy to the message
#     router -- muting inter-agent delivery to the main session.
#   - END-OF-ROUND: Escape-until-idle (a single Escape from the per-plugin
#     submenu only pops one level -- the list stays open), then, if our own
#     "/mcp" residue is still parked, one Ctrl-C (the measured clear for a
#     parked line; C-u and Escape verifiably do not empty it) and a final
#     probe. The log records the PROVEN end state, never the intent.
#   - EFFECT: after a fired unlock the bun-poller check re-runs and the log
#     records whether the plugin actually came up -- a green "firing unlock"
#     line alone said nothing about whether the fix landed.
(
  sleep 15
  CLAUDE_PID="$($TMUX list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
  # Check 1: bun grandchild of the marveen-channels claude
  BUN_CHILD=""
  if [ -n "$CLAUDE_PID" ]; then
    BUN_CHILD="$(/usr/bin/pgrep -P "$CLAUDE_PID" bun 2>/dev/null | head -1)"
  fi
  if [ -n "$BUN_CHILD" ]; then
    # Plugin is alive via the authoritative process-tree check. Don't probe the
    # /mcp menu - any keystroke sequence from idle would risk a stray Enter
    # disabling a healthy plugin.
    exit 0
  fi

  # Check 2 (MCPDUP806 pre-flight): the input line must be PROVABLY empty
  # before we type. Retried because a slow cold-start may not have rendered
  # the idle footer yet at +15s; when the pane never confirms idle (busy turn,
  # parked text, dialog, or no node/dist to measure with) we do NOT type --
  # the dashboard channel-monitor's recovery ladder owns the pane from there.
  PROBE_STATE="unverifiable"
  for _try in 1 2 3; do
    PROBE_STATE="$($TMUX capture-pane -t "$SESSION" -e -p 2>/dev/null | probe_pane_input_state)"
    [ "$PROBE_STATE" = "idle" ] && break
    case "$PROBE_STATE" in
      parked:*)
        # Residue of OUR OWN earlier probe (a previous boot's round left "/mcp"
        # parked -- the incident state). It is ours, so clear it with the
        # measured keystroke and let the retry re-prove emptiness. Any other
        # parked text is never touched here; the stuck-input recovery stack
        # owns it.
        if is_own_probe_residue "${PROBE_STATE#parked:}"; then
          $TMUX send-keys -t "$SESSION" C-c
          sleep 1
        fi
        ;;
    esac
    sleep 10
  done
  if [ "$PROBE_STATE" != "idle" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: unlock probe SKIPPED -- input line not confirmed empty (state: $PROBE_STATE); typing /mcp would park in the box (MCPDUP806), deferring to the dashboard channel-monitor" >> "$INSTALL_DIR/store/channels-failures.log"
    exit 0
  fi

  # Check 3: TUI confirmation that the plugin's row is in a failed state. The
  # /mcp view also shows "(disabled)" markers; we only fire on failed, never on
  # disabled (Enable-only submenu has no Reconnect, the Up+Enter+Enter sequence
  # would land somewhere unsafe). See classify_mcp_plugin_row above for why the
  # matching is row-scoped and glyph-agnostic.
  $TMUX send-keys -t "$SESSION" Escape
  sleep 1
  $TMUX send-keys -t "$SESSION" "/mcp" Enter
  sleep 3
  PANE="$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)"

  classify_mcp_plugin_row "$PANE"
  UNLOCK_FIRED=0
  case "$MCP_PLUGIN_STATE" in
    failed)
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: $CHANNEL_PROVIDER plugin row failed, firing /mcp Up+Enter+Enter unlock -- row: $MCP_PLUGIN_ROW" >> "$INSTALL_DIR/store/channels-failures.log"
      $TMUX send-keys -t "$SESSION" Up
      sleep 1
      $TMUX send-keys -t "$SESSION" Enter
      sleep 2
      $TMUX send-keys -t "$SESSION" Enter
      sleep 4
      UNLOCK_FIRED=1
      ;;
    *)
      # Plugin is connected/enabled/not-listed, or we couldn't capture. Bail
      # out safely. If the plugin row literally doesn't appear in the /mcp
      # listing (truly unreachable), the dashboard's channel-monitor will
      # detect down and run its own recovery ladder; we don't second-guess.
      # Log the row we DID see -- a stale matcher is invisible without it.
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: no failed plugin row in /mcp pane, skipping unlock (bun child absent but plugin not failed - check manually) -- looked for '$PLUGIN_PANE_ID', row: ${MCP_PLUGIN_ROW:-<none>}" >> "$INSTALL_DIR/store/channels-failures.log"
      ;;
  esac

  # End-of-round (MCPDUP806): leave the input line PROVABLY empty. Escape
  # dismisses the /mcp modal levels but never clears parked text, so after the
  # bounded Escape loop any leftover of OUR OWN probe ("/mcp" fragments only --
  # never anything else, a human draft or a delivered message belongs to the
  # stuck-input recovery stack) is cleared with a single Ctrl-C and re-proven.
  END_STATE="unknown"
  for _i in 1 2 3 4 5; do
    $TMUX send-keys -t "$SESSION" Escape
    sleep 1
    END_STATE="$($TMUX capture-pane -t "$SESSION" -e -p 2>/dev/null | probe_pane_input_state)"
    [ "$END_STATE" = "idle" ] && break
  done
  case "$END_STATE" in
    parked:*)
      if is_own_probe_residue "${END_STATE#parked:}"; then
        $TMUX send-keys -t "$SESSION" C-c
        sleep 1
        END_STATE="$($TMUX capture-pane -t "$SESSION" -e -p 2>/dev/null | probe_pane_input_state)"
      fi
      ;;
  esac
  if [ "$END_STATE" = "idle" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: unlock round finished, input line verified empty" >> "$INSTALL_DIR/store/channels-failures.log"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: input line NOT verified empty after unlock round (state: $END_STATE) -- not retrying (MCPDUP806), check manually: tmux attach -t $SESSION" >> "$INSTALL_DIR/store/channels-failures.log"
  fi

  # Effect (MCPDUP806): a fired unlock is only a keystroke sequence; whether it
  # WORKED shows up as the plugin's bun poller appearing under the claude
  # process. Poll for up to ~60s (a reconnect can take tens of seconds to
  # spawn the poller -- an instant read would log a false STILL ABSENT), then
  # record the measured outcome so the failure log carries the effect, not
  # just the attempt.
  if [ "$UNLOCK_FIRED" = "1" ]; then
    BUN_AFTER=""
    for _w in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 5
      if [ -n "$CLAUDE_PID" ]; then
        BUN_AFTER="$(/usr/bin/pgrep -P "$CLAUDE_PID" bun 2>/dev/null | head -1)"
      fi
      [ -n "$BUN_AFTER" ] && break
    done
    if [ -n "$BUN_AFTER" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: unlock effect: plugin bun poller RUNNING (pid $BUN_AFTER)" >> "$INSTALL_DIR/store/channels-failures.log"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: unlock effect: plugin bun poller STILL ABSENT 60s after the Up+Enter+Enter unlock -- the unlock did not take effect" >> "$INSTALL_DIR/store/channels-failures.log"
    fi
  fi
) &

# Bot menu setup (Telegram only; Slack uses App Manifest)
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  "$INSTALL_DIR/scripts/set-bot-menu.sh" &
fi

# Rapid-failure detection: if claude exits within 30s of startup, this is
# likely a config error (bad token, missing plugin, auth issue). We log the
# failure and exit non-zero so the service manager's own back-off kicks in
# instead of tight-looping and burning API tokens.
START_TS=$(date +%s)

# Plugin liveness watchdog (main channels session only) -- a last-resort
# backstop UNDER the dashboard channel-monitor, not a replacement. The monitor
# is the primary recovery, but its down-state lives in dashboard process
# memory: a plugin that dies WHILE THE DASHBOARD ITSELF IS RESTARTING is missed
# (the in-memory state machine resets and never re-detects it). This in-session
# shell watchdog is independent of the dashboard. If the channel bot process
# (tracked via the plugin's bot.pid) never comes up, OR comes up and then stays
# dead, we exit so the service manager (launchd/systemd) restarts us with a
# fresh Claude + plugin.
#
# Thresholds are deliberately COARSER than the dashboard monitor's (~60-120s)
# so in normal operation the dashboard acts FIRST and this only fires when the
# dashboard couldn't -- avoids double-restart races. bot.pid lives at the
# main-agent channelStateDir(): ~/.claude/channels/<provider>/bot.pid (HOME-,
# not INSTALL_DIR-relative; see src/channel-provider.ts channelStateDir()).
MAIN_BOT_PID_FILE="$HOME/.claude/channels/$CHANNEL_PROVIDER/bot.pid"
# Never-started budget: generous so a slow cold-start (WSL first-run, MCP
# handshake + /mcp unlock retries) is never killed prematurely. The plugin
# normally writes bot.pid within ~1-2 min; 10 min is a safe ceiling.
#
# The budget GROWS across consecutive restarts, and that is the point. On a host
# where the plugin cannot start at all -- AVX-less box, broken plugin cache,
# Claude auth deferred at install -- a fixed 10-minute budget becomes a
# ten-minute restart cycle that never ends. Each restart kill-sessions and
# recreates the agent's tmux session, so on a machine where Claude itself works
# and only the plugin is dead, the main agent loses its context every ten
# minutes. Measured on a live host on 2026-08-04: exit 1 at 08:23:52, systemd
# restart at 08:24:03, fresh session at 08:24:04, and the same again one budget
# later. Before the watchdog exited non-zero that host simply kept a working
# agent with a dead channel -- so an unbounded cycle would be a regression for
# that population, not an improvement.
#
# What is deliberately NOT damped: the signal. The warning still goes to the log
# and the exit is still non-zero, so the service manager still restarts the unit
# and OnFailure= still fires. We slow the churn down; we do not silence the
# symptom. A host that recovers resets the streak, so a healthy machine keeps
# the original fast watchdog.
NEVER_STARTED_BASE=600
NEVER_STARTED_CAP=2400
NEVER_STARTED_STREAK_FILE="$INSTALL_DIR/store/.channel-neverstart-streak"

# Budget for the Nth consecutive never-started exit: 600 -> 1200 -> 2400, capped.
never_started_budget() {
  _streak="${1:-0}"
  case "$_streak" in ''|*[!0-9]*) _streak=0 ;; esac
  _budget=$NEVER_STARTED_BASE
  _i=0
  while [ "$_i" -lt "$_streak" ]; do
    _budget=$((_budget * 2))
    if [ "$_budget" -ge "$NEVER_STARTED_CAP" ]; then
      _budget=$NEVER_STARTED_CAP
      break
    fi
    _i=$((_i + 1))
  done
  echo "$_budget"
}

NEVER_STARTED_STREAK="$(cat "$NEVER_STARTED_STREAK_FILE" 2>/dev/null | tr -d '[:space:]')"
case "$NEVER_STARTED_STREAK" in ''|*[!0-9]*) NEVER_STARTED_STREAK=0 ;; esac
PLUGIN_NEVER_STARTED_BUDGET="$(never_started_budget "$NEVER_STARTED_STREAK")"
PLUGIN_NEVER_STARTED_DEADLINE=$((START_TS + PLUGIN_NEVER_STARTED_BUDGET))
# Died-after-up budget: once we have seen the plugin alive, a continuous
# disappearance this long means it crashed and is not self-recovering.
PLUGIN_DEAD_GRACE=180
PLUGIN_SEEN_ONCE=false
PLUGIN_DEAD_SINCE=0
# Set to 1 when the watchdog below breaks out ON PURPOSE to be restarted. The
# exit status has to carry that intent: a watchdog exit is not a normal one, and
# a unit still carrying the old Restart=on-failure would read exit 0 as "this
# service is done" and never bring the channel back. Measured on a live install
# 2026-08-04: channels.sh logged "exiting for service-manager restart", exited 0,
# and the unit stayed inactive/dead for the next ten minutes.
RESTART_REQUESTED=0

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5

  NOW=$(date +%s)
  _plugin_alive=false
  if [ -f "$MAIN_BOT_PID_FILE" ]; then
    _bot_pid=$(cat "$MAIN_BOT_PID_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$_bot_pid" ] && [ "$_bot_pid" -gt 1 ] 2>/dev/null && kill -0 "$_bot_pid" 2>/dev/null; then
      _plugin_alive=true
    fi
  fi
  unset _bot_pid
  # Fallback for plugin builds that never write bot.pid (e.g. telegram@0.0.1):
  # treat a running plugin poller as alive. The poller is a bun process whose
  # env CLAUDE_PLUGIN_ROOT points at the <provider> plugin dir. `ps eww -e`
  # surfaces each process environment on macOS BSD ps (same technique the
  # orphan-reaper above uses). Without this the watchdog false-restarts every
  # ~10 min on plugin versions that don't emit a bot.pid.
  if [ "$_plugin_alive" != "true" ]; then
    if /bin/ps eww -e 2>/dev/null | grep -qE "CLAUDE_PLUGIN_ROOT=[^ ]*/${CHANNEL_PROVIDER}(/|@| |$)"; then
      _plugin_alive=true
    fi
  fi

  if [ "$_plugin_alive" = "true" ]; then
    PLUGIN_SEEN_ONCE=true
    PLUGIN_DEAD_SINCE=0
    # The plugin came up, so this host is not in the never-starting state:
    # drop the streak so the next cold start gets the fast 10-minute watchdog
    # again instead of inheriting a 40-minute budget from an old outage.
    if [ "$NEVER_STARTED_STREAK" != "0" ]; then
      rm -f "$NEVER_STARTED_STREAK_FILE" 2>/dev/null || true
      NEVER_STARTED_STREAK=0
    fi
  elif [ "$PLUGIN_SEEN_ONCE" = "true" ]; then
    # Was up, now gone -- start/continue the dead-grace timer (a transient
    # gap that recovers resets it, so only a sustained death triggers exit).
    if [ "$PLUGIN_DEAD_SINCE" -eq 0 ]; then
      PLUGIN_DEAD_SINCE=$NOW
      echo "WARN: $CHANNEL_PROVIDER plugin (bot.pid) disappeared -- ${PLUGIN_DEAD_GRACE}s grace before restart" >&2
    elif [ "$((NOW - PLUGIN_DEAD_SINCE))" -ge "$PLUGIN_DEAD_GRACE" ]; then
      echo "WARN: $CHANNEL_PROVIDER plugin dead for $((NOW - PLUGIN_DEAD_SINCE))s -- exiting for service-manager restart" >&2
      RESTART_REQUESTED=1
      break
    fi
  else
    # Never came up at all (e.g. a Claude Code build that silently disables
    # --channels). Give it the full cold-start budget, then restart.
    if [ "$NOW" -ge "$PLUGIN_NEVER_STARTED_DEADLINE" ]; then
      # Persist the streak BEFORE exiting: the next process start reads it and
      # waits longer. Written first so a kill between the write and the exit
      # still leaves the counter advanced rather than stuck at the fast budget.
      _next_streak=$((NEVER_STARTED_STREAK + 1))
      echo "$_next_streak" > "$NEVER_STARTED_STREAK_FILE" 2>/dev/null || true
      echo "WARN: $CHANNEL_PROVIDER plugin never started within ${PLUGIN_NEVER_STARTED_BUDGET}s -- exiting for service-manager restart (consecutive: $_next_streak, next budget: $(never_started_budget "$_next_streak")s)" >&2
      RESTART_REQUESTED=1
      break
    fi
  fi
done

ELAPSED=$(( $(date +%s) - START_TS ))
if [ "$ELAPSED" -lt 30 ]; then
  echo "WARN: channels session exited after ${ELAPSED}s (likely config error). Check logs." >&2
  echo "$(date '+%Y-%m-%d %H:%M:%S') rapid-exit after ${ELAPSED}s" >> "$INSTALL_DIR/store/channels-failures.log"
  FAIL_COUNT=$(wc -l < "$INSTALL_DIR/store/channels-failures.log" 2>/dev/null || echo 0)
  FAIL_COUNT=$((FAIL_COUNT))
  if [ "$FAIL_COUNT" -ge 5 ]; then
    echo "ERROR: ${FAIL_COUNT} rapid failures detected. Waiting 300s before next attempt." >&2
    sleep 300
  elif [ "$FAIL_COUNT" -ge 3 ]; then
    echo "WARN: ${FAIL_COUNT} rapid failures. Waiting 60s." >&2
    sleep 60
  fi
  exit 1
fi

# Normal exit: clear failure log
rm -f "$INSTALL_DIR/store/channels-failures.log"

# A watchdog exit asked for a restart, so it must NOT look like a clean finish.
# Written as an if (not `[ ] && exit 1`) so a future `set -e` cannot turn the
# false branch into an accidental non-zero exit of the whole script.
if [ "$RESTART_REQUESTED" = "1" ]; then
  exit 1
fi
exit 0
