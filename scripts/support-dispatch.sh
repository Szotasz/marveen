#!/bin/sh
# Support access dispatcher: the GATE a support login runs through (SUPPORTKULCS1109, PR1c).
#
# sshd starts this file for every login with a support key, as the bound command
# of the support line:
#   /bin/sh <kit>/support-dispatch.sh --key <name> --fp <fingerprint> --grant <id> --consent <n>
# and the command the client asked for arrives in SSH_ORIGINAL_COMMAND. Nothing
# runs unless EVERY check below passes, in this order, at every start:
#   1. the arguments and this file's own path have their exact shapes;
#   2. the kit manifest is read ONCE, here, and only what was read is used;
#   3. the user's authorized_keys holds EXACTLY ONE line that binds this very
#      command (the --key and --fp values are believed only after that);
#   4. the connection (the nearest sshd ancestor) is younger than 60 minutes;
#   5. the narrow token is there and has its exact shape;
#   6. marveen.io answers the access check with a complete, canonical yes for
#      THIS key (v1 schema, the body matched whole, never parsed);
#   7. the subcommand is on the closed list, with no free argument.
# Anything else: one refusal line, an event in the spool, a non-zero exit.
#
# Fail closed, no eval, no arithmetic on unchecked input, no environment used:
# the support folder comes from this file's own path, the tools from the fixed
# PATH below. Node is never started for a decision, and no other kit file runs.
# Every answer of a 401 is only a refusal (the token_revoked removal belongs to
# the node reconcile, not to this file).
#
# The ONE line a test may replace (with a fake tools folder in front) is the
# PATH line below; nothing else in this file reads a test seam.
LC_ALL=C
export LC_ALL
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
IFS='
 	'
set -f
umask 077

ACCESS_CHECK_URL='https://api.marveen.io/support/v1/access-check'
MAX_CONNECTION_AGE_S=3600
RECHECK_EVERY_S=60
CAP_DEFAULT_S=30
CAP_RESTART_S=300
RESTARTS_PER_CONNECTION=1
RESTARTS_PER_DAY=3
LOG_LINES_MAX=200
BODY_MAX_BYTES=2048
MANIFEST_MAX_BYTES=4096

SELF=$0
NOW_S=$(date +%s)

# --- small helpers -----------------------------------------------------------

refuse() {
  # $1: a reason code from the closed set used in this file
  log_event rejected "$1"
  printf '%s\n' "support access: refused ($1)" >&2
  exit 1
}

# One event per file, only enumerated values; never any client text.
log_event() {
  [ -n "${SPOOL:-}" ] || return 0
  [ -d "$SPOOL" ] || return 0
  _n=0
  while :; do
    _f="$SPOOL/$NOW_S.$$.$_n.evt"
    if ( set -C; printf 'time=%s\nevent=%s\nreason=%s\nkey=%s\ngrant=%s\nclient=%s\n' \
         "$NOW_S" "$1" "${2:-}" "${KEY_OK:-}" "${GRANT_OK:-}" "${CLIENT_IP:-}" > "$_f" ) 2>/dev/null; then
      return 0
    fi
    _n=$((_n + 1))
    [ "$_n" -lt 50 ] || return 0
  done
}

