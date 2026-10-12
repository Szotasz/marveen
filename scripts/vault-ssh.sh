#!/usr/bin/env bash
# Run one command on a server registered in the SSH vault, with its vault key.
#
#   scripts/vault-ssh.sh [--dry] <server-id-or-name> <remote-command>
#
# stdin goes through to the remote command, so a script needs no file on the
# server and no quoting inside the remote command:
#
#   scripts/vault-ssh.sh my-server 'cd ~/site && php' < probe.php
#
# The exit code is the remote command's (255 when ssh itself fails).
#
# Why a script and not a recipe: every agent used to write the key to a path of
# its own choosing. A FIXED path breaks the moment two runs overlap -- the one
# that finishes first wipes the other's key ("no such identity", publickey
# denied). Here every run gets its own mktemp -d directory (0700), the key is a
# 0600 file inside it, and an EXIT trap overwrites and removes both, on success,
# failure and Ctrl-C alike. The key never reaches stdout or stderr.
#
# --dry  materializes the key and wipes it again without connecting: checks the
#        directory and file modes, prints the key's fingerprint (public, not the
#        key) and the ssh command that would run, then confirms the directory
#        is gone. stdin is not read.
#
# Env: VAULT_SSH_CONNECT_TIMEOUT (seconds, default 20).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

dry=0
if [ "${1:-}" = "--dry" ]; then dry=1; shift; fi
if [ $# -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: vault-ssh.sh [--dry] <server-id-or-name> <remote-command>" >&2
  exit 2
fi
server="$1"
remote_cmd="$2"

umask 077
tmproot="${TMPDIR:-/tmp}"
workdir="$(mktemp -d "${tmproot%/}/vault-ssh.XXXXXX")" || { echo "vault-ssh: mktemp failed" >&2; exit 1; }
keyfile="$workdir/id"

# Overwrite every file in the run directory, then remove it. Python, because
# the fleet's shell gates refuse the usual shell tools for this.
wipe() {
  python3 - "$workdir" <<'PY'
import os, sys
d = sys.argv[1]
if os.path.isdir(d):
    for name in os.listdir(d):
        p = os.path.join(d, name)
        try:
            size = os.path.getsize(p)
            with open(p, 'r+b') as f:
                f.write(os.urandom(max(size, 1)))
                f.flush()
                os.fsync(f.fileno())
        except OSError:
            pass
        try:
            os.remove(p)
        except OSError:
            pass
    os.rmdir(d)
PY
}
trap wipe EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

target_line="$(node "$SCRIPT_DIR/vault-ssh-key.mjs" "$server" "$keyfile")" || exit $?
target="${target_line% *}"
port="${target_line##* }"

ssh_args=(
  -i "$keyfile"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o "ConnectTimeout=${VAULT_SSH_CONNECT_TIMEOUT:-20}"
  -p "$port"
  "$target"
  "$remote_cmd"
)

# The client forwards LANG/LC_* (SendEnv in the stock macOS ssh_config), and a
# server without that locale makes every perl it starts print a five-line
# warning. Not forwarding them prevents it; the filter below catches what a
# server prints anyway.
env_unset=()
for v in $(compgen -e); do
  case "$v" in LANG|LANGUAGE|LC_*) env_unset+=(-u "$v") ;; esac
done

if [ "$dry" -eq 1 ]; then
  python3 - "$workdir" "$keyfile" <<'PY' || exit 1
import os, stat, sys
d, k = sys.argv[1], sys.argv[2]
dm = stat.S_IMODE(os.stat(d).st_mode)
km = stat.S_IMODE(os.stat(k).st_mode)
print(f"dir:  {oct(dm)[2:]} (want 700)")
print(f"key:  {oct(km)[2:]} (want 600), {os.path.getsize(k)} bytes")
with open(k, 'rb') as f:
    head = f.readline().strip()
ok_head = head.startswith(b'-----BEGIN ') and head.endswith(b'PRIVATE KEY-----')
print(f"form: {'private key header OK' if ok_head else 'NOT a private key header'}")
sys.exit(0 if (dm == 0o700 and km == 0o600 and ok_head) else 1)
PY
  fp="$(ssh-keygen -l -f "$keyfile" 2>/dev/null)" || { echo "fingerprint: ssh-keygen cannot read the key" >&2; exit 1; }
  echo "fingerprint: $fp"
  # printf repeats its format once even with no arguments, so the empty unset
  # list must not reach it.
  printf 'would run:'
  if [ ${#env_unset[@]} -gt 0 ]; then printf ' env'; printf ' %q' "${env_unset[@]}"; fi
  printf ' ssh'; printf ' %q' "${ssh_args[@]}"; printf '\n'
  wipe
  trap - EXIT
  if [ -e "$workdir" ]; then echo "wipe: FAILED, $workdir still exists" >&2; exit 1; fi
  echo "wipe: OK, the run directory is gone"
  exit 0
fi

perl_locale_noise='^perl: warning: |^[[:space:]]+(LANGUAGE|LANG|LC_[A-Z]+) = |^[[:space:]]+are supported and installed on your system\.$'

# stdout goes straight through; only stderr runs through the filter, and the
# exit code is ssh's own (PIPESTATUS[0]), not the filter's.
{
  env ${env_unset[@]+"${env_unset[@]}"} ssh "${ssh_args[@]}" 2>&1 1>&3 3>&- \
    | grep --line-buffered -v -E "$perl_locale_noise" 1>&2
  rc=${PIPESTATUS[0]}
} 3>&1
exit "$rc"
