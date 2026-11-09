#!/bin/bash
# DOCKERSEEDREFRESH1108: before code-sync swaps the code tree, keep the seed SOURCES of the tree this volume ran in
# /opt/marveen/.seed-prev. After the swap, first-boot refreshes every installed seed copy that equals what this old
# tree would have seeded (docker/seed-refresh-docker.sh); a copy the operator edited equals nothing and is kept.
# Taken only when the image changes, never of a half-swapped tree (.code-sync-pending), and never over a snapshot that
# was not applied yet (an image skipped while its refresh failed still compares against the tree that seeded the copy).
# A failure here only means no refresh this time: entrypoint.sh goes on.
set -u
INSTALL_DIR="${MARVEEN_INSTALL_DIR:-/opt/marveen}"
META="${MARVEEN_DOCKER_DIR:-/opt/marveen-docker}"
say() { printf 'seed-snapshot: %s\n' "$*"; }

have="$(cat "$INSTALL_DIR/.image-id" 2>/dev/null || true)"
want="$(cat "$META/image.id" 2>/dev/null || true)"
[ -n "$have" ] || exit 0                                  # no tree run yet on this volume (its first boot)
[ "$have" != "$want" ] || exit 0                          # the same image: nothing changes
if [ -e "$INSTALL_DIR/.code-sync-pending" ]; then say "a code sync was interrupted: no snapshot of a half-swapped tree"; exit 0; fi
if [ -e "$INSTALL_DIR/.seed-prev" ]; then say "an unapplied snapshot is kept (it still describes the tree that seeded the copies)"; exit 0; fi

tmp="$INSTALL_DIR/.seed-prev.tmp"
rm -rf "$tmp"
mkdir -p "$tmp" || exit 1
for d in seed-skills seed-scheduled-tasks scheduled-tasks i18n/en; do
  [ -d "$INSTALL_DIR/$d" ] || continue
  mkdir -p "$tmp/$(dirname "$d")" && cp -R "$INSTALL_DIR/$d" "$tmp/$d" || { rm -rf "$tmp"; say "WARN: the copy of $d failed; no snapshot"; exit 1; }
done
mv "$tmp" "$INSTALL_DIR/.seed-prev" || { rm -rf "$tmp"; exit 1; }
say "seed sources of ${have:0:12} kept for the refresh after the swap"
