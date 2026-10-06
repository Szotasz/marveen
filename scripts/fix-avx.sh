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
# Does an installed claude actually LAUNCH? On an AVX-less x86 host the official
# installer's Bun standalone binary SIGILLs / hangs on start, so `command -v`
# alone is not enough -- we verify it runs. `--version` is NOT that probe:
# measured 2026-09-23 on the AVX-less pilot VPS (CLIRUNSVERZIO923), the
# 2.1.200+ Bun ELF answers `--version` with exit 0 and then spins silently on a
# real prompt, so a host that already carries a latest claude would pass the
# gate and get an install on which no agent prompt ever runs. The probe is a
# real `-p` prompt, made auth-free on purpose: an isolated EMPTY config dir and
# the auth env unset make a healthy CLI exit 1 within ~2 s ("Not logged in",
# JSON on stdout, no API call, nothing written to the real config), while a Bun
# binary without AVX either SIGILLs (exit 132) or hangs until `timeout` (124).
# "Runs" therefore means: exited on its own with a code below 124.
_claude_runs() {
  command -v claude >/dev/null 2>&1 || return 1
  local probe_cfg rc
  probe_cfg="$(mktemp -d 2>/dev/null || echo "/tmp/claude-probe-$$")"
  mkdir -p "$probe_cfg"
  env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    CLAUDE_CONFIG_DIR="$probe_cfg" DISABLE_AUTOUPDATER=1 \
    timeout "${CLAUDE_PROBE_TIMEOUT:-25}" claude -p 'ping' --max-turns 1 --output-format json \
    </dev/null >/dev/null 2>&1
  rc=$?
  rm -rf "$probe_cfg"
  # 124 = hung until timeout, 125-127 = could not even exec, 128+ = killed by a signal (SIGILL/SIGSEGV)
  [ "$rc" -lt 124 ]
}
# A claude that is on PATH but does not launch (typically the official
# installer's Bun ELF at ~/.local/bin/claude) would keep SHADOWING the pinned
# Node build: ~/.local/bin is first on PATH and `npm -g` lands in /usr/bin or
# ~/.npm-global. Move it aside (reversible: <path>.avx-broken) so the pin wins.
_shelve_broken_claude() {
  local p
  p="$(command -v claude 2>/dev/null || true)"
  [ -n "$p" ] || return 0
  if mv "$p" "${p}.avx-broken" 2>/dev/null; then
    warn "A mar telepitett claude ($p) AVX nelkul nem indul; felretettem: ${p}.avx-broken"
  else
    warn "A mar telepitett claude ($p) AVX nelkul nem indul, es nem tudtam felretenni -- a pinnelt verziot arnyekolhatja."
  fi
  hash -r
}
_claude_version() { timeout 25 claude --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

if _claude_runs; then
  CLAUDE_LAUNCHES=1
else
  CLAUDE_LAUNCHES=0
fi
if [ "$CLAUDE_LAUNCHES" = "1" ] && [ "$(_claude_version)" = "$CLAUDE_PIN" ]; then
  ok "claude mar a pinnelt @${CLAUDE_PIN} verzion fut -- telepites kihagyva."
else
  # On PATH but does not launch: shelve it, or the pin installed below stays shadowed.
  if [ "$CLAUDE_LAUNCHES" = "0" ] && command -v claude >/dev/null 2>&1; then _shelve_broken_claude; fi
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
