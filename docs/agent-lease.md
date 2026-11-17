# Ideiglenes ügynök-bérlet

## 🎯 Mit tud

A gazda egy időkorlátos engedélyt ad (bérlet), amíg az él, a fő ügynök gazda-belépés nélkül létrehozhat, futtathat és törölhet eldobható teszt-ügynököket, **helyi modellen**. Lejáratkor vagy visszavonáskor minden ügynök, ami a bérlet alatt jött létre, leáll és törlődik.

**Ki adhatja, nézheti, vonhatja vissza:** csak a gazda, a dashboard-jelszóval bejelentkezve (`mayActAsOwner`). Az első indítás előtti kivétel (first-run) erre nem vonatkozik: a bérlet a közös tokennek szóló engedély, tehát a közös token sosem adhat magának.

**Mit enged a bérlet a közös tokennek (és semmi mást):**
- **Létrehozás** (`POST /api/agents`), ha MIND teljesül:
  - a név `tmp-` kezdetű;
  - van `customProvider`, és annak a base URL-jében a host **loopback**: `localhost`, egy `127.x.x.x` cím vagy `::1`. Nem számít helyinek: `0.0.0.0`, LAN-cím, `*.localhost`, vagy egy név, ami csak loopbackre oldódik fel;
  - a biztonsági profil `lease-sandbox` (ha a kérés mást kér, 403; ha nem kér semmit, ez lesz);
  - a bérlet alatti létrehozások száma legfeljebb `maxAgents`. A törölt ügynök NEM ad vissza helyet, így egy létrehoz-töröl hurok nem tudja végtelenül értesítésekkel bombázni a gazdát.
- **Törlés** (`DELETE /api/agents/:name`): csak az a `tmp-` ügynök, amit az ÉPPEN aktív bérlet hozott létre.
- **Indítás, leállítás:** ezek eddig is a közös tokennel mentek, a bérlet ezen nem változtat.

Minden más gazda-művelet marad: csatorna-beállítás, párosítás, trust, plan, MCP, profil, persona (CLAUDE.md/SOUL.md), provider. A bérlet ezeket nem nyitja.

**Melyik token:** csak a közös token (`store/.dashboard-token`, `kind: 'token'` `tokenAgent` nélkül). Egy al-ügynök saját tokenje nem élhet vele (a kapu engedélylistája amúgy sem engedi a `POST /api/agents`-et neki), és egy eszközkulcs, peer vagy operator sem.

## Hol

- **Dashboard:** Csapat oldal, a fejléc alatt: perc (1-60, alap 60), max ügynök (1-3, alap 3), Bérlet indítása; aktív bérletnél állapot és Visszavonás gomb. Csak a gazda-session látja.
- **API:**
  - `GET /api/agent-leases` -> `{ active, lease }`;
  - `POST /api/agent-leases {"minutes": 1-60, "maxAgents": 1-3, "note": "..."}`; ha már van aktív, 409;
  - `DELETE /api/agent-leases/current` -> visszavonás, ugyanaz a takarítás, mint lejáratkor.
- **Állapot:** `store/agent-lease.json` (az aktuális vagy az utolsó bérlet, atomikus írással).

## 🛠 Hogyan működik

- **A `lease-sandbox` profil** (`templates/profiles/lease-sandbox.json`) a legszűkebb: strict mód, csak a saját mappáját olvashatja és írhatja (`Read`/`Edit` az `${AGENT_DIR}` alatt); minden más eszközhívás engedélyt kérne, amit nem-interaktív ügynökben senki nem ad meg. Tiltva: `WebFetch`, `WebSearch`, `curl`, `wget`, `ssh`, `scp`, `nc`, `sudo`, `rm`, `sendmail`, `mail`, `git push`, a `store/` (benne a dashboard-token), az al-ügynök tokenek, a `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude` és a `.env` fájlok olvasása. A flotta alap-deny listája (egress, sudo stb.) erre is rákerül.
- **Létrehozáskor** a bérlet-ügynök `.mcp.json`-ja üres (`{"mcpServers": {}}`), a persona sablon (nincs Claude-hívás), és nem megy csapat-üdvözlés.
- **A hely foglalása** szinkron, közvetlenül a könyvtár létrehozása előtt: két egyidejű kérés nem viheti el ugyanazt az utolsó helyet, és egy közben lejárt bérlet nem ad semmit.
- **Lejárat:** a dashboard percenkénti tickje (`web.ts`, a desktop-lock sweeper mellett) ellenőrzi, és minden bérlet-kapus kérés is előbb lefuttatja. A takarítás előbb lezárja a bérletet (onnantól nem enged semmit), aztán ugyanazon az úton törli az ügynököket, mint a kézi törlés (`removeAgentCompletely`: desired-state, session leállítás, könyvtár, csapat-hivatkozások). Ami nem törölhető, a bérleten "nem törölt" marad, a dashboard kiírja, és a gazda értesítést kap.
- **Napló és értesítés:** config-napló sor minden eseményre (`agent_lease.create`, `agent_lease.create_agent`, `agent_lease.delete`, `agent_lease.expired`, `agent_lease.revoked`); a gazda egy értesítést kap ügynökönként a létrehozásról és a törlésről (`notifyOwner`).

## ⚠️ Őszinte korlát

**A bérlet nem hitelesít.** A közös token minden, ugyanazon OS-felhasználóval futó folyamat számára olvasható, tehát amíg a bérlet él, BÁRMELYIK ügynök (vagy folyamat), amelyiknél a közös token van, élhet vele, nem csak a fő ügynök. A terv ezért a kárt korlátozza, nem a hívót azonosítja:
- rövid élet (legfeljebb 60 perc) és kevés ügynök (legfeljebb 3 létrehozás bérletenként);
- csak helyi provider és a zárt profil, csatorna, MCP, levelezés és web nélkül;
- csak a saját `tmp-` ügynökei törölhetők, más ügynökhöz a bérlet nem nyúl;
- minden használatról értesítés megy, és lejáratkor minden eltakarodik;
- a bérlet bármikor visszavonható a dashboardról.

**Mitől nem véd:**
- A "loopback" nem jelenti, hogy a modell tényleg helyi: egy localhoston futó proxy (pl. LiteLLM) továbbíthat fizetős felhőmodellhez. Ezt a provider-regiszter dönti el, amit csak a gazda írhat.
- Ha a helyi providerhez vault-kulcs tartozik, a bérlet-ügynök indításkor megkapja.
- Attól, aki a gépen shellt kapott: ugyanaz az OS-felhasználó a bérlet nélkül is mindent elér. A bérlet a dashboard API-n át adható jogot szűkíti és naplózza, nem sandbox.
- A strict profil a Claude Code engedély-motorján múlik; egy engedélykérést a tmux-panelen kézzel jóvá lehet hagyni.
