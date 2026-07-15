#!/usr/bin/env bash
# One-command remediation for EXISTING Marveen installs on AVX-less x86 hosts.
#
# Older installers pinned claude to 2.0.76 (predates --channels, so the channel
# bot could never boot) and left the auto-updater on (first run swaps the pinned
# Node build for the latest Bun ELF binary -> SIGILL). New installs are fixed by
# install-linux.sh (#608); this script repairs machines installed before that:
#   1. re-pins claude to 2.1.110 -- the last release shipping the Node cli.js
#      entrypoint (2.1.120+ is Bun-only) AND supporting --channels
#   2. persists DISABLE_AUTOUPDATER=1 (rc files, same pattern as the installer)
#   3. verifies claude actually launches (no Illegal instruction)
#
# Idempotent (safe to re-run) and a no-op on AVX-capable x86, ARM and macOS.
set -u

BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[0;32m'; ORANGE='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${ORANGE}!${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*"; }

# Keep in sync with install-linux.sh CLAUDE_PIN.
CLAUDE_PIN="2.1.110"

echo -e "${BOLD}Marveen -- AVX-less host remediation (claude @${CLAUDE_PIN} + updater off)${NC}"
echo ""

# --- 1. AVX pre-flight (same detection as install-linux.sh) ---
# Only x86 has a `flags :` line in /proc/cpuinfo; ARM uses `Features :` and its
# Bun binary needs no AVX, macOS has no /proc at all -- both are no-ops here.
if ! grep -qE '^flags[[:space:]]*:' /proc/cpuinfo 2>/dev/null || grep -qiw avx /proc/cpuinfo 2>/dev/null; then
  ok "Ez a gep nem AVX-hianyos x86 (AVX-kepes vagy ARM/macOS) -- nincs teendo."
  exit 0
fi
warn "AVX-hianyos x86 CPU detektalva -- a Bun-alapu claude build itt SIGILL-lel elszall."

# --- 2. Re-pin claude to the Node-based build ---
# `claude --version` can hang on a broken (Bun) install, so always timeout it.
_claude_runs() { command -v claude >/dev/null 2>&1 && timeout 25 claude --version </dev/null >/dev/null 2>&1; }
_claude_version() { timeout 25 claude --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

if _claude_runs && [ "$(_claude_version)" = "$CLAUDE_PIN" ]; then
  ok "claude mar a pinnelt @${CLAUDE_PIN} verzion fut -- telepites kihagyva."
else
  echo -e "  Pinnelt Node-verzio telepitese: @${CLAUDE_PIN}..."
  if command -v npm >/dev/null 2>&1; then
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_PIN}" || warn "npm install sikertelen (@${CLAUDE_PIN})."
  else
    warn "npm nem elerheto; a pinnelt hivatalos installert probalom (@${CLAUDE_PIN})."
    curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_PIN}" || warn "pinnelt install.sh sikertelen."
  fi
  hash -r
fi

# --- 3. Persist DISABLE_AUTOUPDATER=1 (same rc pattern as install-linux.sh) ---
# Without this the first claude run replaces the pin with the latest Bun binary.
ensure_in_rc() {
  local marker="$1" line="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '%s\n' "$line" >>"$rc"
    warn "RC frissitve ($(basename "$rc")): $line"
  done
}
ensure_in_rc 'DISABLE_AUTOUPDATER' 'export DISABLE_AUTOUPDATER=1'
export DISABLE_AUTOUPDATER=1
ok "Auto-updater kikapcsolva (DISABLE_AUTOUPDATER=1, rc-fajlokban is)."

# --- 4. Verify the pinned claude actually launches ---
if _claude_runs; then
  ok "claude telepitve es fut: $(timeout 25 claude --version </dev/null 2>/dev/null || echo 'ok')"
else
  err "claude telepitve, de nem indul (valoszinuleg tovabbra is Bun-binary fut, vagy hianyzo Node)."
  if command -v npm >/dev/null 2>&1; then
    echo -e "  ${DIM}Probald manualisan: npm install -g @anthropic-ai/claude-code@${CLAUDE_PIN}${NC}"
  else
    echo -e "  ${DIM}Telepits nvm+node-ot, majd: npm install -g @anthropic-ai/claude-code@${CLAUDE_PIN}${NC}"
  fi
  exit 1
fi

# --- 5. Next steps ---
echo ""
echo -e "${BOLD}Kesz. Kovetkezo lepesek:${NC}"
echo -e "  1. Marveen ujrainditasa, hogy az uj claude-ot es a kikapcsolt updatert felvegye:"
echo -e "     ${DIM}systemd:${NC} systemctl --user restart marveen-channels 2>/dev/null || \\"
echo -e "     ${DIM}kezzel: ${NC} bash <install-dir>/scripts/channels.sh"
echo -e "  2. Ha a verziovaltas miatt ujra be kell jelentkezni:"
echo -e "     bash <install-dir>/scripts/auth.sh"
