# Bearer-token curl hivas.
#
# A token curl argumentumkent ps-ben lathato (ps -ww, /proc/<pid>/cmdline), ezert a fejlecet
# curl-konfiggal, stdin-en adjuk at (-K -): a token sose kerul a curl argv-jaba. A printf a shell
# beepitett builtinje, nem kulon processz, igy az sem kerul argv-ba.
#
# Usage:
#   . "$(dirname "$0")/lib/curl-tok.sh"
#   curl_tok "$TOKEN" -s --max-time 10 "$URL"
# A token a fejlecben idezojelben all, ezert idezojelet, backslash-t vagy ujsort nem tartalmazhat
# (a dashboard-token hex, a hivo ezt nem sertheti); ilyenkor rc 2.

curl_tok() {
  local tok="$1"; shift
  case "$tok" in
    *\"*|*\\*|*$'\n'*) echo "curl_tok: a token idezojelet, backslash-t vagy ujsort tartalmaz -- nem kuldom" >&2; return 2 ;;
  esac
  printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -K - "$@"
}
