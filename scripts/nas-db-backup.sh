#!/usr/bin/env bash
# Marveen tudas-mentes a NAS-ra (Synology Drive szinkronizalja a ~/Work-ot).
#
# MIT MENT: KIZAROLAG a store/claudeclaw.db -- kanban, memoria, napi naplo.
# MIT NEM: .env, dashboard-token, csatorna-tokenek, access.json.
#   Jozsi dontese 2026-08-05: "A NAS-ra csak az SQL adatbazis kerüljön." A kulcsok potolhatok,
#   a tudas nem -- es a ~/Work a laptopra IS szinkronizalodik, tehat nem csak a NAS latja.
#
# MIERT NEM EGYSZERU FAJLMASOLAS: az SQLite WAL-modban ket kiserofajlt hasznal (-wal, -shm).
#   Ha csak a fo fajlt masolnank, egy epp zajlo iras miatt HIANYOS lehet. A `VACUUM INTO`
#   egyetlen KONZISZTENS pillanatkepet ir ki, futo iras mellett is -- es nem nyulunk az elo fajlhoz.
#
# RETENCIO (Jozsi kerese): az utolso 7 nap MINDEN mentese + minden VASARNAPI mentes 6 honapra.
set -o pipefail
SRC="/Users/ceo/Marveen/store/claudeclaw.db"
DEST_DIR="$HOME/Work/Backup/Marveen-db"
TS="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"          # 7 = vasarnap
OUT="$DEST_DIR/claudeclaw-$TS.db"

[ -f "$SRC" ] || { echo "nas-backup: HIBA -- nincs forras adatbazis: $SRC"; exit 1; }
mkdir -p "$DEST_DIR" || { echo "nas-backup: HIBA -- nem hozhato letre: $DEST_DIR"; exit 1; }

# Konzisztens pillanatkep. A VACUUM INTO NEM erinti az elo fajlt.
sqlite3 "$SRC" "VACUUM INTO '$OUT'" || { echo "nas-backup: HIBA -- a VACUUM INTO elbukott"; exit 1; }

# ELLENORZES: nem eleg, hogy a parancs lefutott -- a KIMENETET nezzuk.
[ -s "$OUT" ] || { echo "nas-backup: HIBA -- a kiirt fajl URES: $OUT"; exit 1; }
KARTYAK="$(sqlite3 "$OUT" 'SELECT count(*) FROM kanban_cards' 2>/dev/null)"
EMLEKEK="$(sqlite3 "$OUT" 'SELECT count(*) FROM memories' 2>/dev/null)"
case "$KARTYAK" in ''|*[!0-9]*) echo "nas-backup: HIBA -- a masolat nem olvashato adatbazis"; exit 1;; esac
[ "$KARTYAK" -gt 0 ] || { echo "nas-backup: HIBA -- 0 kanban-kartya a masolatban"; exit 1; }

echo "nas-backup: wrote $OUT ($(du -h "$OUT" | cut -f1); $KARTYAK kartya, $EMLEKEK emlek)"

# --- RETENCIO ---
# 1) 7 napnal regebbi, NEM vasarnapi mentesek torlese
find "$DEST_DIR" -name 'claudeclaw-*.db' -mtime +7 -print0 2>/dev/null | while IFS= read -r -d '' f; do
  d="$(basename "$f" | sed -E 's/claudeclaw-([0-9]{8})-.*/\1/')"
  wd="$(date -j -f %Y%m%d "$d" +%u 2>/dev/null)"
  if [ "$wd" != "7" ]; then rm -f "$f"; echo "nas-backup: torolve (7 napnal regebbi, nem vasarnap): $(basename "$f")"; fi
done
# 2) 6 honapnal regebbi vasarnapi mentesek torlese
find "$DEST_DIR" -name 'claudeclaw-*.db' -mtime +183 -print0 2>/dev/null | while IFS= read -r -d '' f; do
  rm -f "$f"; echo "nas-backup: torolve (6 honapnal regebbi): $(basename "$f")"
done

echo "nas-backup: allomany most $(ls -1 "$DEST_DIR"/claudeclaw-*.db 2>/dev/null | wc -l | tr -d ' ') fajl"
