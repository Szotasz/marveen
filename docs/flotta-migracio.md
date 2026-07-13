# Flotta migráció (export / import)

> Egyetlen hordozható JSON a teljes flottáról, amivel gépek között lehet átköltözni anélkül, hogy minden ügynököt és memóriát kézzel kellene újrakonfigurálni.

---

## Mit csinál a teljes flotta migráció?

Egyetlen hordozható JSON-t készít a teljes flottáról, amit egy friss telepítésre be lehet tölteni. Segítségével gépek között lehet átköltözni anélkül, hogy az összes ügynököt és memóriát kézzel kellene újrakonfigurálni.

## Mit visz magával az export?

- Fő ügynök persona: CLAUDE.md, SOUL.md, agent-config.json, beállítások, csatorna-párosítás
- Al-ügynökök: teljes konfiguráció, személyiség, csatornák, képek
- Memóriák: az összes ügynök memóriabejegyzése (fő ügynök és al-ügynökök)
- Napi napló bejegyzések
- Skillek: globális és ügynök-szintű
- Ütemezett feladatok (szüneteltetve: enabled=false érkeznek)
- Kanban tábla: kártyák, kommentek, címkék
- Ötletláda (idea box)
- Dashboard beállítások (autonómia, auto-restart, preferenciák)
- Vault (opcionális, jelszóval): MCP-szerver titkok, API kulcsok

## Mit NEM visz magával?

- Csatorna bot-tokenek (Telegram stb.): a párosítás-config (allowlist, policy) átmegy, de a bot-token NEM. A célgépen újra kell párosítani. Ez szándékos: két élő példány ugyanazzal a bottal ütközne (a forrás bot elnémulna, dupla üzenetek)
- Google/Gmail/Calendar OAuth bejelentkezések: a célgépen újra kell hitelesíteni
- Dashboard-token: a célgép saját tokenjét kell használni
- Forráskód és build-eredmények: a normál telepítésből jönnek (npm ci, npm run build)
- Telemetria, session-logok, conversation-history

## Dry-run biztonság

Az "Ellenőrzés" gomb csak beolvassa a fájlt és megmutatja, mi jönne létre, de nem ír semmit a rendszerbe. Az "Apply" gomb csak a dry-run után érhető el, és egy megerősítési lépéssel véd a véletlen felülírás ellen.

## Vault jelszó szerepe

Ha az exportnál megadsz jelszót, a TELJES export JSON egyetlen titkosított blobbá válik (scrypt+AES-256-GCM), így minden titok egyben védve van. Importáláskor ugyanezt a jelszót kell megadni, az import automatikusan felismeri a titkosított fájlt. Rossz jelszónál nem ír semmit.

Jelszó nélkül az export garantáltan titok-mentes: a rendszer kiszűri a titkokat, és ha bármi titkosítatlan titok bennmaradna (pl. egy MCP-token), hibát dob az export helyett hogy kiszivárogtatná.

## Fő ügynök identitása (import után)

Import után a cél rendszer ÁTVESZI a forrás fő ügynökének identitását: a fő ügynök neve a forrásé lesz, és minden adata is a forrás nevén marad. Ez azért kell, hogy a memóriák, naplók és a sub-agentek CLAUDE.md-hivatkozásai konzisztensek maradjanak, semmit nem kell kézzel átnevezni. A rendszer generikus: bármi is a forrás fő ügynökének neve, azt veszi át.

A beállítás a `store/config-overrides.json`-ba íródik (fő ügynök azonosító, megjelenített név, brand, tulajdonos), és a dashboard ÚJRAINDÍTÁSA után lép életbe. Az apply után az import figyelmeztet erre.

## Lépéssor

1. A régi gépen: Export, opcionálisan vault jelszóval. Mentsd el a JSON-t.
2. Az új gépen: telepítsd a dashboardot (git clone, npm ci, npm run build, indítás).
3. Tallózd be a JSON-t, add meg a vault jelszót (ha volt), futtasd az Ellenőrzést.
4. Ellenőrizd a dry-run összefoglalót: ügynökök, memóriák, kanban számai és a felülírás-figyelmeztetések helyesek-e.
5. Végrehajtás (apply): az ügynökök, memóriák és beállítások beírva, a cél átveszi a forrás fő ügynökének identitását.
6. Indítsd újra a dashboard szolgáltatást (service restart), hogy a fő ügynök az átvett identitáson induljon.
7. Csatornák: párosítsd újra a Telegram (stb.) botokat a célgépen.
8. Hitelesítsd újra az OAuth-kapcsolatokat (Gmail, naptár stb.).
