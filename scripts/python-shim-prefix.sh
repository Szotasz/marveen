#!/bin/bash
# FLEETVENV923: print the PATH prefix ("<install>/store/python-shim:" or nothing)
# that puts an opt-in fleet Python venv's python3/pip in front of the system
# ones, for every launcher that builds an agent PATH in shell (channels.sh,
# watchdog.sh). The TS launchers (startAgentProcess, the channel-monitor
# relaunch, background claude -p) do the same via fleetVenvPathPrefix().
#
# Why a shim and not <venv>/bin: prepending the whole bin/ would put every pip
# console-script ahead of /opt/homebrew/bin and /usr/bin for every agent, so a
# package named like a system tool (git, gh, curl, node) could shadow it, and
# every governance hook's `command -v python3` would run on the venv too. The
# shim exposes ONLY python3, python, pip and pip3 as symlinks; a venv CLI such
# as markitdown is reachable as `python3 -m markitdown`.
#
# Opt-in: FLEET_PYTHON_VENV in <install>/.env. Empty or unset = off. Read the
# way channels.sh reads MAIN_AGENT_ID (one grep, no `set -a`, nothing else from
# .env leaks into the environment). Surrounding single or double quotes are
# stripped (the TS side's readEnvFile strips them too, and the two sides must
# agree or the main session and the sub-agents would run different pythons on
# the same .env). A leading `~` means $HOME. A venv without bin/python3, or a
# shim path with a character that is unsafe inside the launchers' double-quoted
# `export PATH="..."`, prints nothing (off) rather than a half-built prefix.
#
# Usage: PREFIX="$(bash "$INSTALL_DIR/scripts/python-shim-prefix.sh" "$INSTALL_DIR")"
set -u
INSTALL_DIR="${1:-}"
[ -n "$INSTALL_DIR" ] || exit 0
[ -f "$INSTALL_DIR/.env" ] || exit 0

VENV="$(grep -E '^FLEET_PYTHON_VENV=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
# strip one pair of surrounding quotes, then surrounding whitespace
VENV="${VENV#\"}"; VENV="${VENV%\"}"
VENV="${VENV#\'}"; VENV="${VENV%\'}"
VENV="$(printf '%s' "$VENV" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
[ -n "$VENV" ] || exit 0
case "$VENV" in "~"*) VENV="$HOME${VENV#\~}" ;; esac
[ -x "$VENV/bin/python3" ] || exit 0

SHIM="$INSTALL_DIR/store/python-shim"
case "$SHIM" in *[\"\$\`\\]*) exit 0 ;; esac
mkdir -p "$SHIM" 2>/dev/null || exit 0
for tool in python3 python pip pip3; do
  if [ -x "$VENV/bin/$tool" ]; then
    ln -sfn "$VENV/bin/$tool" "$SHIM/$tool" 2>/dev/null || exit 0
  else
    rm -f "$SHIM/$tool" 2>/dev/null
  fi
done
printf '%s:' "$SHIM"