# The age in seconds of an etime value ([[dd-]hh:]mm:ss), or nothing when it has another shape.
etime_seconds() {
  case $1 in
    *[!0-9:-]* | '') return 1 ;;
  esac
  _d=0 _h=0 _rest=$1
  case $_rest in
    *-*) _d=${_rest%%-*}; _rest=${_rest#*-} ;;
  esac
  _old_ifs=$IFS; IFS=:
  set -- $_rest
  IFS=$_old_ifs
  case $# in
    2) _m=$1 _s=$2 ;;
    3) _h=$1 _m=$2 _s=$3 ;;
    *) return 1 ;;
  esac
  for _v in "$_d" "$_h" "$_m" "$_s"; do
    case $_v in '' | *[!0-9]*) return 1 ;; esac
    [ ${#_v} -le 4 ] || return 1
  done
  # strip leading zeros so the shell does not read them as octal
  _d=$(printf '%s' "$_d" | sed 's/^0*//'); _h=$(printf '%s' "$_h" | sed 's/^0*//')
  _m=$(printf '%s' "$_m" | sed 's/^0*//'); _s=$(printf '%s' "$_s" | sed 's/^0*//')
  echo $(( ${_d:-0} * 86400 + ${_h:-0} * 3600 + ${_m:-0} * 60 + ${_s:-0} ))
}

# Mask secrets and personal data in diagnostic output, and strip terminal control bytes.
redact() {
  tr -d '\000-\010\013-\037\177' | sed -E \
    -e 's/(mst|mrv|msc)_[A-Za-z0-9_-]{8,}/[redacted-token]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]+/[redacted-token]/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/[redacted-token]/g' \
    -e 's/xox[abprs]-[A-Za-z0-9-]+/[redacted-token]/g' \
    -e 's/xapp-[A-Za-z0-9-]+/[redacted-token]/g' \
    -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/[redacted-token]/g' \
    -e 's/[0-9]{6,}:[A-Za-z0-9_-]{30,}/[redacted-token]/g' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/[redacted-token]/g' \
    -e 's/([Bb]earer|[Bb]asic) [A-Za-z0-9._~+\/=-]+/\1 [redacted]/g' \
    -e 's/([Aa]uthorization|[Cc]ookie|[Ss]et-[Cc]ookie|[Xx]-[Aa]pi-[Kk]ey)([": =]+)[^ ",]+/\1\2[redacted]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[redacted-email]/g' \
    -e 's/\+[0-9][0-9 ()-]{7,}[0-9]/[redacted-number]/g' \
    -e 's/(^|[^0-9])06[0-9]{8,9}([^0-9]|$)/\1[redacted-number]\2/g' \
    -e 's/[0-9a-fA-F]{32,}/[redacted-hex]/g' \
    -e 's/[A-Za-z0-9+\/_-]{40,}={0,2}/[redacted-b64]/g' | cut -c1-2000
}

# --- 1. arguments and own path -------------------------------------------------

PROBE=0
if [ "$#" -eq 2 ] && [ "$1" = "--probe-fp" ]; then
  PROBE=1
  FP=$2 KEY= GRANT= CONSENT=
elif [ "$#" -eq 8 ] && [ "$1" = "--key" ] && [ "$3" = "--fp" ] && [ "$5" = "--grant" ] && [ "$7" = "--consent" ]; then
  KEY=$2 FP=$4 GRANT=$6 CONSENT=$8
else
  refuse bad_arguments
fi

case $SELF in
  /*/support/kit/support-dispatch.sh) ;;
  *) refuse bad_path ;;
esac
case $SELF in
  *[!A-Za-z0-9._/-]* | *//* | */./* | */../*) refuse bad_path ;;
esac
KIT_DIR=${SELF%/support-dispatch.sh}
SUPPORT_DIR=${KIT_DIR%/kit}
HOME_DIR=${SUPPORT_DIR%/.marveen/support}
case $HOME_DIR in
  /* ) ;;
  *) refuse bad_path ;;
esac
[ "$HOME_DIR/.marveen/support" = "$SUPPORT_DIR" ] || refuse bad_path
SPOOL=$SUPPORT_DIR/spool
RUN_DIR=$SUPPORT_DIR/run
for _d in "$SUPPORT_DIR" "$KIT_DIR"; do
  [ -d "$_d" ] && [ ! -L "$_d" ] || refuse kit_missing
done
[ -f "$SELF" ] && [ ! -L "$SELF" ] || refuse kit_missing
for _d in "$SPOOL" "$RUN_DIR"; do
  [ -L "$_d" ] && refuse bad_path
  [ -d "$_d" ] || mkdir "$_d" 2>/dev/null || refuse bad_path
done

case $FP in
  SHA256:*) ;;
  *) refuse bad_arguments ;;
esac
_fpb=${FP#SHA256:}
[ ${#_fpb} -eq 43 ] || refuse bad_arguments
case $_fpb in *[!A-Za-z0-9+/]*) refuse bad_arguments ;; esac
if [ "$PROBE" -eq 0 ]; then
  case $KEY in '' | *[!a-z0-9]*) refuse bad_arguments ;; esac
  [ ${#KEY} -le 16 ] || refuse bad_arguments
  case $GRANT in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) refuse bad_arguments ;;
  esac
  case $CONSENT in '' | 0* | *[!0-9]*) refuse bad_arguments ;; esac
  [ ${#CONSENT} -le 4 ] || refuse bad_arguments
fi

# --- 2. the manifest, read once -----------------------------------------------

MANIFEST=$KIT_DIR/manifest
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || refuse kit_missing
_size=$(wc -c < "$MANIFEST" | tr -d ' ')
case $_size in '' | *[!0-9]*) refuse kit_missing ;; esac
[ "$_size" -le "$MANIFEST_MAX_BYTES" ] || refuse kit_missing
INSTALL_ROOT= NODE_PATH= RELEASE= _header=0
while IFS= read -r _line; do
  case $_line in
    'marveen-support-kit 1') _header=1 ;;
    'install-root '*) INSTALL_ROOT=${_line#install-root } ;;
    'node '*) NODE_PATH=${_line#node } ;;
    'release '*) RELEASE=${_line#release } ;;
  esac
done < "$MANIFEST"
[ "$_header" -eq 1 ] || refuse kit_missing
case $INSTALL_ROOT in /* ) ;; *) refuse kit_missing ;; esac
case $INSTALL_ROOT in *[!A-Za-z0-9._/-]* | *//* | */../*) refuse kit_missing ;; esac
case $NODE_PATH in /* ) ;; *) refuse kit_missing ;; esac
case $NODE_PATH in *[!A-Za-z0-9._@/-]* | *//* | */../*) refuse kit_missing ;; esac
case $RELEASE in '' | *[!0-9a-f]*) refuse kit_missing ;; esac

# --- the access check (also the self-probe) -----------------------------------

TOKEN_FILE=$SUPPORT_DIR/support-access.token
BODY_FILE=

# The canonical v1 body, any decision: matched WHOLE, never parsed.
FPRE='"SHA256:[A-Za-z0-9+/]{43}"'
SHAPE='^\{"armed":(true|false),"armed_until":("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"|null),"subscription_active":(true|false),"decision":"(allow|deny)","active_keys":\[('"$FPRE"'(,'"$FPRE"'){0,7})?\],"retired_keys":\[('"$FPRE"'(,'"$FPRE"'){0,7})?\]\}$'
ALLOW='^\{"armed":true,"armed_until":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","subscription_active":true,"decision":"allow",'

cleanup() {
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  [ -n "${RUN_FILE:-}" ] && rm -f "$RUN_FILE"
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

# Ask marveen.io. Prints nothing; sets CHECK_CODE and CHECK_BODY. Returns 0 only for a canonical body with HTTP 200.
access_check() {
  CHECK_CODE= CHECK_BODY=
  [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || return 2
  _token=
  IFS= read -r _token < "$TOKEN_FILE" || [ -n "$_token" ] || return 2
  case $_token in mst_*) ;; *) return 2 ;; esac
  _tb=${_token#mst_}
  [ ${#_tb} -eq 43 ] || return 2
  case $_tb in *[!A-Za-z0-9_-]*) return 2 ;; esac
  BODY_FILE=$RUN_DIR/body.$$
  rm -f "$BODY_FILE"
  if [ "$PROBE" -eq 1 ]; then _req='{"key_fingerprint":"'$FP'","probe":true}'; else _req='{"key_fingerprint":"'$FP'"}'; fi
  # The token goes to curl on standard input (a header), never as an argument;
  # -q first so no .curlrc is read; env -i so no proxy or CA variable reaches it.
  CHECK_CODE=$(printf 'Authorization: Bearer %s\n' "$_token" | env -i PATH="$PATH" curl -q --silent \
    --proto '=https' --tlsv1.2 --max-time 5 --max-filesize "$BODY_MAX_BYTES" --max-redirs 0 \
    --request POST --header 'Content-Type: application/json' --header @- --data-binary "$_req" \
    --output "$BODY_FILE" --write-out '%{http_code}' "$ACCESS_CHECK_URL" 2>/dev/null)
  _token= _tb=
  case $CHECK_CODE in 200) ;; *) return 1 ;; esac
  [ -f "$BODY_FILE" ] || return 1
  _bytes=$(wc -c < "$BODY_FILE" | tr -d ' ')
  case $_bytes in '' | *[!0-9]*) return 1 ;; esac
  [ "$_bytes" -gt 0 ] && [ "$_bytes" -le "$BODY_MAX_BYTES" ] || return 1
  # one line, no line end at all (Mira 78183)
  _nl=$(wc -l < "$BODY_FILE" | tr -d ' ')
  [ "$_nl" = 0 ] || return 1
  grep -E -q -x -e "$SHAPE" "$BODY_FILE" || return 1
  IFS= read -r CHECK_BODY < "$BODY_FILE" || [ -n "$CHECK_BODY" ] || return 1
  return 0
}

# Is the canonical body a yes for THIS key? Full-element membership, by parameter expansion.
body_allows_me() {
  printf '%s' "$CHECK_BODY" | grep -E -q -e "$ALLOW" || return 1
  _active=${CHECK_BODY#*'"active_keys":['}
  _active=${_active%%'],"retired_keys":'*}
  _retired=${CHECK_BODY#*'"retired_keys":['}
  _retired=${_retired%']}'}
  case ",$_active," in *',"'"$FP"'",'*) ;; *) return 1 ;; esac
  case ",$_retired," in *',"'"$FP"'",'*) return 1 ;; esac
  return 0
}

if [ "$PROBE" -eq 1 ]; then
  # The enable self-probe: does the gate reach marveen.io with this token? It never opens anything.
  if access_check; then
    printf 'probe=reached\n'
    log_event probe reached
    exit 0
  fi
  _rc=$?
  [ "$_rc" -eq 2 ] && { printf 'probe=no_token\n'; log_event probe no_token; exit 1; }
  printf 'probe=unreachable\n'
  log_event probe unreachable
  exit 1
fi

# --- 3. the own line ------------------------------------------------------------

KEYS_FILE=$HOME_DIR/.ssh/authorized_keys
[ -f "$KEYS_FILE" ] || refuse own_line_missing
PREFIX='restrict,command="/bin/sh '$SELF' --key '$KEY' --fp '$FP' --grant '$GRANT' --consent '$CONSENT'",from="'
SUFFIX=' marveen-support:'$GRANT':'$KEY
_count=0
while IFS= read -r _line || [ -n "$_line" ]; do
  case $_line in
    "$PREFIX"*) ;;
    *) continue ;;
  esac
  case $_line in
    *"$SUFFIX") ;;
    *) continue ;;
  esac
  _mid=${_line#"$PREFIX"}
  _mid=${_mid%"$SUFFIX"}
  # what is left: <from hosts>",verify-required sk-ssh-ed25519@openssh.com <blob>
  _from=${_mid%%'",verify-required sk-ssh-ed25519@openssh.com '*}
  [ "$_from" != "$_mid" ] || continue
  case $_from in '' | *[!0-9a-fA-F.:,/]*) continue ;; esac
  _blob=${_mid#*'",verify-required sk-ssh-ed25519@openssh.com '}
  case $_blob in '' | *[!A-Za-z0-9+/=]*) continue ;; esac
  _count=$((_count + 1))
done < "$KEYS_FILE"
[ "$_count" -eq 1 ] || refuse own_line_missing
KEY_OK=$KEY
GRANT_OK=$GRANT

# The client address sshd reports, in a checked shape only.
case ${SSH_CONNECTION:-} in
  *[!0-9a-fA-F.:' ']* | '') CLIENT_IP= ;;
  *) CLIENT_IP=${SSH_CONNECTION%% *} ;;
esac

# --- 4. the connection's age ------------------------------------------------------

_pid=$$ _level=0 SSHD_PID=
while [ "$_level" -lt 5 ]; do
  _comm=$(ps -o comm= -p "$_pid" 2>/dev/null | sed 's/^ *//;s/ *$//')
  _base=${_comm##*/}
  case $_base in
    sshd | sshd-session | sshd:* | sshd-session:*) SSHD_PID=$_pid; break ;;
  esac
  _ppid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
  case $_ppid in '' | *[!0-9]* | 0 | 1) break ;; esac
  _pid=$_ppid
  _level=$((_level + 1))
