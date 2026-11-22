#!/usr/bin/env bash
# HOSTINGERLOCKDOWN1122: machine-level lock-down of a Docker host that runs Marveen (Ubuntu/Debian, run on the HOST,
# not in the container). Run as root. Idempotent: a second run changes nothing and says so.
#
#   1. Key guard: unless root or a sudo user can really sign in with a key (sshd -T -C), it stops before changing
#      anything: turning off password SSH would lock out a customer who signs in with a password. The usable keys are
#      listed (fingerprint and comment) and need an explicit yes (or --yes): a provider's key is not the customer's.
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
# Exit: 0 done (or nothing to do), 1 a step failed (said which), 2 the key guard stopped it or the keys were not
# confirmed (nothing changed). --yes confirms the listed keys without a prompt.
# HH_ROOT is a path prefix for the tests (scripts/__tests__/host-hardening.test.sh); empty on a real host.
set -euo pipefail
# No pathname expansion anywhere (Samu, #3031): sshd patterns such as "DenyUsers *" go through unquoted expansions and
# would turn into the names of the files in the current directory.
set -f

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
# Who can really sign in with a key, as sshd itself sees it (sshd -T -C per user, Dani's B1): pubkey auth on, root
# login allowed for root, not shut out by Allow/Deny Users/Groups, and a key line in the EFFECTIVE AuthorizedKeysFile.
# A key on the machine is not proof that whoever runs this holds it (a provider or image key, B2): the keys are listed
# and an explicit "yes" (or --yes) is needed.
YES=0
for a in "$@"; do [ "$a" = --yes ] && YES=1; done
key_users() {
  printf 'root\n'
  awk -F: '$1=="sudo"||$1=="admin"||$1=="wheel" { n=split($4,u,","); for (i=1;i<=n;i++) if (u[i]!="") print u[i] }' "$R/etc/group" 2>/dev/null || true
  [ -n "${SUDO_USER:-}" ] && printf '%s\n' "$SUDO_USER"
  return 0
}
home_of() { awk -F: -v u="$1" '$1==u { print $6; exit }' "$R/etc/passwd" 2>/dev/null; }
groups_of() {
  local gid
  gid="$(awk -F: -v u="$1" '$1==u { print $4; exit }' "$R/etc/passwd" 2>/dev/null)"
  awk -F: -v u="$1" -v g="$gid" '$3==g { print $1 } { n=split($4,m,","); for (i=1;i<=n;i++) if (m[i]==u) print $1 }' "$R/etc/group" 2>/dev/null
}
# The effective sshd settings for a login as $1, one "key value..." per line.
eff() { sshd -T -C "user=$1,host=localhost,addr=127.0.0.1" 2>/dev/null; }
vals() { awk -v k="$1" '$1==k { for (i=2;i<=NF;i++) print $i }'; }
matches_any() { # $1 a name, then patterns (user@host: the user part)
  local n="$1" p; shift
  for p in "$@"; do p="${p%%@*}"; [[ "$n" == $p ]] && return 0; done
  return 1
}
key_lines() { grep -v '^[[:space:]]*#' "$1" 2>/dev/null | grep -E '(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9-]+@openssh\.com)[[:space:]]+AAAA'; }
# Keys listed but never counted: an expiry-time key is not a lasting way in (Samu 83011; the Hostinger Web Terminal
# injects one, measured on the QA VPS), and a command="..." key gives no shell (Dani 83014). A from="..." key counts,
# its limit is shown.
not_counted() { # prints why a key line does not count, nothing when it does
  if grep -qiE '(^|,)[[:space:]]*expiry-time=' <<<"$1"; then printf 'expires, not counted'
  elif grep -qiE '(^|,)[[:space:]]*command=' <<<"$1"; then printf 'forced command, not counted'
  fi
}
durable_key_lines() { key_lines "$1" | grep -viE '(^|,)[[:space:]]*(expiry-time|command)=' ; }
why=""; kf=""
# Not in a $( ) subshell: it sets $kf (the key file sshd would read for this user) or $why, for the caller.
usable_keyfile() { # $1 user, $2 home
  local u="$1" h="$2" c f p
  why=""; kf=""
  c="$(eff "$u")"
  [ "$(printf '%s\n' "$c" | vals pubkeyauthentication)" = yes ] || { why="pubkeyauthentication is off for $u"; return 1; }
  if [ "$u" = root ]; then
    p="$(printf '%s\n' "$c" | vals permitrootlogin)"
    case "$p" in yes|prohibit-password|without-password) ;; *) why="permitrootlogin is ${p:-unset}"; return 1 ;; esac
  fi
  local allow deny ag dg gs
  allow=($(printf '%s\n' "$c" | vals allowusers)); deny=($(printf '%s\n' "$c" | vals denyusers))
  ag=($(printf '%s\n' "$c" | vals allowgroups)); dg=($(printf '%s\n' "$c" | vals denygroups))
  # A negated pattern (!name) is not evaluated here: refuse the candidate rather than guess.
  case " ${allow[*]:-} ${deny[*]:-} ${ag[*]:-} ${dg[*]:-} " in *" !"*) why="an Allow/Deny Users/Groups line has a negated (!) pattern, which this check does not evaluate"; return 1 ;; esac
  if [ "${#allow[@]}" -gt 0 ] && ! matches_any "$u" "${allow[@]}"; then why="$u is not in AllowUsers"; return 1; fi
  if [ "${#deny[@]}" -gt 0 ] && matches_any "$u" "${deny[@]}"; then why="$u is in DenyUsers"; return 1; fi
  gs="$(groups_of "$u")"
  if [ "${#ag[@]}" -gt 0 ]; then
    local ok=0 g; for g in $gs; do matches_any "$g" "${ag[@]}" && ok=1; done
    [ "$ok" = 1 ] || { why="$u is in no AllowGroups group"; return 1; }
  fi
  if [ "${#dg[@]}" -gt 0 ]; then
    local g; for g in $gs; do matches_any "$g" "${dg[@]}" && { why="$u is in a DenyGroups group"; return 1; }; done
  fi
  local strict; strict="$(printf '%s\n' "$c" | vals strictmodes)"
  for f in $(printf '%s\n' "$c" | vals authorizedkeysfile); do
    f="${f//%h/$h}"; f="${f//%u/$u}"; f="${f//%%/%}"
    case "$f" in /*) ;; *) f="$h/$f" ;; esac
    if ! durable_key_lines "$R$f" >/dev/null; then
      key_lines "$R$f" >/dev/null && why="only keys that do not count in $f (expiry-time, e.g. a provider's web terminal, or command=, no shell)"
      continue
    fi
    # Dani B3: with StrictModes (the default) sshd ignores a key file when it, or a directory above it up to the home,
    # is group/world-writable or owned by someone else than the user or root.
    if [ "$strict" != no ] && ! strict_ok "$u" "$f" "$h"; then return 1; fi
    kf="$f"; return 0
  done
  [ -n "$why" ] || why="no key line in $u's authorized keys file"
  return 1
}
# owner and octal mode of a path (GNU stat, then BSD stat for the macOS test run)
owner_mode() { stat -c '%U %a' "$1" 2>/dev/null || stat -f '%Su %Lp' "$1" 2>/dev/null; }
strict_ok() { # $1 user, $2 key file, $3 home; sets $why on failure
  local u="$1" p="$2" h="$3" om o m
  while :; do
    om="$(owner_mode "$R$p")" || { why="cannot stat $p"; return 1; }
    o="${om% *}"; m="${om#* }"
    # HH_ROOT (tests only): the files belong to whoever runs the test.
    if [ "$o" != "$u" ] && [ "$o" != root ] && { [ -z "$R" ] || [ "$o" != "$(id -un)" ]; }; then
      why="$p is owned by $o (sshd StrictModes ignores the key)"; return 1
    fi
    if [ $(( 8#$m & 8#022 )) -ne 0 ]; then why="$p is group/world-writable ($m; sshd StrictModes ignores the key)"; return 1; fi
    # up to the home (a file inside it) or to / (a file outside it)
    if [ "$p" = "$h" ] || [ "$p" = / ]; then break; fi
    p="$(dirname "$p")"
  done
  return 0
}
owners=(); listing=""; reasons=""
while read -r u; do
  [ -n "$u" ] || continue
  h="$(home_of "$u")"
  [ -n "$h" ] || continue
  if usable_keyfile "$u" "$h"; then
    owners+=("$u")
    listing+="  $u ($kf):"$'\n'
    while IFS= read -r line; do
      fp="$(printf '%s\n' "$line" | ssh-keygen -lf - 2>/dev/null)"
      nc="$(not_counted "$line")"
      if [ -n "$nc" ]; then fp="$fp ($nc)"
      elif from="$(grep -oiE '(^|,)[[:space:]]*from="[^"]*"' <<<"$line")"; then fp="$fp (only ${from#*,})"
      fi
      listing+="    $fp"$'\n'
    done < <(key_lines "$R$kf")
  else
    reasons+="  $u: $why"$'\n'
  fi
done < <(key_users | sort -u)
if [ "${#owners[@]}" -eq 0 ]; then
  printf '\n  STOPPED: nobody can sign in with an SSH key (root or a sudo user, as sshd sees it):\n%s' "$reasons" >&2
  cat >&2 <<'EOF'
  Turning off password SSH now would lock you out. Nothing was changed.
  Add your public key first (on your computer: ssh-copy-id root@<server>), then run this again.

EOF
  exit 2
fi
printf 'These keys can sign in after password SSH is off:\n%s' "$listing"
if [ "$YES" != 1 ]; then
  if [ -t 0 ]; then
    printf 'Is one of them yours (you hold its private key)? Type yes to continue: '
    read -r ans
    [ "$ans" = yes ] || { printf 'host-hardening: not confirmed; nothing was changed.\n' >&2; exit 2; }
  else
    printf 'host-hardening: check the keys above, then run again with --yes. Nothing was changed.\n' >&2
    exit 2
  fi
fi
already+=("SSH key login possible (${owners[*]})")

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
# The restart returns before the server answers (measured on the QA VPS: "Server ready" one second later), so the jail
# is asked again for a while instead of once. HH_F2B_WAIT is for the tests only.
jail_up=0
for _ in $(seq 1 "${HH_F2B_WAIT:-20}"); do
  if fail2ban-client status sshd >/dev/null 2>&1; then jail_up=1; break; fi
  sleep 1
done
[ "$jail_up" = 1 ] || fail "fail2ban runs, but its sshd jail does not (fail2ban-client status sshd)"

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
  # Checked per login (-C), so a Match block that opens passwords again is seen too (Dani's B1).
  pw_open=""
  while read -r u; do
    [ -n "$u" ] || continue
    c="$(sshd -T -C "user=$u,host=outside,addr=198.51.100.7" 2>/dev/null)"
    for k in passwordauthentication kbdinteractiveauthentication; do
      v="$(printf '%s\n' "$c" | vals "$k")"
      [ "$v" = no ] || pw_open+=" $u:$k=${v:-unset}"
    done
  done < <(key_users | sort -u)
  if [ -n "$pw_open" ]; then
    restore
    fail "password login stays open for:$pw_open (an earlier sshd_config.d file or a Match block); the drop-in was taken back. See: sshd -T -C user=root,host=x,addr=198.51.100.7"
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
