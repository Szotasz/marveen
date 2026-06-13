# channel-reply-guard -- Stop hook

## Probléma

Egy Marveen ágens, amely csatornán (Telegram / Slack / Discord) kommunikál a felhasználóval, néha *generálja* a választ egyszerű szövegként, de elfelejti meghívni a csatorna küldő-eszközét. Amikor ez megtörténik, a válasz csak a CLI átiratban jelenik meg, és **soha nem jut el a felhasználóhoz** -- a felhasználó vár, fogalma sincs arról, hogy az ágens dolgozik-e vagy elakadt.

## Mit csinál a hook

A `scripts/channel-reply-guard.sh` a `Stop` eseményre fut. Minden forduló végén ellenőrzi:

1. Az **utolsó felhasználói üzenet csatornáról érkezett-e**? (Keresi a `<channel source="plugin:telegram...">` / `← telegram` jelölőket.)
2. Ha igen, volt-e **csatorna küldő-eszköz hívás** az üzenet után?
   (Bármely eszköz, amelynek neve tartalmazza a `telegram`, `reply`, `slack` vagy `discord` szót.)

Ha az üzenet csatornáról érkezett, de **nem hívtak küldő-eszközt**, a hook `{"decision":"block"}` döntést ad vissza egy emlékeztetővel, így a modell elküldi a választ, mielőtt a forduló véget ér.

A szívverés / ütemezett feladat promptok (ahol a csend helyes válasz) kifejezetten ki vannak zárva -- ezek küldés nélkül is befejeződhetnek.

## Hogyan engedélyezd

Add hozzá a `Stop` hook-okhoz a `.claude/settings.json`-ban (a meglévő Stop hook-ok mellé):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/scripts/channel-reply-guard.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

(Abszolút útvonalat használj, ha a `${CLAUDE_PROJECT_DIR}` nem elérhető a te beállításodban.)

A `settings.json` szerkesztése után nyisd meg egyszer a `/hooks` menüt (vagy indítsd újra a session-t), hogy a hook betöltődjön.

## Kapcsolat a #210-es PR-rel

A #210-es PR megakadályozza, hogy a sub-ágensek elloponják a Telegram pollert, és lehetővé teszi a szívveréseknek a közvetlen üzenetek megválaszolását -- ez a *bejövő* utat védi. Ez a hook a *kimenő* utat védi: garantálja, hogy az ágens válasza ténylegesen eljut a csatornán. A kettő egymást kiegészíti.
