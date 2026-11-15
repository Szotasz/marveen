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
#   7. the subcommand is on the closed list, with no free argument, or it is
#      `run <text>` (v8) and the support line carries consent 2 or later.
# Anything else: one refusal line, an event in the spool, a non-zero exit.
#
# `run <text>` runs the text with /bin/sh -c as this user, in its own process
# group, with an environment this file assembles (HOME, USER, LOGNAME, SHELL from
# the password database, PATH from the user's login shell, LANG=C.UTF-8; nothing
# from the client). It is logged BEFORE it starts (redacted, escaped, cut), and
# again when it ends with the exit code, the duration and the byte counts of
# stdin, stdout and stderr; the output itself is never stored. It stops at the
# 60-minute mark of the connection, when marveen.io no longer says yes (asked
# every minute), and at once when support is switched off here (the token or
# this run's file in the run folder is gone).
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
RUN_CONSENT_MIN=2
RUN_TEXT_MAX_BYTES=4096
RUN_PERSIST_MAX_BYTES=1024
RUN_GRACE_S=2
STATUS_RUNS_MAX=20

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
  # Whole terminal sequences go first, so no "[33m" is left behind once tr takes the ESC byte:
  # OSC (ESC ] ... BEL or ESC \), then CSI (ESC [ params intermediates final), then two-byte ESC forms.
  _esc=$(printf '\033'); _bel=$(printf '\007')
  sed -E \
    -e "s#${_esc}\\][^${_bel}${_esc}]*(${_bel}|${_esc}\\\\)##g" \
    -e "s#${_esc}\\[[0-?]*[ -/]*[@-~]##g" \
    -e "s#${_esc}[@-_]##g" |
  tr -d '\000-\010\013-\037\177' | redact_secrets | cut -c1-2000
}

# The secret and personal-data patterns alone, line by line, bytes kept otherwise (the run log escapes after this).
redact_secrets() {
  sed -E \
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
    -e 's/[A-Za-z0-9+\/_-]{40,}={0,2}/[redacted-b64]/g'
}

# The run log's text, byte by byte (od gives the bytes as numbers, awk only counts and
# prints octal escapes for printf): a backslash becomes \\, a control byte \xNN (upper-case
# hex), a byte that does not start a valid UTF-8 character \xNN too, a valid character
# passes whole; the cut at the byte budget falls between two such pieces, never inside one.
# The last byte of the input is the line end log_text adds for sed, and is dropped.
LOG_TEXT_AWK='
function o(v) { return sprintf("\\%03o", v) }
function enc(s,  k, r) { r = ""; for (k = 1; k <= length(s); k++) r = r o(ord[substr(s, k, 1)]); return r }
function within(v, lo, hi) { return v >= lo && v <= hi }
function ulen(i,  c, lo, hi) {
  c = b[i]
  if (c >= 194 && c <= 223) return (i + 1 <= n && within(b[i + 1], 128, 191)) ? 2 : 0
  if (c >= 224 && c <= 239) {
    lo = 128; hi = 191
    if (c == 224) lo = 160
    if (c == 237) hi = 159
    return (i + 2 <= n && within(b[i + 1], lo, hi) && within(b[i + 2], 128, 191)) ? 3 : 0
  }
  if (c >= 240 && c <= 244) {
    lo = 128; hi = 191
    if (c == 240) lo = 144
    if (c == 244) hi = 143
    return (i + 3 <= n && within(b[i + 1], lo, hi) && within(b[i + 2], 128, 191) && within(b[i + 3], 128, 191)) ? 4 : 0
  }
  return 0
}
BEGIN { for (k = 32; k < 127; k++) ord[sprintf("%c", k)] = k; n = 0; total = 0 }
{ for (f = 1; f <= NF; f++) { total++; if (n < max + 8) b[++n] = $f + 0 } }
END {
  if (total == n && n > 0 && b[n] == 10) n--
  out = ""; used = 0; i = 1
  while (i <= n) {
    c = b[i]; adv = 1
    if (c == 92) { tok = o(92) o(92); len = 2 }
    else if (c < 32 || c == 127) { tok = enc(sprintf("\\x%02X", c)); len = 4 }
    else if (c < 128) { tok = o(c); len = 1 }
    else {
      adv = ulen(i)
      if (adv > 0) { tok = ""; for (k = 0; k < adv; k++) tok = tok o(b[i + k]); len = adv }
      else { adv = 1; tok = enc(sprintf("\\x%02X", c)); len = 4 }
    }
    if (used + len > max) break
    out = out tok; used += len; i += adv
  }
  printf "%s", out
}'