done
[ -n "$SSHD_PID" ] || refuse connection_unknown
_et=$(ps -o etime= -p "$SSHD_PID" 2>/dev/null | tr -d ' ')
AGE_S=$(etime_seconds "$_et") || refuse connection_unknown
[ "$AGE_S" -le "$MAX_CONNECTION_AGE_S" ] || refuse connection_too_old

# --- 5 and 6. token and the yes from marveen.io -------------------------------------

access_check
case $? in
  0) ;;
  2) refuse no_token ;;
  *) refuse access_check_failed ;;
esac
if printf '%s' "$CHECK_BODY" | grep -E -q -e '"decision":"allow"'; then
  body_allows_me || refuse inconsistent
else
  refuse not_allowed
fi

# --- 7. the subcommand ----------------------------------------------------------------

COMMAND=${SSH_ORIGINAL_COMMAND:-}
case $COMMAND in
  status) SUB=status CAP=$CAP_DEFAULT_S ;;
  versions) SUB=versions CAP=$CAP_DEFAULT_S ;;
  units) SUB=units CAP=$CAP_DEFAULT_S ;;
  'logs dashboard '[1-9] | 'logs dashboard '[1-9][0-9] | 'logs dashboard '[1-9][0-9][0-9]) SUB=logs_dashboard CAP=$CAP_DEFAULT_S ;;
  'logs channels '[1-9] | 'logs channels '[1-9][0-9] | 'logs channels '[1-9][0-9][0-9]) SUB=logs_channels CAP=$CAP_DEFAULT_S ;;
  restart) SUB=restart CAP=$CAP_RESTART_S ;;
  *) refuse unknown_command ;;
