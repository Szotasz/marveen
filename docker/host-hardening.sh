#!/usr/bin/env bash
# HOSTINGERLOCKDOWN1122: machine-level lock-down of a Docker host that runs Marveen (Ubuntu/Debian, run on the HOST,
# not in the container). Run as root. Idempotent: a second run changes nothing and says so.
#
#   1. Key guard: if neither root nor any sudo user has a key in authorized_keys, it stops before changing anything:
#      turning off password SSH would lock out a customer who signs in with a password.
#   2. Firewall (ufw): incoming only the SSH port(s) sshd listens on, 80 and 443. Docker-published ports bypass ufw, so
#      the DOCKER-USER chain (kept in /etc/ufw/after.rules, so it survives a reboot) drops everything that comes in on
#      the external interface to a container except 80/443 and replies.
#   3. fail2ban on sshd.
#   4. Password SSH off (PasswordAuthentication no, KbdInteractiveAuthentication no) in a drop-in read before
#      cloud-init's 50-cloud-init.conf (sshd takes the first value it reads), checked with sshd -t and sshd -T, then a
#      reload. If the effective value is not "no" (an earlier file wins), the drop-in is taken back and it stops.
#
# One line, pinned to a release (docs/docker.md, "Lock down the server"):
#   curl -fsSLo host-hardening.sh https://raw.githubusercontent.com/Szotasz/marveen/v<version>/docker/host-hardening.sh && sudo bash host-hardening.sh
#
# Exit: 0 done (or nothing to do), 1 a step failed (said which), 2 the key guard stopped it (nothing changed).
# HH_ROOT is a path prefix for the tests (scripts/__tests__/host-hardening.test.sh); empty on a real host.
set -euo pipefail

R="${HH_ROOT:-}"
SSHD_DROPIN="$R/etc/ssh/sshd_config.d/00-marveen-hardening.conf"
JAIL="$R/etc/fail2ban/jail.d/marveen-sshd.local"
AFTER_RULES="$R/etc/ufw/after.rules"
BEGIN_MARK='# BEGIN MARVEEN HOST-HARDENING (docker/host-hardening.sh)'
END_MARK='# END MARVEEN HOST-HARDENING'

changed=()
already=()
say() { printf '%s\n' "$*"; }
fail() { printf 'host-hardening: %s\n' "$*" >&2; exit 1; }

if [ -z "$R" ] && [ "$(id -u)" != 0 ]; then
  fail "run it as root (sudo bash host-hardening.sh)"
fi

# --- 1. key guard -----------------------------------------------------------------------------------------------
# root, every member of the sudo/admin/wheel groups, and the user who ran sudo.
key_users() {
  printf 'root\n'
  awk -F: '$1=="sudo"||$1=="admin"||$1=="wheel" { n=split($4,u,","); for (i=1;i<=n;i++) if (u[i]!="") print u[i] }' "$R/etc/group" 2>/dev/null || true
  [ -n "${SUDO_USER:-}" ] && printf '%s\n' "$SUDO_USER"
  return 0
}
home_of() { awk -F: -v u="$1" '$1==u { print $6; exit }' "$R/etc/passwd" 2>/dev/null; }
has_key() {
  local f
  for f in "$1/.ssh/authorized_keys" "$1/.ssh/authorized_keys2"; do
    # A key line (options allowed before it), not a comment.
    [ -f "$R$f" ] && grep -v '^[[:space:]]*#' "$R$f" \
      | grep -Eq '(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9-]+@openssh\.com)[[:space:]]+AAAA' && return 0
  done
  return 1
}
key_owner=""
while read -r u; do
  [ -n "$u" ] || continue
  h="$(home_of "$u")"
  [ -n "$h" ] || continue
  if has_key "$h"; then key_owner="$u"; break; fi
done < <(key_users | sort -u)
if [ -z "$key_owner" ]; then
  cat >&2 <<'EOF'

  STOPPED: no SSH key found for root or any sudo user (authorized_keys is empty or missing).
  Turning off password SSH now would lock you out. Nothing was changed.
  Add your public key first (on your computer: ssh-copy-id root@<server>), then run this again.

EOF
  exit 2
fi
already+=("SSH key present ($key_owner)")

# --- 2. firewall ------------------------------------------------------------------------------------------------
apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >/dev/null || fail "apt-get install $* failed"
}
command -v ufw >/dev/null 2>&1 || { apt-get update -q >/dev/null || fail "apt-get update failed"; apt_install ufw; changed+=("ufw installed"); }

ssh_ports="$(sshd -T 2>/dev/null | awk '$1=="port" { print $2 }' | sort -un)"
[ -n "$ssh_ports" ] || ssh_ports=22
# `ufw show added` lists the rules and /etc/default/ufw the policy whether or not ufw is active yet.
added="$(ufw show added 2>/dev/null || true)"
status="$(ufw status 2>/dev/null || true)"
for p in $ssh_ports 80 443; do
  if printf '%s\n' "$added" | grep -qx "ufw allow $p/tcp"; then
    already+=("ufw allows $p/tcp")
  else
    ufw allow "$p/tcp" >/dev/null || fail "ufw allow $p/tcp failed"
    changed+=("ufw allows $p/tcp")
  fi