# stdin: any bytes. stdout: redacted FIRST (on the whole text, so a cut never leaves half a
# secret behind the redactor), then escaped, then cut to $1 bytes; one line, no line end.
log_text() {
  _fmt=$({ cat; printf '\n'; } | redact_secrets | od -An -v -tu1 | awk -v max="$1" "$LOG_TEXT_AWK")
  # _fmt holds only \ooo escapes, built above: it is the format on purpose
  printf "$_fmt"
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
SPOOL=$SUPPORT_DIR/support-access.spool
RUN_DIR=$SUPPORT_DIR/support-access.run
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
  [ -n "${RDIR:-}" ] && rm -rf "$RDIR"
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
  'run '*) SUB=run CAP=0 ;;
  *) refuse unknown_command ;;
esac
if [ "$SUB" = run ]; then
  RUN_TEXT=${COMMAND#run }
  [ -n "$RUN_TEXT" ] || refuse unknown_command
  # a v1 machine (consent 1) keeps the fixed subcommands until it is switched on again (D3)
  [ "$CONSENT" -ge "$RUN_CONSENT_MIN" ] || refuse consent_too_old
  # the cap is what is left of the connection's 60 minutes (D4); AGE_S was checked to be at most that
  CAP=$((MAX_CONNECTION_AGE_S - AGE_S))
  [ "$CAP" -gt 0 ] || refuse connection_too_old
  # every run event carries a random 128-bit id; without one there is no event, so nothing runs
  RUN_ID=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')
  case $RUN_ID in '' | *[!0-9a-f]*) refuse no_event_id ;; esac
  [ ${#RUN_ID} -eq 32 ] || refuse no_event_id
fi
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
  status_runs
}

# The last runs from the spool (D5: until the Profile list exists), oldest first; the text was
# redacted and escaped when it was logged, and goes through the redactor again on the way out.
status_runs() {
  set +f
  _events=$(printf '%s\n' "$SPOOL"/*.evt)
  set -f
  _old_ifs=$IFS; IFS='
'
  for _e in $_events; do
    [ -f "$_e" ] && [ ! -L "$_e" ] || continue
    _ev= _t= _x= _ms= _cmd=
    while IFS= read -r _l; do
      case $_l in
        event=*) _ev=${_l#event=} ;;
        time=*) _t=${_l#time=} ;;
        exit=*) _x=${_l#exit=} ;;
        duration_ms=*) _ms=${_l#duration_ms=} ;;
        command=*) _cmd=${_l#command=} ;;
      esac
    done < "$_e"
    [ "$_ev" = run ] || continue
    case $_t in '' | *[!0-9]*) continue ;; esac
    printf '%s\trun time=%s exit=%s ms=%s command=%s\n' "$_t" "$_t" "$_x" "$_ms" "$_cmd"
  done | sort -n | tail -n "$STATUS_RUNS_MAX" | cut -f2- | redact
  IFS=$_old_ifs
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

# Kill a process and every descendant, deepest first ($2: the signal, TERM when not given).
kill_tree() {
  for _child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$_child" "${2:-TERM}"; done
  kill -"${2:-TERM}" "$1" 2>/dev/null
  return 0
}

# Support switched off on this machine: the disable removes the token and this run's file.
switched_off() {
  [ -f "$RUN_FILE" ] && [ -f "$TOKEN_FILE" ] && return 1
  return 0
}

# --- run <text> -------------------------------------------------------------------------

# A short wait; whole seconds where the sleep has no fractions.
tick() {
  sleep 0.2 2>/dev/null || sleep 1
}

# Milliseconds since the epoch where date has %N, else whole seconds times 1000.
ms_now() {
  _t=$(date +%s%N 2>/dev/null)
  case $_t in
    '' | *[!0-9]*) echo $(( $(date +%s) * 1000 )) ;;
    *) if [ ${#_t} -ge 19 ]; then echo "${_t%??????}"; else echo $(( $(date +%s) * 1000 )); fi ;;
  esac
}

# An absolute path of plain characters.
plain_abs() {
  case $1 in /*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9._/@+-]* | *//* | */./* | */../*) return 1 ;; esac
  return 0
}

# A PATH value: absolute directories of plain characters, colon-separated, no empty entry.
plain_path() {
  [ -n "$1" ] && [ ${#1} -le 4096 ] || return 1
  case $1 in *[!A-Za-z0-9._/:@+-]*) return 1 ;; esac
  case ":$1:" in *::*) return 1 ;; esac
  case ":$1" in *:[!/]*) return 1 ;; esac
  return 0
}

# HOME, USER, LOGNAME and SHELL from the password database (R1). If the entry cannot be read
# or has another shape, the support home and /bin/sh, and the fixed PATH (RUN_ENV=fallback).
run_identity() {
  RUN_ENV=fallback R_HOME=$HOME_DIR R_SHELL=/bin/sh
  R_USER=$(id -un 2>/dev/null)
  case $R_USER in '' | -* | *[!A-Za-z0-9._-]*) R_USER=$(id -u) ;; esac
  case $(uname -s) in
    Darwin) _pw=$(id -P 2>/dev/null) ;;
    *) _pw=$(getent passwd "$(id -u)" 2>/dev/null) ;;
  esac
  case $_pw in *'
'*) _pw= ;; esac
  [ -n "$_pw" ] && [ "${_pw%%:*}" = "$R_USER" ] || return 0
  # the last two fields of both the passwd and the BSD master.passwd line: home, shell
  _sh=${_pw##*:}
  _h=${_pw%:*}
  _h=${_h##*:}
  plain_abs "$_h" && plain_abs "$_sh" && [ -x "$_sh" ] || return 0
  RUN_ENV=passwd R_HOME=$_h R_SHELL=$_sh
}

# The user's login PATH, asked once from the login shell (Samu 78881): the profile's output is
# thrown away, the last marker line counts, and only a plain PATH value is taken.
run_login_path() {
  R_PATH=$PATH
  [ "$RUN_ENV" = passwd ] || return 0
  env -i HOME="$R_HOME" USER="$R_USER" LOGNAME="$R_USER" SHELL="$R_SHELL" PATH="$PATH" LANG=C.UTF-8 \
    "$R_SHELL" -lc 'printf "\nMVPATH=%s\n" "$PATH"' < /dev/null > "$RDIR/path.out" 2> /dev/null 3<&- 4>&- &
  _q=$!
  while kill -0 "$_q" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      kill_tree "$_q" KILL
      return 0
    fi
    tick
  done
  wait "$_q" 2>/dev/null
  _p=$(sed -n 's/^MVPATH=//p' "$RDIR/path.out" | tail -n 1)
  plain_path "$_p" && R_PATH=$_p
  return 0
}

# The user's persistence points (R3), one line each: kind, path, checksum.
persist_snapshot() {
  {
    printf 'crontab\tcrontab\t%s\n' "$(crontab -l 2>/dev/null | cksum)"
    _dirs="$HOME_DIR/Library/LaunchAgents
$HOME_DIR/.config/systemd/user"
    if [ "$(id -u)" = 0 ]; then
      _dirs="$_dirs
/Library/LaunchAgents
/Library/LaunchDaemons
/etc/systemd/system
/etc/cron.d"
    fi
    _old_ifs=$IFS; IFS='
'
    for _dir in $_dirs; do
      [ -d "$_dir" ] || continue
      find "$_dir" -mindepth 1 -maxdepth 2 \( -type f -o -type l \) 2>/dev/null | while IFS= read -r _p; do
        case $_p in "$HOME_DIR"/*) _show="~/${_p#"$HOME_DIR"/}" ;; *) _show=$_p ;; esac
        printf 'file\t%s\t%s\n' "$_show" "$(cksum < "$_p" 2>/dev/null)"
      done
    done
    IFS=$_old_ifs
  } | sort
}

# What changed between two snapshots: +added, -removed, ~changed, by path, on one line.
persist_diff() {
  awk -F '\t' 'NR == FNR { b[$1 "\t" $2] = $3; next }
    { k = $1 "\t" $2; seen[k] = 1; if (!(k in b)) print "+" $2; else if (b[k] != $3) print "~" $2 }
    END { for (k in b) if (!(k in seen)) { split(k, p, "\t"); print "-" p[2] } }' "$1" "$2" | sort | tr '\n' ' '
}

# One run event, written whole: a temporary name first, then a hard link to the .evt name
# (atomic, and it fails when the name exists), so a reader never sees half an event.
log_run() {
  # $1: run_start | run, $2: the reason, $3: the exit code (-1: stopped by this file)
  [ -n "${SPOOL:-}" ] && [ -d "$SPOOL" ] || return 1
  _tmp=$SPOOL/.run.$$.tmp
  rm -f "$_tmp"
  ( set -C; printf 'time=%s\nevent=%s\nreason=%s\nid=%s\nkey=%s\nfp=%s\ngrant=%s\nclient=%s\nexit=%s\nduration_ms=%s\nstdin_bytes=%s\nstdout_bytes=%s\nstderr_bytes=%s\nenv=%s\npersistence=%s\ncommand=%s\n' \
      "$RUN_T0" "$1" "$2" "$RUN_ID" "$KEY_OK" "$FP" "$GRANT_OK" "${CLIENT_IP:-}" "$3" "${RUN_MS:-0}" \
      "${N_IN:--1}" "${N_OUT:--1}" "${N_ERR:--1}" "$RUN_ENV" "${PERSIST:-}" "$RUN_LOGGED" > "$_tmp" ) 2>/dev/null || return 1
  _n=0
  while [ "$_n" -lt 50 ]; do
    if ln "$_tmp" "$SPOOL/$RUN_T0.$$.r$_n.evt" 2>/dev/null; then
      rm -f "$_tmp"
      return 0
    fi
    _n=$((_n + 1))
  done
  rm -f "$_tmp"
  return 1
}

# A byte count a relay wrote, or -1.
count_of() {
  _c=$(tr -d ' \t\n' < "$1" 2>/dev/null)
  case $_c in '' | *[!0-9]*) echo -1 ;; *) echo "$_c" ;; esac
}

# After the command: give the output relays a moment to pass what is left, then end every
# relay (the stdin relay may wait on the client forever), then read the counts.
run_drain() {
  _w=0
  while [ "$_w" -lt "$RUN_GRACE_S" ] && { kill -0 "$T_OUT" 2>/dev/null || kill -0 "$T_ERR" 2>/dev/null; }; do
    sleep 1
    _w=$((_w + 1))
  done
  for _r in $T_IN $T_OUT $T_ERR; do kill -TERM "$_r" 2>/dev/null; done
  _w=0
  while [ "$_w" -lt "$RUN_GRACE_S" ] && { kill -0 "$W_IN" 2>/dev/null || kill -0 "$W_OUT" 2>/dev/null || kill -0 "$W_ERR" 2>/dev/null; }; do
    sleep 1
    _w=$((_w + 1))
  done
  for _r in $W_IN $W_OUT $W_ERR; do kill -KILL "$_r" 2>/dev/null; done
  N_IN=$(count_of "$RDIR/in.n") N_OUT=$(count_of "$RDIR/out.n") N_ERR=$(count_of "$RDIR/err.n")
}

# The end event: duration, counts, the persistence diff.
run_finish() {
  # $1: exit code, $2: reason
  RUN_MS=$(( $(ms_now) - RUN_MS0 ))
  persist_snapshot > "$RDIR/persist.after" 2>/dev/null
  PERSIST=$(persist_diff "$RDIR/persist.before" "$RDIR/persist.after" | log_text "$RUN_PERSIST_MAX_BYTES")
  log_run run "$2" "$1"
}

# Stop the run: the whole process group (R3), then any descendant left, TERM and then KILL.
run_stop() {
  trap '' HUP INT TERM
  [ "$GROUP" -eq 1 ] && kill -TERM "-$CMD" 2>/dev/null
  kill_tree "$CMD" TERM
  # The grace is for the whole group: the top command often dies on TERM at once while a member is still in its
  # TERM handler, and it must get the grace too, not a KILL right away (Samu's review of #2800). Without a group,
  # only the command itself can be watched.
  _w=0
  while [ "$_w" -lt "$RUN_GRACE_S" ]; do
    if [ "$GROUP" -eq 1 ]; then
      kill -0 "-$CMD" 2>/dev/null || break
    else
      kill -0 "$CMD" 2>/dev/null || break
    fi
    sleep 1
    _w=$((_w + 1))
  done
  [ "$GROUP" -eq 1 ] && kill -KILL "-$CMD" 2>/dev/null
  kill_tree "$CMD" KILL
  wait "$CMD" 2>/dev/null
  run_drain
  run_finish -1 "$1"
  printf '%s\n' "support access: stopped ($1)" >&2
  exit 1
}

run_main() {
  # stdin on fd 3 BEFORE any background job: dash gives an async list /dev/null as stdin (16.1)
  exec 3<&0 4>&2
  DEADLINE=$((NOW_S + CAP))
  RDIR=$RUN_DIR/r.$$
  mkdir "$RDIR" 2>/dev/null || refuse bad_path
  for _f in in out err cin cout cerr; do
    mkfifo "$RDIR/$_f" 2>/dev/null || refuse bad_path
  done
  run_identity
  RUN_LOGGED=$(printf '%s' "$RUN_TEXT" | log_text "$RUN_TEXT_MAX_BYTES")
  # the snapshot and the start event come BEFORE the login shell runs the user's profile, so
  # whatever the profile itself leaves behind is in the diff too (Samu's review of #2800)
  persist_snapshot > "$RDIR/persist.before" 2>/dev/null
  RUN_T0=$(date +%s)
  RUN_MS0=$(ms_now)
  # in the log before it starts; a run that cannot be logged does not start
  log_run run_start started -1 || refuse spool_unwritable
  run_login_path

  # byte counters, then the relays (tee passes the bytes on and gives a copy to wc), then the command
  wc -c < "$RDIR/cin" > "$RDIR/in.n" 2> /dev/null 3<&- 4>&- &
  W_IN=$!
  wc -c < "$RDIR/cout" > "$RDIR/out.n" 2> /dev/null 3<&- 4>&- &
  W_OUT=$!
  wc -c < "$RDIR/cerr" > "$RDIR/err.n" 2> /dev/null 3<&- 4>&- &
  W_ERR=$!
  tee "$RDIR/cin" <&3 > "$RDIR/in" 2> /dev/null 3<&- 4>&- &
  T_IN=$!
  tee "$RDIR/cout" < "$RDIR/out" 2> /dev/null 3<&- 4>&- &
  T_OUT=$!
  tee "$RDIR/cerr" < "$RDIR/err" >&4 2> /dev/null 3<&- 4>&- &
  T_ERR=$!

  # its own process group: setsid on Linux (util-linux), job control on macOS's /bin/sh
  GROUP=0
  if [ "$(uname -s)" = Linux ] && command -v setsid > /dev/null 2>&1; then
    setsid env -i HOME="$R_HOME" USER="$R_USER" LOGNAME="$R_USER" SHELL="$R_SHELL" PATH="$R_PATH" LANG=C.UTF-8 \
      /bin/sh -c "$RUN_TEXT" < "$RDIR/in" > "$RDIR/out" 2> "$RDIR/err" 3<&- 4>&- &
    CMD=$!
    GROUP=1
  elif [ "$(uname -s)" = Darwin ] && ( set -m ) 2> /dev/null; then
    set -m 2> /dev/null
    env -i HOME="$R_HOME" USER="$R_USER" LOGNAME="$R_USER" SHELL="$R_SHELL" PATH="$R_PATH" LANG=C.UTF-8 \
      /bin/sh -c "$RUN_TEXT" < "$RDIR/in" > "$RDIR/out" 2> "$RDIR/err" 3<&- 4>&- &
    CMD=$!
    set +m 2> /dev/null
    GROUP=1
  else
    env -i HOME="$R_HOME" USER="$R_USER" LOGNAME="$R_USER" SHELL="$R_SHELL" PATH="$R_PATH" LANG=C.UTF-8 \
      /bin/sh -c "$RUN_TEXT" < "$RDIR/in" > "$RDIR/out" 2> "$RDIR/err" 3<&- 4>&- &
    CMD=$!
  fi
  # the relays hold what they need; this shell keeps neither the client's stdin nor the spare stderr
  exec 3<&- 4>&-
  trap 'run_stop hangup' HUP INT TERM

  _checked=$(date +%s)
  while kill -0 "$CMD" 2>/dev/null; do
    tick
    switched_off && run_stop disabled
    _now=$(date +%s)
    [ "$_now" -lt "$DEADLINE" ] || run_stop time_cap
    if [ $((_now - _checked)) -ge "$RECHECK_EVERY_S" ]; then
      _checked=$_now
      { access_check && body_allows_me; } || run_stop revoked
    fi
  done
  wait "$CMD"
  _rc=$?
  trap 'cleanup; exit 1' HUP INT TERM
  run_drain
  run_finish "$_rc" done
  exit "$_rc"
}

[ "$SUB" = run ] && run_main

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
  if switched_off; then
    kill_tree "$CHILD"
    log_event stopped disabled
    printf '%s\n' 'support access: stopped (disabled)' >&2
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
