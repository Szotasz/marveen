#!/bin/bash
# Shell rc secret scrub for ALREADY INSTALLED Linux machines (SECSZIVEKKIADAS1008).
#
# Installers before SECSZIVEK1007 (#1785) wrote `export CLAUDE_CODE_OAUTH_TOKEN=...`
# / `export ANTHROPIC_API_KEY=...` into ~/.bashrc and ~/.zshrc. #1785 stopped
# writing them and taught install-linux.sh to remove them -- but only inside the
# auth prompt, which an existing install never reaches, and the customer's update
# path is update.sh, which never ran install-linux.sh. So on every machine that
# already had the lines, they stayed. update.sh sources this file in its unit
# maintenance; install-linux.sh carries the SAME functions inline (it must also
# run on its own, before the repo exists), and a test keeps the two copies equal.
#
# A removed export is replaced by one line that READS the value from the 0600
# install file at shell start, so an interactive `claude` keeps working; nothing
# is added where there was no export to remove. Needs INSTALL_DIR and HOME.

# update.sh has no warn(); keep the installer's message format.
type warn >/dev/null 2>&1 || warn() { echo -e "  ${ORANGE:-}$*${NC:-}"; }

ensure_in_rc() {
  local marker="$1" line="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '%s\n' "$line" >>"$rc"
    warn "RC frissitve ($(basename "$rc")): $line"
  done
}

remove_secret_export_from_rc() {
  local var="$1" rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Eq "^[[:space:]]*export[[:space:]]+${var}=" "$rc" 2>/dev/null || continue
    { grep -Ev "^[[:space:]]*export[[:space:]]+${var}=" "$rc" || true; } >"$rc.tmp" \
      && cat "$rc.tmp" >"$rc" && rm -f "$rc.tmp"
    warn "$(basename "$rc"): a korabbi ${var} export-sor torolve (titok nem kerul shell rc fajlba)"
  done
}

ensure_secret_reader_in_rc() {
  local var="$1" file="$2" kind="$3" q marker line
  q="'$(printf '%s' "$file" | sed "s/'/'\\\\''/g")'"
  marker="# marveen: ${var} from the install's 0600 file"
  if [ "$kind" = "env" ]; then
    line="${marker}"$'\n'"_mv=\"\$(grep -m1 '^${var}=' ${q} 2>/dev/null | cut -d= -f2-)\"; [ -n \"\$_mv\" ] && export ${var}=\"\$_mv\"; unset _mv"
  else
    line="${marker}"$'\n'"[ -s ${q} ] && export ${var}=\"\$(cat ${q})\""
  fi
  ensure_in_rc "$marker" "$line"
}

rc_has_secret_export() {
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -Eq "^[[:space:]]*export[[:space:]]+${1}=" "$rc" 2>/dev/null && return 0
  done
  return 1
}

scrub_secret_exports_from_rc() {
  if rc_has_secret_export ANTHROPIC_API_KEY; then
    remove_secret_export_from_rc ANTHROPIC_API_KEY
    ensure_secret_reader_in_rc ANTHROPIC_API_KEY "$INSTALL_DIR/.env" env
  fi
  if rc_has_secret_export CLAUDE_CODE_OAUTH_TOKEN; then
    remove_secret_export_from_rc CLAUDE_CODE_OAUTH_TOKEN
    ensure_secret_reader_in_rc CLAUDE_CODE_OAUTH_TOKEN "$INSTALL_DIR/store/.claude-oauth-token" file
  fi
  return 0
}
