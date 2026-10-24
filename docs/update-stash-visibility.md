# Update auto-stash: beragadt munka láthatóvá tétele

## A probléma

Az `update.sh` auto-stash módja (`AUTO_STASH=1`, a dashboard "Frissítés stash-elve"
gombja) a frissítés előtt `git stash push -u`-val félreteszi a lokális változásokat,
és a frissítés után visszateszi őket. Ha a pop KONFLIKTUSBA fut (az upstream ugyanazt
a fájlt módosította), vagy a futás a pop előtt meghal, a stash bejegyzés a listában
marad, a working tree az upstream-állapoton áll, és erről csak a detached log egy
figyelmeztető sora szól, amit senki nem olvas. A `push -u` miatt a trackeletlen
fájlok ilyenkor a lemezről is eltűnnek a stash-be.

Mért eset (2026-10-05): egy pop-konfliktus öt napra, nyom nélkül eltüntetett egy kész,
nem commitolt fejlesztést; a stash-listában közben több hónapnyi régi auto-stash ült.

## A megoldás két rétege

1. **`update.sh`**: mindkét pop-hiba ág beállítja a `RESULT_MSG`-et, így a
   `store/update.last-result` (és a `/api/updates/status`) nevesíti a beragadt
   stash-t a korai-kilépés útvonalon.
2. **`scripts/infra_selfcheck.py`** (új, ütemezőből futtatandó önellenőrzés):
   a 30 percnél régebben a listában ülő `marveen-update-auto-stash` bejegyzésről
   egyszeri (bejegyzésenként egyszer küldött) Telegram-riasztást ad a tulajdonosnak.
   Ez a frissítés korai halálát is fogja, nem csak a pop-konfliktust. Emellett
   figyeli a settings.json hook-regisztrációk épségét (érvénytelen JSON = minden
   hook némán halott) és a channel-keepalive jelzőfájl frissességét.

## Telepítés / konfiguráció

A selfcheck ütemezőből fut (macOS: launchd `StartInterval` 300; Linux: cron),
model-token nélkül. Beállításai a telepítés `.env`-jéből jönnek:

- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` -- riasztási cél; bármelyik
  hiányában a script fut és állapotot ír, csak nem küld.
- `SELFCHECK_EXTRA_LAUNCHD=label1,label2` -- telepítés-specifikus launchd
  szolgáltatások, amiket a futás-ellenőrzés számon kér (az alap: channels,
  dashboard, channel-keepalive-probe).
- `SELFCHECK_MIN_GLOBAL_HOOKS` / `SELFCHECK_MIN_PROJECT_HOOKS` -- a hook-darabszám
  egészséges alapvonala, ha a telepítés pinnelni akarja (alapértelmezés: 1).

Állapot: `store/.infra-selfcheck-state.json` (anti-spam: ugyanaz a lelet 6 óránként
legfeljebb egyszer; a stash-riasztás bejegyzésenként egyszer megy ki, a state
`stash_alerted` listája tartja nyilván).
