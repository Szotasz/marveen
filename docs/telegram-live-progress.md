# Élő Telegram visszajelzés (gondolkodásjelző + bővebb napló)

> Amíg az ügynök dolgozik, ne kelljen találgatni. Ugyanaz látszik Telegramon,
> ami a terminálban.

Kiegészíti a [telegram-progress-indicator](telegram-progress-indicator.md)
placeholder+watchdog rendszerét: az ott leírt hookok diszkrét pontokon futnak, ez
viszont **folyamatosan frissül**, tehát egy hatperces körben is életben marad.

## Két, egymástól független csatorna

| | Mit mutat | Élettartam |
|---|---|---|
| **jelző** | `✻ Incubating… (3m 44s · ↓ 13.1k tokens)` | egyetlen üzenet, élőben szerkesztve, a kör végén **törlődik** |
| **bővebb napló** | az ügynök látható gondolatmenete lépésenként | normál üzenetek, **megmaradnak** |

A jelző nem újraszámol semmit: a Claude Code saját státuszsorát tükrözi, így a
token-számláló és a "shell / sub-agent még fut" állapot is pontosan az, amit a
gép előtt ülve látnál.

## Módok

```bash
scripts/progress-mode.sh                    # mi az aktuális állás
scripts/progress-mode.sh verbose            # a fő ügynökre
scripts/progress-mode.sh indicator liebig   # egy adott ügynökre
```

- `silent` -- semmi nem megy Telegramra
- `indicator` -- csak az eltűnő jelző
- `verbose` -- jelző + a gondolatmenet megmaradó üzenetekben

A váltás a következő ciklusban (~2 mp) érvényes, újraindítás nem kell.

## Elakadás-jelzés

Ha az ügynök munkamenete **meghal a kör közepén** (összeomlás, újraindítás,
beragadás), a jelző NEM tűnik el csendben, hanem átalakul:

> ⚠️ A munkamenet leállt munka közben, ez a válasz nem fog megérkezni. Küldd el újra a kérést.

Ez a rendszer legfontosabb része. A néma kudarcnál nincs rosszabb: a tulajdonos
egy olyan válaszra vár, ami már nem létezik, és neki kell rájönnie.

## Felépítés

```
scripts/telegram-live-progress.py     a daemon
scripts/progress-mode.sh              mód-kapcsoló
store/progress-config.json            ügynökönkénti mód + chatId
store/progress-live-state.json        futó jelző üzenet-id-k, transcript offsetek
store/progress-live.log               napló
~/.config/systemd/user/marveen-progress.service
```

```bash
systemctl --user status marveen-progress
tail -f store/progress-live.log
```

## Buktatók

- **A pörgő státuszsor nem minden képkockán látszik.** Ha csak arra szűrsz, egy
  aktívan dolgozó ügynök üresnek látszik, és a jelző villog. A megbízható kapu az
  alsó sáv `esc to interrupt` szövege; a részletes sor csak kiegészítés.
- **A jelző törlése előtt kell egy debounce** (2 üres ciklus), mert a státuszsor
  eszközhívások között pillanatokra eltűnik.
- **`silent`-re váltás közben** a már kint lévő jelzőt törölni kell, különben egy
  befagyott "gondolkodom" üzenet marad a chatben.
- **A bővebb napló duplázhat**: amit az ügynök gondolatként leír, azt sokszor
  válaszként is elküldi. Ezért a napló kiszűri azokat a szövegeket, amiket a
  reply eszköz is elküldött ugyanabban a körben.
