#!/bin/bash
# Master hook-szinkronizáló script. Minden install-*-hook.sh-t lefuttat a
# scripts/ mappából. Az update.sh-ből hívva auto-deploy-olja az aktuális
# hook-csomagot minden Béla-szerű Marveen-rendszerre a dashboard
# Frissítés gomb-jával.
#
# Pattern: a scripts/install-*-hook.sh egyenkénti shell-szkriptek
# idempotensek és exit 0-val térnek vissza akkor is ha már telepítve van.
# Új hook-féle védelmet hozzáadni: csinálj egy install-XXX-hook.sh-t és
# commit-old; a következő update auto-futtatja.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Glob — ha nincs match, hagyjuk (shopt nullglob bash 4+ kell, de set -u
# kontextusban óvatosan; egyszerűbb: explicit for-loop test-tel).
for installer in "$SCRIPT_DIR"/install-*-hook.sh; do
  [ -e "$installer" ] || continue
  echo "→ $(basename "$installer")"
  bash "$installer" || echo "  ⚠ $(basename "$installer") nem-nulla exit kóddal lépett ki (folytatjuk)"
done

echo "✓ Hook szinkronizálás kész."
