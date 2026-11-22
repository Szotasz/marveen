#!/usr/bin/env bash
# HOSTINGERLOCKDOWN1122: docker/host-hardening.sh on a throwaway root (HH_ROOT) with stub commands (sshd, ufw, ip,
# systemctl, apt-get, fail2ban-client). Pins the key guard, the idempotence of a second run, the sshd checks that take
# the drop-in back, and the SSH port that ufw must keep open. The real ufw/iptables/sshd behaviour is measured on the
# test VPS (the card's measurement order); this test never touches the machine it runs on.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../../docker/host-hardening.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0; failn=0
ok() { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad() { failn=$((failn+1)); printf 'FAIL %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi }

BIN="$T/bin"; mkdir -p "$BIN"
cat > "$BIN/sshd" <<'EOF'
#!/usr/bin/env bash
# -t: STUB rc; -T [-C user=..]: the effective config computed from the drop-ins, plus knobs a test sets:
# STUB_PUBKEY, STUB_PERMITROOT, STUB_AKF, STUB_ALLOWUSERS, STUB_MATCH_PW_USER (password stays yes for that -C user).
echo "sshd $*" >> "$HH_ROOT/../calls.log"
first() { # first value of $1 across the drop-ins (sorted), then the main file
  local v="" f
  for f in $(ls "$HH_ROOT/etc/ssh/sshd_config.d/"*.conf 2>/dev/null | sort) "$HH_ROOT/etc/ssh/sshd_config"; do
    [ -n "$v" ] && break
    v="$(awk -v k="$1" 'tolower($1)==k { print tolower($2); exit }' "$f")"
  done
  printf '%s' "$v"
}
case "$1" in
  -t) exit "${SSHD_T_RC:-0}" ;;
  -T)
    cu=""; [ "${2:-}" = -C ] && cu="$(printf '%s' "$3" | sed -n 's/.*user=\([^,]*\).*/\1/p')"
    ports="$(awk '$1=="Port" { print $2 }' "$HH_ROOT/etc/ssh/sshd_config")"; [ -n "$ports" ] || ports=22
    for p in $ports; do echo "port $p"; done
    pw="$(first passwordauthentication)"; [ -n "$cu" ] && [ "$cu" = "${STUB_MATCH_PW_USER:-}" ] && pw=yes
    echo "passwordauthentication ${pw:-yes}"
    kb="$(first kbdinteractiveauthentication)"; echo "kbdinteractiveauthentication ${kb:-yes}"
    echo "pubkeyauthentication ${STUB_PUBKEY:-yes}"
    echo "permitrootlogin ${STUB_PERMITROOT:-without-password}"
    echo "authorizedkeysfile ${STUB_AKF:-.ssh/authorized_keys .ssh/authorized_keys2}"
    echo "strictmodes ${STUB_STRICT:-yes}"
    set -f
    for u in ${STUB_ALLOWUSERS:-}; do echo "allowusers $u"; done
    for u in ${STUB_DENYUSERS:-}; do echo "denyusers $u"; done ;;
esac
EOF
cat > "$BIN/ufw" <<'EOF'
#!/usr/bin/env bash
S="$HH_ROOT/ufwstate"; mkdir -p "$S"; touch "$S/rules"
echo "ufw $*" >> "$HH_ROOT/../calls.log"
case "$*" in
  "show added") echo "Added user rules (see 'ufw status' for running firewall):"; cat "$S/rules" ;;
  status) if [ -f "$S/active" ]; then echo "Status: active"; else echo "Status: inactive"; fi ;;
  "allow "*) grep -qx "ufw allow $2" "$S/rules" || echo "ufw allow $2" >> "$S/rules" ;;
  "default deny incoming") sed -i.bak 's/^DEFAULT_INPUT_POLICY=.*/DEFAULT_INPUT_POLICY="DROP"/' "$HH_ROOT/etc/default/ufw" ;;
  "--force enable") touch "$S/active" ;;
  reload) : ;;