done
if grep -Eq '^DEFAULT_INPUT_POLICY="?(DROP|REJECT)"?' "$R/etc/default/ufw" 2>/dev/null; then
  already+=("ufw denies other incoming")
else
  ufw default deny incoming >/dev/null || fail "ufw default deny incoming failed"
  changed+=("ufw denies other incoming")
fi

iface="$(ip route show default 2>/dev/null | awk '{ for (i=1;i<NF;i++) if ($i=="dev") { print $(i+1); exit } }')"
[ -n "$iface" ] || fail "the external interface (default route) was not found; the Docker port rule was not written"
block="$(cat <<EOF
$BEGIN_MARK
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -i $iface -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -i $iface -p tcp -m conntrack --ctorigdstport 80 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i $iface -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN
-A DOCKER-USER -i $iface -j DROP
-A DOCKER-USER -j RETURN
COMMIT
$END_MARK
EOF
)"
[ -f "$AFTER_RULES" ] || fail "$AFTER_RULES is missing (is ufw installed?)"
current="$(awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{on=1} on{print} $0==e{on=0}' "$AFTER_RULES")"
rules_changed=0
if [ "$current" = "$block" ]; then
  already+=("Docker ports: only 80/443 from outside ($iface)")
else
  tmp="$(mktemp "$AFTER_RULES.XXXXXX")"
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$AFTER_RULES" > "$tmp"
  printf '%s\n' "$block" >> "$tmp"
  chmod --reference="$AFTER_RULES" "$tmp" 2>/dev/null || chmod 640 "$tmp"
  mv "$tmp" "$AFTER_RULES"
  rules_changed=1
  changed+=("Docker ports: only 80/443 from outside ($iface)")
fi

if printf '%s\n' "$status" | grep -q '^Status: active'; then
  if [ "$rules_changed" = 1 ]; then ufw reload >/dev/null || fail "ufw reload failed"; fi
  already+=("ufw active")
else
  ufw --force enable >/dev/null || fail "ufw enable failed"
  changed+=("ufw enabled")
fi

# --- 3. fail2ban ------------------------------------------------------------------------------------------------
backend=auto
[ -f "$R/var/log/auth.log" ] || backend=systemd
if ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get update -q >/dev/null || fail "apt-get update failed"
  if [ "$backend" = systemd ]; then apt_install fail2ban python3-systemd; else apt_install fail2ban; fi
  changed+=("fail2ban installed")
fi
jail_text="[sshd]
enabled = true
port = $(printf '%s' "$ssh_ports" | tr '\n' ',')
backend = $backend
maxretry = 5
findtime = 10m
bantime = 1h"
if [ -f "$JAIL" ] && [ "$(cat "$JAIL")" = "$jail_text" ]; then
  already+=("fail2ban guards sshd")
else
  mkdir -p "$(dirname "$JAIL")"
  printf '%s\n' "$jail_text" > "$JAIL"
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban || fail "fail2ban did not restart"
  changed+=("fail2ban guards sshd")
fi
fail2ban-client status sshd >/dev/null 2>&1 || fail "fail2ban runs, but its sshd jail does not (fail2ban-client status sshd)"

# --- 4. password SSH off ----------------------------------------------------------------------------------------
dropin_text="# docker/host-hardening.sh (HOSTINGERLOCKDOWN1122): keys only. Read before 50-cloud-init.conf.
PasswordAuthentication no
KbdInteractiveAuthentication no"
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' "$R/etc/ssh/sshd_config" \
  || fail "/etc/ssh/sshd_config does not include sshd_config.d; password SSH was NOT turned off"
if [ -f "$SSHD_DROPIN" ] && [ "$(cat "$SSHD_DROPIN")" = "$dropin_text" ]; then
  already+=("password SSH off")
else
  backup=""
  [ -f "$SSHD_DROPIN" ] && backup="$(cat "$SSHD_DROPIN")"
  restore() { if [ -n "$backup" ]; then printf '%s\n' "$backup" > "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi; }
  mkdir -p "$(dirname "$SSHD_DROPIN")"
  printf '%s\n' "$dropin_text" > "$SSHD_DROPIN"
  if ! sshd -t; then restore; fail "sshd -t rejected the config; the drop-in was taken back, password SSH is unchanged"; fi
  eff="$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication" { print $2 }')"
  if [ "$eff" != no ]; then
    restore
    fail "an earlier sshd_config.d file still sets PasswordAuthentication ($eff); the drop-in was taken back. See: grep -ri passwordauthentication /etc/ssh/sshd_config.d/"
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd || fail "sshd reload failed (the new config is valid; reload it by hand)"
  changed+=("password SSH off")
fi

# --- summary ----------------------------------------------------------------------------------------------------
say ""
if [ "${#changed[@]}" -eq 0 ]; then
  say "host-hardening: nothing to change, everything was already in place:"
else
  say "host-hardening: changed:"
  for c in "${changed[@]}"; do say "  + $c"; done
  say "already in place:"
fi
for a in "${already[@]}"; do say "  = $a"; done
