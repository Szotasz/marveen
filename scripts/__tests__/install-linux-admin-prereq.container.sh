#!/bin/bash
# LINUXINSTPREREQ1104 PR2, the admin + non-admin pair in a real Ubuntu 24.04 container (real apt, real
# nodesource, the real install-linux.sh). NOT in CI: it needs docker and the network.
#   bash scripts/__tests__/install-linux-admin-prereq.container.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG=ubuntu:24.04
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail_t() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail_t "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail_t "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail_t "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

C=$(docker run -d --rm -e TERM=xterm -e MARVEEN_LANG=hu -v "$REPO:/src:ro" "$IMG" sleep 3600) || exit 2
trap 'docker rm -f "$C" >/dev/null 2>&1' EXIT
x() { docker exec -i "$C" bash -c "$1"; }
# A VPS-like base: sudo exists (cloud images ship it), an admin with a password, a plain user.
x 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sudo ca-certificates >/dev/null' || exit 2
x 'useradd -m -s /bin/bash -G sudo boss && echo boss:Boss-pass-123 | chpasswd && useradd -m -s /bin/bash plain'
# /opt/m: the checkout shape (the gate and its writer next to the installer).
x 'mkdir -p /opt/m/scripts/lib && cp /src/install-linux.sh /src/install-lang.sh /opt/m/ && cp /src/scripts/ensure-managed-channels-enabled.sh /opt/m/scripts/ && cp /src/scripts/lib/managed-settings-write.py /opt/m/scripts/lib/ && chmod -R a+rX /opt/m'