esac
EOF
printf '#!/usr/bin/env bash\necho "default via 203.0.113.1 dev eth0 proto static"\n' > "$BIN/ip"
# fail2ban-client: "status sshd" fails for the first STUB_F2B_FAILS calls (the server is still starting), then answers.
cat > "$BIN/fail2ban-client" <<'EOF'
#!/usr/bin/env bash
echo "fail2ban-client $*" >> "$HH_ROOT/../calls.log"
n="$(cat "$HH_ROOT/../f2b-calls" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$HH_ROOT/../f2b-calls"
[ "$n" -gt "${STUB_F2B_FAILS:-0}" ]
EOF
for c in systemctl apt-get; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "$HH_ROOT/../calls.log"\n' "$c" > "$BIN/$c"
done
chmod +x "$BIN"/*

# A real key: the script lists fingerprints (ssh-keygen -lf), which needs a valid key line.
ssh-keygen -q -t ed25519 -N '' -C test@example -f "$T/k" >/dev/null
ED_KEY="$(cat "$T/k.pub")"
# A second key, injected the way the Hostinger Web Terminal does it: with an expiry-time option (Samu 83011).
ssh-keygen -q -t ed25519 -N '' -C webterminal@provider -f "$T/k2" >/dev/null
EXP_KEY="expiry-time=\"20991231000000Z\" $(cat "$T/k2.pub")"

fresh() {
  rm -rf "$T/case"; mkdir -p "$T/case/root"; : > "$T/case/calls.log"; rm -f "$T/case/f2b-calls"
  local r="$T/case/root"
  mkdir -p "$r/etc/ssh/sshd_config.d" "$r/etc/ufw" "$r/etc/default" "$r/root/.ssh" "$r/home/alice/.ssh" "$r/var/log"
  printf 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\n' > "$r/etc/passwd"
  printf 'root:x:0:\nsudo:x:27:alice\nalice:x:1000:\n' > "$r/etc/group"
  printf 'Include /etc/ssh/sshd_config.d/*.conf\nKbdInteractiveAuthentication no\n' > "$r/etc/ssh/sshd_config"
  printf 'PasswordAuthentication yes\n' > "$r/etc/ssh/sshd_config.d/50-cloud-init.conf"
  printf '# ufw after.rules\n*filter\n:ufw-after-input - [0:0]\nCOMMIT\n' > "$r/etc/ufw/after.rules"
  printf 'IPV6=yes\nDEFAULT_INPUT_POLICY="ACCEPT"\n' > "$r/etc/default/ufw"
  : > "$r/var/log/auth.log"
}
# --yes by default (the keys are the test's own); stdin is never a terminal here.
run() { HH_ROOT="$T/case/root" PATH="$BIN:$PATH" bash "$SCRIPT" "${@:---yes}" < /dev/null > "$T/case/out" 2>&1; echo $? > "$T/case/rc"; }
R="$T/case/root"
DROPIN="$R/etc/ssh/sshd_config.d/00-marveen-hardening.conf"
JAIL="$R/etc/fail2ban/jail.d/marveen-sshd.local"
rc() { cat "$T/case/rc"; }
calls() { grep -c "$1" "$T/case/calls.log" || true; }

# 1. no key anywhere: stop with 2, nothing changed, nothing called but the read-only probes.
fresh; run
check "no key: exit 2" '[ "$(rc)" = 2 ]'
check "no key: says STOPPED" 'grep -q "STOPPED: nobody can sign in with an SSH key" "$T/case/out"'
check "no key: no drop-in, no jail, after.rules untouched" '[ ! -e "$DROPIN" ] && [ ! -e "$JAIL" ] && ! grep -q MARVEEN "$R/etc/ufw/after.rules"'
check "no key: no ufw/apt/systemctl call" '[ "$(calls "^ufw\|^apt-get\|^systemctl")" = 0 ]'

# A commented-out key does not count.
fresh; printf '# %s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; run
check "commented key only: exit 2" '[ "$(rc)" = 2 ]'

# 2. root has a key: everything is set up.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; run
check "root key: exit 0" '[ "$(rc)" = 0 ]'
check "drop-in: password and keyboard-interactive off" 'grep -qx "PasswordAuthentication no" "$DROPIN" && grep -qx "KbdInteractiveAuthentication no" "$DROPIN"'
check "the drop-in wins over 50-cloud-init.conf (sshd -T)" '[ "$(HH_ROOT=$R PATH=$BIN:$PATH sshd -T | awk "\$1==\"passwordauthentication\"{print \$2}")" = no ]'
check "ufw: 22, 80, 443 allowed, default deny, enabled" 'grep -qx "ufw allow 22/tcp" "$R/ufwstate/rules" && grep -qx "ufw allow 80/tcp" "$R/ufwstate/rules" && grep -qx "ufw allow 443/tcp" "$R/ufwstate/rules" && grep -q "DEFAULT_INPUT_POLICY=\"DROP\"" "$R/etc/default/ufw" && [ -f "$R/ufwstate/active" ]'
check "ssh allowed BEFORE ufw is enabled" '[ "$(grep -n "^ufw allow 22/tcp" "$T/case/calls.log" | cut -d: -f1)" -lt "$(grep -n "^ufw --force enable" "$T/case/calls.log" | cut -d: -f1)" ]'
check "after.rules: one DOCKER-USER block on eth0, only 80/443 + replies, then DROP" '[ "$(grep -c "BEGIN MARVEEN HOST-HARDENING" "$R/etc/ufw/after.rules")" = 1 ] && grep -q -- "-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN" "$R/etc/ufw/after.rules" && grep -q -- "-A DOCKER-USER -i eth0 -j DROP" "$R/etc/ufw/after.rules" && grep -q "^:ufw-after-input" "$R/etc/ufw/after.rules"'
check "fail2ban: sshd jail on port 22, auth.log backend" 'grep -qx "port = 22" "$JAIL" && grep -qx "backend = auto" "$JAIL" && grep -qx "enabled = true" "$JAIL"'
check "sshd -t ran, then a reload" '[ "$(calls "^sshd -t")" = 1 ] && [ "$(calls "^systemctl reload ssh")" = 1 ]'
check "summary lists the changes" 'grep -q "+ password SSH off" "$T/case/out" && grep -q "+ ufw enabled" "$T/case/out"'

# 3. second run: no change, no reload, same bytes.
cp "$DROPIN" "$T/d1"; cp "$JAIL" "$T/j1"; cp "$R/etc/ufw/after.rules" "$T/a1"; : > "$T/case/calls.log"; run
check "second run: exit 0" '[ "$(rc)" = 0 ]'
check "second run: says nothing to change" 'grep -q "nothing to change" "$T/case/out" && ! grep -q "^  + " "$T/case/out"'
check "second run: files byte-identical" 'cmp -s "$DROPIN" "$T/d1" && cmp -s "$JAIL" "$T/j1" && cmp -s "$R/etc/ufw/after.rules" "$T/a1"'
check "second run: no ufw write, no reload, no sshd -t, no fail2ban restart" '[ "$(calls "^ufw allow\|^ufw reload\|^ufw --force\|^ufw default\|^sshd -t\|^systemctl")" = 0 ]'

# 4. only a sudo user has a key (options before the key type): passes the guard.
fresh; printf 'no-agent-forwarding,from="10.0.0.0/8" %s\n' "$ED_KEY" > "$R/home/alice/.ssh/authorized_keys"; run
check "sudo user key with options: exit 0" '[ "$(rc)" = 0 ] && grep -q "SSH key login possible (alice)" "$T/case/out"'

# 5. sshd -t rejects: the drop-in is taken back, exit 1.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; SSHD_T_RC=1 run
check "sshd -t fails: exit 1, drop-in gone, no reload" '[ "$(rc)" = 1 ] && [ ! -e "$DROPIN" ] && [ "$(calls "^systemctl reload ssh")" = 0 ]'

# 6. an earlier drop-in keeps password SSH on: taken back, said, exit 1.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; printf 'PasswordAuthentication yes\n' > "$R/etc/ssh/sshd_config.d/00-aaa.conf"; run
check "earlier file wins: exit 1, drop-in gone, named" '[ "$(rc)" = 1 ] && [ ! -e "$DROPIN" ] && grep -q "earlier sshd_config.d file" "$T/case/out"'

# 7. sshd on port 2222: ufw keeps 2222 open, the jail watches it.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; printf 'Port 2222\n' >> "$R/etc/ssh/sshd_config"; run
check "port 2222: allowed in ufw, in the jail, 22 not added" '[ "$(rc)" = 0 ] && grep -qx "ufw allow 2222/tcp" "$R/ufwstate/rules" && ! grep -qx "ufw allow 22/tcp" "$R/ufwstate/rules" && grep -qx "port = 2222" "$JAIL"'

# 8. no /var/log/auth.log (journal-only image): the jail reads the journal.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; rm -f "$R/var/log/auth.log"; run
check "no auth.log: backend = systemd" '[ "$(rc)" = 0 ] && grep -qx "backend = systemd" "$JAIL"'

# 9. Dani B1: sshd itself must let the key owner in.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_PERMITROOT=no run
check "root key but PermitRootLogin no: exit 2, named, nothing changed" '[ "$(rc)" = 2 ] && grep -q "permitrootlogin is no" "$T/case/out" && [ ! -e "$DROPIN" ] && [ "$(calls "^ufw allow")" = 0 ]'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_PUBKEY=no run
check "PubkeyAuthentication no: exit 2" '[ "$(rc)" = 2 ] && grep -q "pubkeyauthentication is off" "$T/case/out"'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_ALLOWUSERS="alice" run
check "AllowUsers shuts root out, alice has no key: exit 2" '[ "$(rc)" = 2 ] && grep -q "root is not in AllowUsers" "$T/case/out"'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_AKF="/etc/ssh/keys/%u" run
check "AuthorizedKeysFile elsewhere, key only in ~/.ssh: exit 2" '[ "$(rc)" = 2 ]'
fresh; mkdir -p "$R/etc/ssh/keys"; printf '%s\n' "$ED_KEY" > "$R/etc/ssh/keys/root"; STUB_AKF="/etc/ssh/keys/%u" run
check "AuthorizedKeysFile elsewhere, key there: exit 0" '[ "$(rc)" = 0 ]'
# A Match block that keeps passwords open for a user: the drop-in is taken back.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_MATCH_PW_USER=root run
check "Match keeps password open for root: exit 1, drop-in gone, named" '[ "$(rc)" = 1 ] && [ ! -e "$DROPIN" ] && grep -q "password login stays open for: root:passwordauthentication=yes" "$T/case/out"'

# Samu (#3031): "DenyUsers *" run from a directory with files must not glob into file names and let root through.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; mkdir -p "$T/globdir"; touch "$T/globdir/alpha" "$T/globdir/beta"
(cd "$T/globdir" && STUB_DENYUSERS='*' run)
check "DenyUsers * from a directory with files: exit 2, root named" '[ "$(rc)" = 2 ] && grep -q "root is in DenyUsers" "$T/case/out" && [ ! -e "$DROPIN" ]'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_ALLOWUSERS='!bob root' run
check "a negated pattern: exit 2, said" '[ "$(rc)" = 2 ] && grep -q "negated (!) pattern" "$T/case/out"'

# QA VPS (Marveen 82995): fail2ban answers a moment after its restart; the jail check waits for it.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_F2B_FAILS=2 HH_F2B_WAIT=5 run
check "fail2ban not ready for 2 calls: waits, exit 0, password off in the same run" '[ "$(rc)" = 0 ] && grep -q "+ password SSH off" "$T/case/out" && [ "$(calls "^fail2ban-client status sshd")" = 3 ]'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; STUB_F2B_FAILS=99 HH_F2B_WAIT=2 run
check "fail2ban jail never up: exit 1 after the wait, said" '[ "$(rc)" = 1 ] && grep -q "its sshd jail does not" "$T/case/out" && [ "$(calls "^fail2ban-client status sshd")" = 2 ]'

# Samu 83011 (A): an expiry-time key (the provider's web terminal) is listed but never counted.
fresh; printf '%s\n' "$EXP_KEY" > "$R/root/.ssh/authorized_keys"; run
check "only an expiring key: exit 2, said, nothing changed" '[ "$(rc)" = 2 ] && grep -q "only keys that do not count" "$T/case/out" && [ ! -e "$DROPIN" ]'
fresh; printf '%s\n%s\n' "$EXP_KEY" "$ED_KEY" > "$R/root/.ssh/authorized_keys"; run
check "expiring + own key: exit 0, both listed, the expiring one marked" '[ "$(rc)" = 0 ] && grep -q "SHA256:.*webterminal@provider.*(expires, not counted)" "$T/case/out" && grep "test@example" "$T/case/out" | grep -vq "not counted"'

# Dani 83014: a forced-command key gives no shell; it is listed, not counted. A from= key counts, its limit shown.
fresh; printf 'command="/usr/bin/true" %s\n' "$(cat "$T/k2.pub")" > "$R/root/.ssh/authorized_keys"; run
check "only a command= key: exit 2, nothing changed" '[ "$(rc)" = 2 ] && grep -q "only keys that do not count" "$T/case/out" && [ ! -e "$DROPIN" ]'
fresh; printf 'command="/usr/bin/true" %s\nfrom="10.0.0.0/8" %s\n' "$(cat "$T/k2.pub")" "$ED_KEY" > "$R/root/.ssh/authorized_keys"; run
check "command= + from= key: exit 0, forced command marked, from limit shown" '[ "$(rc)" = 0 ] && grep -q "webterminal@provider.*(forced command, not counted)" "$T/case/out" && grep -q "test@example.*(only from=\"10.0.0.0/8\")" "$T/case/out"'

# Dani B3: StrictModes ignores a group-writable key file; with StrictModes off it is used.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; chmod 664 "$R/root/.ssh/authorized_keys"; run
check "group-writable authorized_keys under StrictModes: exit 2, named" '[ "$(rc)" = 2 ] && grep -q "authorized_keys is group/world-writable" "$T/case/out" && [ ! -e "$DROPIN" ]'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; chmod 777 "$R/root/.ssh"; run
check "world-writable .ssh under StrictModes: exit 2" '[ "$(rc)" = 2 ] && grep -q "/root/.ssh is group/world-writable" "$T/case/out"'
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; chmod 664 "$R/root/.ssh/authorized_keys"; STUB_STRICT=no run
check "group-writable but StrictModes no: exit 0" '[ "$(rc)" = 0 ]'

# 10. Dani B2: the keys are listed, and without --yes (no terminal) nothing changes.
fresh; printf '%s\n' "$ED_KEY" > "$R/root/.ssh/authorized_keys"; run --no-such-flag
check "no --yes, no terminal: exit 2, nothing changed" '[ "$(rc)" = 2 ] && grep -q "run again with --yes" "$T/case/out" && [ ! -e "$DROPIN" ] && [ "$(calls "^ufw allow\|^systemctl")" = 0 ]'
check "the key is listed with its fingerprint and comment" 'grep -q "SHA256:.*test@example" "$T/case/out"'

printf '\n%d passed, %d failed\n' "$pass" "$failn"
[ "$failn" = 0 ]
