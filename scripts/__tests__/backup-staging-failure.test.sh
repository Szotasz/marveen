#!/usr/bin/env bash
# backup.sh must FAIL (exit 6) when any staged entry could not be copied
# completely -- including an unreadable file INSIDE a directory entry, where
# the manifest names the directory (which did get in) and verification alone
# would pass. Synthetic repo, no network, no real store.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../backup.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 -- got '$2', want '$3'"; fail=$((fail+1)); fi; }

mkrepo() {
  local t; t="$(mktemp -d "${TMPDIR:-/tmp}/bk-stage.XXXXXX")"
  mkdir -p "$t/scripts" "$t/store/sub" "$t/home/.claude/skills/x" "$t/home/.claude/scheduled-tasks/y"
  echo s > "$t/home/.claude/skills/x/SKILL.md"; echo s > "$t/home/.claude/scheduled-tasks/y/SKILL.md"
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$t/store/claudeclaw.db" 'CREATE TABLE t(x);'; else echo db > "$t/store/claudeclaw.db"; fi
  cp "$SRC" "$t/scripts/backup.sh"
  echo ok > "$t/store/good.txt"; echo ok > "$t/store/sub/good.txt"
  git -C "$t" init -q && git -C "$t" add -A && git -C "$t" -c user.name=t -c user.email=t@t commit -qm init
  echo "$t"
}
run() { ( cd "$1" && HOME="$1/home" BACKUP_DIR="$1/bk" KEEP=1 bash scripts/backup.sh >"$1/out.log" 2>&1 ); echo $?; }

T="$(mkrepo)"; check "clean run exits 0" "$(run "$T")" "0"; rm -rf "$T"

T="$(mkrepo)"; echo x > "$T/store/sub/unreadable.txt"; chmod 000 "$T/store/sub/unreadable.txt"
rc="$(run "$T")"; chmod 600 "$T/store/sub/unreadable.txt"
check "unreadable file inside a directory -> exit 6" "$rc" "6"
check "  ... and says so" "$(grep -c 'FAILED staging' "$T/out.log")" "1"
rm -rf "$T"

T="$(mkrepo)"; echo x > "$T/store/top-unreadable.txt"; chmod 000 "$T/store/top-unreadable.txt"
rc="$(run "$T")"; chmod 600 "$T/store/top-unreadable.txt"
check "unreadable top-level file -> exit 6" "$rc" "6"
rm -rf "$T"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