echo "A. plain user, nothing installed -> stops before the package step"
OUT=$(x 'cd /home/plain && su plain -c "bash /opt/m/install-linux.sh" </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 1" "$OUT" "rc=1"
assert_contains "the list" "$OUT" "csomagok:"
assert_contains "the admin command fetches the official script" "$OUT" 'raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh'
assert_contains "the admin command names this user" "$OUT" '--admin-prereq --user plain'
assert_not_contains "the admin command never points at the checkout" "$OUT" 'bash "/opt/m'
assert_eq "no package was installed" "no-ffmpeg" "$(x 'command -v ffmpeg >/dev/null && echo has-ffmpeg || echo no-ffmpeg')"

echo "B. the sudo-group admin, no passwordless sudo, no TTY -> the old path (no pre-check text)"
OUT=$(x 'cd /home/boss && su boss -c "timeout 60 bash /opt/m/install-linux.sh" </dev/null 2>&1; echo "rc=$?"')
assert_not_contains "no pre-check text" "$OUT" "--admin-prereq"
assert_contains "went on to the package step" "$OUT" "Telepites sudo-val"

echo "C. --admin-prereq as a non-root user -> stops at once"
OUT=$(x 'su plain -c "bash /opt/m/install-linux.sh --admin-prereq" </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 1" "$OUT" "rc=1"
assert_not_contains "no step ran" "$OUT" "[1/7]"

echo "D. root: --admin-prereq installs only the machine-level prerequisites"
OUT=$(x 'cd /root && bash /opt/m/install-linux.sh --admin-prereq --user plain </dev/null 2>&1; echo "rc=$?"')
echo "$OUT" | grep -E "telepítve|megvolt|node v|csatorna-kapu|channelsEnabled|managed|rc=" | sed 's/^/    /'
assert_contains "rc 0" "$OUT" "rc=0"
assert_contains "names the next step (the non-admin user re-runs its own installer)" "$OUT" 'ugyanúgy, ahogy elindította'
assert_contains "no systemd here: linger not needed, said so" "$OUT" "loginctl"
OUT2=$(x 'bash /opt/m/install-linux.sh --admin-prereq --user nosuchuser </dev/null 2>&1; echo "rc=$?"')
assert_contains "an unknown --user stops" "$OUT2" "rc=1"
NODE=$(x 'node -e "process.stdout.write(process.version.slice(1).split(\".\")[0])"')
[ "${NODE:-0}" -ge 20 ] && pass "node >= 20 ($NODE)" || fail_t "node >= 20 (got $NODE)"
assert_eq "the channel gate is on" "on" "$(x 'python3 -c "import json;print(\"on\" if json.load(open(\"/etc/claude-code/managed-settings.json\")).get(\"channelsEnabled\") is True else \"off\")"')"
assert_eq "no clone (no user-level step)" "none" "$(x 'ls -d /root/marveen /home/*/marveen 2>/dev/null || echo none')"
assert_eq "no systemd user unit written" "none" "$(x 'ls /root/.config/systemd/user 2>/dev/null | head -1 || true; [ -d /root/.config/systemd/user ] || echo none')"

echo "E. --admin-prereq again (idempotent)"
OUT=$(x 'cd /root && bash /opt/m/install-linux.sh --admin-prereq </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 0" "$OUT" "rc=0"
assert_contains "nothing left to install" "$OUT" "minden csomag megvolt már"

echo "F. the plain user again -> the pre-check lets it through, it goes past [1/7]"
OUT=$(x 'cd /home/plain && su plain -c "timeout 120 bash /opt/m/install-linux.sh" </dev/null 2>&1; echo "rc=$?"')
assert_not_contains "no pre-check stop" "$OUT" "nem tud rendszergazdai"
assert_contains "past the package step (the repo bootstrap)" "$OUT" "A telepito a repon kivulrol fut"

echo "G. standalone (no checkout next to it): the gate and its writer are fetched from MARVEEN_REF"
x 'rm -rf /etc/claude-code && mkdir -p /opt/s && cp /src/install-linux.sh /src/install-lang.sh /opt/s/'
OUT=$(x 'cd /root && MARVEEN_REF=develop bash /opt/s/install-linux.sh --admin-prereq </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 0" "$OUT" "rc=0"
assert_eq "the gate is on again" "on" "$(x 'python3 -c "import json;print(\"on\" if json.load(open(\"/etc/claude-code/managed-settings.json\")).get(\"channelsEnabled\") is True else \"off\")"')"

echo "H1. a CHANGED gate in the (root-owned) checkout never runs: the admin run fetches the official one"
x 'echo "touch /tmp/PWNED-gate" >> /opt/m/scripts/ensure-managed-channels-enabled.sh; rm -f /tmp/PWNED-gate'
OUT=$(x 'cd /root && bash /opt/m/install-linux.sh --admin-prereq --user plain </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 0" "$OUT" "rc=0"
assert_eq "the checkout gate did not run" "absent" "$(x 'ls /tmp/PWNED-gate 2>/dev/null || echo absent')"

echo "H2. root on a USER-owned checkout: refused before anything runs"
x 'cp -r /opt/m /home/plain/m && chown -R plain: /home/plain/m && printf "echo PWNED-lang\n" >> /home/plain/m/install-lang.sh'
OUT=$(x 'cd /root && bash /home/plain/m/install-linux.sh --admin-prereq --user plain </dev/null 2>&1; echo "rc=$?"')
assert_contains "rc 1" "$OUT" "rc=1"
assert_contains "names the official command" "$OUT" "raw.githubusercontent.com/Szotasz/marveen/"
assert_not_contains "the user's install-lang.sh was not sourced" "$OUT" "PWNED-lang"
assert_not_contains "no step ran" "$OUT" "[1/7]"

if [ -n "${ADMIN_TEST_REF:-}" ]; then
  echo "I. the printed command, run verbatim by root (MARVEEN_REF=$ADMIN_TEST_REF, pushed)"
  x 'rm -rf /etc/claude-code'
  OUT=$(x "cd /home/plain && su plain -c 'MARVEEN_REF=$ADMIN_TEST_REF bash /opt/m/install-linux.sh --admin-prereq' </dev/null 2>&1")
  CMD=$(printf '%s\n' "$OUT" | grep -o "sudo bash -c '.*'" | head -1)
  assert_contains "the printed command is the official one-liner" "$CMD" "raw.githubusercontent.com/Szotasz/marveen/$ADMIN_TEST_REF/install-linux.sh"
  OUT=$(x "cd /root && ${CMD#sudo } </dev/null 2>&1; echo rc=\$?")
  assert_contains "root ran it: rc 0" "$OUT" "rc=0"
  assert_eq "the gate is on" "on" "$(x 'python3 -c "import json;print(\"on\" if json.load(open(\"/etc/claude-code/managed-settings.json\")).get(\"channelsEnabled\") is True else \"off\")"')"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