esac
LINES=
case $SUB in
  logs_*)
    LINES=${COMMAND##* }
    [ "$LINES" -le "$LOG_LINES_MAX" ] || refuse unknown_command
    ;;
esac

if [ "$SUB" = restart ]; then
  # one per connection, a few per day, counted from the spool (the events this file wrote)
  _conn=0 _day=0
  # set -f is on for the whole file; the spool's own event names are the one glob this file expands
  set +f
  _events=$(printf '%s\n' "$SPOOL"/*.evt)
  set -f
  _old_ifs=$IFS; IFS='
'
  for _e in $_events; do
    [ -f "$_e" ] || continue
    _ev= _t= _c=
    while IFS= read -r _l; do
      case $_l in
        event=*) _ev=${_l#event=} ;;
        time=*) _t=${_l#time=} ;;
        reason=*) _c=${_l#reason=} ;;
      esac
    done < "$_e"
    [ "$_ev" = restart ] || continue
    case $_t in '' | 0* | *[!0-9]*) continue ;; esac
    [ ${#_t} -le 12 ] || continue
    [ $((NOW_S - _t)) -le 86400 ] && _day=$((_day + 1))
    [ "$_c" = "conn-$SSHD_PID" ] && _conn=$((_conn + 1))
  done
  IFS=$_old_ifs
  [ "$_conn" -lt "$RESTARTS_PER_CONNECTION" ] || refuse restart_limit
  [ "$_day" -lt "$RESTARTS_PER_DAY" ] || refuse restart_limit
fi

RUN_FILE=$RUN_DIR/$$
( set -C; printf 'pid=%s\n' "$$" > "$RUN_FILE" ) 2>/dev/null || refuse bad_path

# --- the subcommands (no free argument; output through the redactor where it carries text) ---

sub_status() {
  _dash=$(env -i PATH="$PATH" curl -q --silent --output /dev/null --max-time 3 --write-out '%{http_code}' \
    http://127.0.0.1:3420/api/auth/status 2>/dev/null)
  case $_dash in [0-9][0-9][0-9]) ;; *) _dash=unreachable ;; esac
  _dp=$(pgrep -f "$INSTALL_ROOT/dist/index.js" 2>/dev/null | wc -l | tr -d ' ')
  _cp=$(pgrep -f "$INSTALL_ROOT/scripts/channels.sh" 2>/dev/null | wc -l | tr -d ' ')
  printf 'dashboard_http=%s\ndashboard_processes=%s\nchannels_processes=%s\n' "$_dash" "$_dp" "$_cp"
}

sub_versions() {
  _node=$(env -i PATH="$PATH" "$NODE_PATH" --version 2>/dev/null | head -n 1)
  case $_node in v[0-9]*) ;; *) _node=unknown ;; esac
  _sshd=$(/usr/sbin/sshd -V 2>&1 | grep -E -o 'OpenSSH_[0-9]+\.[0-9]+[A-Za-z0-9.]*' | head -n 1)
  printf 'release=%s\nnode=%s\nsshd=%s\nos=%s\n' "$RELEASE" "$_node" "${_sshd:-unknown}" "$(uname -sr | redact)"
}

sub_units() {
  case $(uname -s) in
    Linux)
      env -i PATH="$PATH" XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user list-units --all --no-legend --plain 'marveen*' 2>/dev/null \
        | awk '{print $1, $2, $3, $4}' | grep -E '^[A-Za-z0-9._@-]+ ' | redact
      ;;
    Darwin)
      launchctl list 2>/dev/null | awk '{print $3, $1, $2}' | grep -E '^[A-Za-z0-9._-]*marveen[A-Za-z0-9._-]* ' | redact
      ;;
    *) printf 'units=unknown_platform\n' ;;
  esac
}

sub_logs() {
  _file=$INSTALL_ROOT/store/$1.log
  if [ -f "$_file" ] && [ ! -L "$_file" ]; then
    tail -n "$LINES" "$_file" | redact
  else
    printf 'log=missing\n'
  fi
}

sub_restart() {
  log_event restart "conn-$SSHD_PID"
  _path=$(dirname "$NODE_PATH"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  _rc=0
  env -i PATH="$_path" HOME="$HOME_DIR" LC_ALL=C /bin/bash "$INSTALL_ROOT/scripts/stop.sh" > /dev/null 2>&1 || _rc=$?
  env -i PATH="$_path" HOME="$HOME_DIR" LC_ALL=C /bin/bash "$INSTALL_ROOT/scripts/start.sh" > /dev/null 2>&1 || _rc=$?
  if [ "$_rc" -eq 0 ]; then printf 'restart=done\n'; else printf 'restart=failed\n'; fi
  return "$_rc"
}

# Kill a process and every descendant, deepest first.
kill_tree() {
  for _child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$_child"; done
  kill -TERM "$1" 2>/dev/null
  return 0
}

# Run the subcommand in the background under a hard cap, asking marveen.io again every minute.
case $SUB in
  status) sub_status & ;;
  versions) sub_versions & ;;
  units) sub_units & ;;
  logs_dashboard) sub_logs dashboard & ;;
  logs_channels) sub_logs channels & ;;
  restart) sub_restart & ;;
esac
CHILD=$!
log_event start "$SUB"
_elapsed=0
while kill -0 "$CHILD" 2>/dev/null; do
  sleep 1
  _elapsed=$((_elapsed + 1))
  if [ "$_elapsed" -ge "$CAP" ]; then
    kill_tree "$CHILD"
    log_event stopped time_cap
    printf '%s\n' 'support access: stopped (time_cap)' >&2
    exit 1
  fi
  if [ $((_elapsed % RECHECK_EVERY_S)) -eq 0 ]; then
    if ! access_check || ! body_allows_me; then
      kill_tree "$CHILD"
      log_event stopped revoked
      printf '%s\n' 'support access: stopped (no_longer_allowed)' >&2
      exit 1
    fi
  fi
done
wait "$CHILD"
_rc=$?
log_event done "$SUB"
exit "$_rc"
