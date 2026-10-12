# Shared, existence-checked content hashing for shell scripts (MD5SUMHIANY826).
#
# Why this exists: `md5sum` does not exist on macOS, and the flagship host's
# service PATH does not even carry /sbin/md5. A bare `... | md5sum | awk ...`
# pipeline therefore yields an EMPTY string with exit 0 -- and two empty
# hashes are EQUAL. The same root cause produced two OPPOSITE lies on the
# same day: the limit-monitor dedupe saw every alert as "already sent" and
# swallowed all of them, while a session-stuck comparison saw two live pane
# captures as "unchanged" and raised a false alarm. A hash helper must never
# hand back an empty fingerprint: it either hashes or it FAILS.
#
# Usage:
#   . "$INSTALL_DIR/scripts/lib/content-hash.sh"
#   HASH="$(printf '%s' "$data" | content_hash)" || <handle loudly>
#
#   printf '%s' "$data" | dedupe_check "$state_file"
#     exit 0 -> NEW signal (caller should alert; stamp the state file with
#               the printed hash ONLY after a confirmed send)
#     exit 1 -> unchanged (already alerted)
#     exit 2 -> hashing unavailable (caller must fail OPEN for alert paths:
#               better a duplicate alert than a swallowed one)
#
# The output is prefixed with the algorithm (md5:/sha1:/cksum:) so fingerprints
# from different tiers can never compare equal by accident when a host's PATH
# changes between runs.

# Tool availability probe. CONTENT_HASH_DISABLE is a space-separated list of
# tool names/paths to treat as absent -- a TEST seam only: the no-tool branch
# is otherwise unreachable on any sane host (cksum is POSIX), and a branch
# that cannot be exercised is a branch that rots.
_ch_has() {
  case " ${CONTENT_HASH_DISABLE:-} " in *" $1 "*) return 1 ;; esac
  command -v "$1" >/dev/null 2>&1
}

content_hash() {
  if _ch_has md5sum; then
    printf 'md5:%s' "$(md5sum | awk '{print $1}')"
    return 0
  fi
  # macOS/BSD md5 reads stdin and prints the bare digest. The service PATH may
  # miss /sbin, so probe absolute locations too.
  for _ch_md5 in md5 /sbin/md5 /usr/bin/md5; do
    if _ch_has "$_ch_md5"; then
      printf 'md5:%s' "$("$_ch_md5")"
      return 0
    fi
  done
  if _ch_has shasum; then
    printf 'sha1:%s' "$(shasum | awk '{print $1}')"
    return 0
  fi
  # cksum is POSIX-mandated; reaching past it means a broken userland.
  if _ch_has cksum; then
    printf 'cksum:%s' "$(cksum | awk '{print $1"-"$2}')"
    return 0
  fi
  echo "content_hash: no hashing tool available (md5sum/md5/shasum/cksum) -- refusing to return an empty fingerprint" >&2
  return 127
}

# Reads the candidate from stdin, prints its hash, and answers whether it is
# NEW relative to the state file. Never writes the state file itself: the
# stamp belongs to the caller, AFTER a confirmed delivery (NOTIFYVAKSWEEP826).
dedupe_check() {
  _dc_state="$1"
  _dc_hash="$(content_hash)" || return 2
  printf '%s' "$_dc_hash"
  _dc_prev="$(cat "$_dc_state" 2>/dev/null)"
  [ "$_dc_hash" != "$_dc_prev" ]
}
