#!/usr/bin/env bash
# verify-restore.sh -- verify a Marveen backup archive before restoring.
#
# Usage: scripts/verify-restore.sh <archive.tar.gz>
#
# Checks performed:
#   1. Archive file exists and is readable.
#   2. SHA-256 checksum matches the .sha256 sidecar (if present).
#   3. gzip stream is not corrupt (gzip -t).
#   4. tar listing succeeds (no broken entries).
#   5. Required sentinel files are present inside the archive.
#   6. Embedded DB is extracted to a temp dir and PRAGMA integrity_check runs.
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed.
# Result is also written to restore_log in the live DB (if sqlite3 is present).

set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "${ARCHIVE}" ]]; then
  echo "Usage: $0 <archive.tar.gz>" >&2
  exit 1
fi

if [[ ! -f "${ARCHIVE}" ]]; then
  echo "verify-restore: ERROR -- file not found: ${ARCHIVE}" >&2
  exit 1
fi

ARCHIVE="$(cd "$(dirname "${ARCHIVE}")" && pwd)/$(basename "${ARCHIVE}")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0
NOTE=""

check_pass() { echo "  [OK] $1"; }
check_fail() { echo "  [FAIL] $1" >&2; FAIL=$((FAIL+1)); NOTE="${NOTE}FAIL:$1; "; }

echo "verify-restore: checking ${ARCHIVE}"
echo ""

# 1. Checksum
SIDECAR="${ARCHIVE%.tar.gz}.sha256"
if [[ -f "${SIDECAR}" ]]; then
  echo "[1] Checksum verification..."
  if command -v sha256sum >/dev/null 2>&1; then
    if (cd "$(dirname "${ARCHIVE}")" && sha256sum -c "$(basename "${SIDECAR}")" >/dev/null 2>&1); then
      check_pass "sha256 matches sidecar"
    else
      check_fail "sha256 MISMATCH -- archive may be corrupt or tampered"
    fi
  elif command -v shasum >/dev/null 2>&1; then
    if (cd "$(dirname "${ARCHIVE}")" && shasum -a 256 -c "$(basename "${SIDECAR}")" >/dev/null 2>&1); then
      check_pass "sha256 matches sidecar"
    else
      check_fail "sha256 MISMATCH -- archive may be corrupt or tampered"
    fi
  else
    echo "  [SKIP] sha256sum/shasum not found -- skipping checksum check"
  fi
else
  echo "  [SKIP] No .sha256 sidecar found (older backup) -- skipping checksum"
fi

# 2. gzip integrity
echo "[2] gzip stream integrity..."
if gzip -t "${ARCHIVE}" 2>/dev/null; then
  check_pass "gzip stream OK"
else
  check_fail "gzip stream corrupt"
fi

# 3. tar listing
echo "[3] tar listing..."
if tar -tzf "${ARCHIVE}" >/dev/null 2>&1; then
  check_pass "tar listing OK"
else
  check_fail "tar listing failed"
fi

# 4. Sentinel files
echo "[4] Required files present..."
REQUIRED=(
  "MANIFEST.txt"
  "repo/store/claudeclaw.db"
)
for sentinel in "${REQUIRED[@]}"; do
  if tar -tzf "${ARCHIVE}" 2>/dev/null | grep -qF "${sentinel}"; then
    check_pass "${sentinel} present"
  else
    check_fail "${sentinel} MISSING"
  fi
done

# 5. DB integrity_check
echo "[5] DB integrity check..."
TMPDIR_EXTRACT="$(mktemp -d -t verify-restore.XXXXXX)"
trap 'rm -rf "${TMPDIR_EXTRACT}"' EXIT

if tar -xzf "${ARCHIVE}" -C "${TMPDIR_EXTRACT}" repo/store/claudeclaw.db 2>/dev/null; then
  EXTRACTED_DB="${TMPDIR_EXTRACT}/repo/store/claudeclaw.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    IC="$(sqlite3 "${EXTRACTED_DB}" 'PRAGMA integrity_check(1);' 2>/dev/null || echo 'error')"
    if [[ "${IC}" == "ok" ]]; then
      check_pass "PRAGMA integrity_check: ok"
      INTEGRITY_OK=1
    else
      check_fail "PRAGMA integrity_check: ${IC}"
      INTEGRITY_OK=0
    fi
  else
    echo "  [SKIP] sqlite3 not found -- skipping DB integrity check"
    INTEGRITY_OK=1
  fi
else
  check_fail "Could not extract DB from archive"
  INTEGRITY_OK=0
fi

# --- Summary ---
echo ""
if [[ ${FAIL} -eq 0 ]]; then
  echo "verify-restore: ALL CHECKS PASSED -- archive appears healthy"
  EXIT_CODE=0
else
  echo "verify-restore: ${FAIL} CHECK(S) FAILED -- do NOT restore without investigation" >&2
  EXIT_CODE=1
fi

# Write to restore_log (best-effort; never abort on failure)
DB_PATH="${REPO_ROOT}/store/claudeclaw.db"
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "${DB_PATH}" ]]; then
  # Compute checksum for the log
  CHECKSUM=""
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    CHECKSUM="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  fi
  LOG_NOTE="verify-restore: ${FAIL} failed check(s). ${NOTE}"
  sqlite3 "${DB_PATH}" \
    "INSERT INTO restore_log (archive_path, checksum, integrity_ok, note) VALUES ('${ARCHIVE}', '${CHECKSUM}', ${INTEGRITY_OK:-0}, '${LOG_NOTE}');" \
    2>/dev/null || true
fi

exit ${EXIT_CODE}
