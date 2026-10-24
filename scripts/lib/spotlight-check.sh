#!/bin/bash
# macOS Spotlight check for scripts/doctor.sh (SPOTLIGHT1022). Sourced, never executed.
#
# Why: on a Mac where the agents write logs, jsonl transcripts and sqlite files
# all day, the Spotlight index on the Data volume can grow to tens of GiB, and
# every index merge writes a full temporary copy on top. This shows up as
# "System Data" eating the disk and vanishing on a reboot. A paying owner
# measured it on macOS 26.6: a 64+ GiB index, +74 GiB during a merge.
#
# The check only REPORTS. It does not change the index, and it never runs sudo:
# the index size and the merge files are root-only, so it prints the commands for
# the owner instead. Docs: docs/macos-spotlight.md.
#
# spotlight_check -- prints one "<level>|<message>" line per finding, level is
# ok, warn or skip. INSTALL_DIR (set by doctor.sh) names the folder to exclude.
# MDUTIL and PS override the binaries (tests only).

spotlight_check() {
  _sc_mdutil="${MDUTIL:-/usr/bin/mdutil}"
  _sc_ps="${PS:-/bin/ps}"
  if [ ! -x "$_sc_mdutil" ]; then
    echo "skip|mdutil not found (not macOS?)"
    return 0
  fi
  _sc_vol="/System/Volumes/Data"
  [ -d "$_sc_vol" ] || _sc_vol="/"
  _sc_status="$("$_sc_mdutil" -s "$_sc_vol" 2>/dev/null || true)"
  case "$_sc_status" in
    *"Indexing enabled"*)
      _sc_cpu="$("$_sc_ps" -axo time=,comm= 2>/dev/null | awk '$2 ~ /\/mds_stores$/ {print $1; exit}' || true)"
      echo "warn|Spotlight indexes $_sc_vol${_sc_cpu:+ (mds_stores CPU time: $_sc_cpu)}. The agents' logs, jsonl and sqlite files can grow the index by tens of GiB (System Data). Fix: System Settings > Spotlight > Search Privacy, add ${INSTALL_DIR:-the install folder} and ~/.claude (already there: nothing to do; this check cannot read that list without root) -- see docs/macos-spotlight.md"
      echo "warn|Index size and merge files need root: sudo du -sh $_sc_vol/.Spotlight-V100 ; sudo lsof -c mds_stores | grep -iE 'merge|indexPositions'"
      ;;
    *"Indexing disabled"*)
      echo "ok|Spotlight indexing is off on $_sc_vol"
      ;;
    *)
      echo "skip|mdutil gave no index status for $_sc_vol"
      ;;
  esac
  return 0
}
