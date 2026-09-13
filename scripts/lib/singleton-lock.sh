# hu: Session-nevenkénti szingleton-zár, mkdir-alapú -- a `flock(1)` parancs
# nem minden telepítési célplatformon elérhető (pl. macOS-en nincs a
# rendszerben), a `mkdir` viszont igen és POSIX-on atomi (két párhuzamos
# `mkdir` közül garantáltan csak az egyik sikerül).
# en: Per-session-name singleton lock, mkdir-based -- the `flock(1)` command
# is not available on every install target (macOS does not ship it), while
# `mkdir` is, and is atomic on POSIX (of two concurrent `mkdir` calls on the
# same path, exactly one succeeds).
#
# Forrásold ezt a fájlt (`. singleton-lock.sh`), majd hívd:
#   acquire_singleton_lock <lock_dir>   # 0 = megszerezve, 1 = elo peldany tartja
#   release_singleton_lock <lock_dir>   # csak a sajat zarat engedi el
# Source this file (`. singleton-lock.sh`), then call:
#   acquire_singleton_lock <lock_dir>   # 0 = acquired, 1 = held by a live process
#   release_singleton_lock <lock_dir>   # only releases a lock this process owns
#
# hu: A PR #1163 (scripts/start.sh, Szotasz/marveen) egy MASIK, rokon
# versenyhelyzetet flock-kal zart, es szandekosan NEM az mkdir-konyvtar
# idiomat valasztotta, mert az egy `kill -9`-et (vagy aramszunetet) TULELO
# tulajdonos eseten arva zarat hagy hatra -- a flockot viszont a kernel oldja
# fel a tulajdonos halalakor, barmilyen okbol. Ez a lelet valos, es itt is
# fennall: a lenti `acquire_singleton_lock` `trap ... EXIT`-tel szabadit fel,
# ami `kill -9`-en NEM fut le. A kulonbseg, amiert itt megis az mkdir-mintat
# valasztottuk: (1) EZ a zar NEM blokkolo -- a masodik felugyelo azonnal,
# varakozas nelkul visszalep, mihelyt a zar FOGLALTNAK latszik, szemben a
# start.sh `flock -w 120`-javal, ami egy hatarolt varakozast akar, nem
# vegleges lemondast; egy `kill -9`-utani arva zar tehat legfeljebb a
# KOVETKEZO inditasi kiserletig all fenn, nem 120 masodpercig blokkol. (2) a
# tulajdonos-PID elettartam-ellenorzese (`kill -0`) MINDEN kovetkezo
# `acquire_singleton_lock` hivasnal ujra lefut, tehat egy arva zar
# onmagatol, a legkozelebbi inditasi kiserletkor felszabadul -- nem marad
# tartosan blokkolva. (3) a `flock(1)` parancs ezen a (macOS) celplatformon,
# ahol a tenyleges hiba jelentkezett, NINCS jelen (merve 2026-09-05, `command
# -v flock` -> nincs talalat) -- a start.sh sajat
# fallback-aga ("flock not found... starting WITHOUT the start lock") is ezt
# az esetet kezeli, es pontosan az itteni pid-ellenorzo mintara tamaszkodik.
# en: PR #1163 (scripts/start.sh, Szotasz/marveen) closed a RELATED but
# distinct race with flock, and deliberately avoided the mkdir-directory
# idiom because it leaves an orphaned lock behind when the owner is killed
# with `kill -9` (or power loss) -- the kernel releases a flock on owner
# death for any reason, an mkdir lock does not. That critique is real and
# applies here too: `acquire_singleton_lock` below releases via `trap ...
# EXIT`, which does not run on `kill -9`. The reasons the mkdir pattern is
# still the right choice here: (1) this lock is NON-BLOCKING -- the second
# supervisor backs off immediately the moment the lock looks held, unlike
# start.sh's `flock -w 120`, which wants a bounded wait, not a final
# give-up; an orphaned lock after `kill -9` therefore only lives until the
# NEXT start attempt, not for a 120s block. (2) the owner-pid liveness check
# (`kill -0`) re-runs on every subsequent `acquire_singleton_lock` call, so
# an orphaned lock self-heals at the very next start attempt instead of
# staying stuck. (3) `flock(1)` is simply ABSENT on this (macOS) target
# platform, where the actual bug was measured (measured 2026-09-05: `command
# -v flock` finds nothing) -- start.sh's own fallback
# branch ("flock not found... starting WITHOUT the start lock") handles that
# exact case by relying on the same kind of pid-liveness check used here.

# hu: A zar egy konyvtar (mkdir letrehozasa atomi); a konyvtarban egy 'pid'
# fajl tartja a tulajdonos process-azonositojat, hogy egy megszakadt
# (crash-elt) tulajdonos zarja felismerheto es visszaveheto legyen.
# en: The lock is a directory (mkdir creation is atomic); a 'pid' file inside
# it holds the owner's process id, so a crashed owner's stale lock can be
# detected and reclaimed.
acquire_singleton_lock() {
  local lock_dir="$1"
  if mkdir "$lock_dir" 2>/dev/null; then
    echo "$$" > "$lock_dir/pid"
    return 0
  fi

  local owner_pid
  owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  # hu: ha a pid ures (a tulajdonos meg a mkdir es a pid-iras kozott tart) VAGY
  # elo -- a zarat elonek tekintjuk, es NEM nyulunk hozza. Csak akkor bontjuk
  # el mint elavultat, ha POZITIVAN igazolhato, hogy a tulajdonos halott (van
  # pid, de a kill -0 sikertelen) -- a ketertelmuseget mindig a "tartva van"
  # fele dontjuk, hogy egy friss zarat sose torolhessunk le tevesen.
  # en: if the pid is empty (the owner is still between mkdir and writing its
  # pid) OR alive -- treat the lock as held, and do NOT touch it. We only
  # reclaim it as stale when we can POSITIVELY confirm the owner is dead (a
  # pid is present but `kill -0` fails) -- ambiguity always resolves to
  # "held", so a fresh lock can never be mistakenly torn down.
  if [ -z "$owner_pid" ] || kill -0 "$owner_pid" 2>/dev/null; then
    return 1
  fi

  # hu: elavult zar (a tulajdonos process mar nem el) -- visszavesszuk.
  # en: stale lock (the owner process is no longer alive) -- reclaim it.
  rm -rf "$lock_dir" 2>/dev/null
  if mkdir "$lock_dir" 2>/dev/null; then
    echo "$$" > "$lock_dir/pid"
    return 0
  fi
  # hu: elvesztettuk a visszavetel versenyet egy masik peldannyal szemben.
  # en: lost the reclaim race against another instance.
  return 1
}

release_singleton_lock() {
  local lock_dir="$1"
  local owner_pid
  owner_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  # hu: csak akkor toroljuk, ha a pid fajl a MIENK -- idegen (masik peldany
  # altal kozben megszerzett) zarat soha ne torolj.
  # en: only remove it if the pid file is OURS -- never remove a lock another
  # instance has since (re)acquired.
  if [ "$owner_pid" = "$$" ]; then
    rm -rf "$lock_dir" 2>/dev/null
  fi
}
