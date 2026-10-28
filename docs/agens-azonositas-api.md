# Hívó-ágens azonosítása a dashboard API-n

Kanban #29c8cf33 (leválasztva a #27ab6a18-ról). Készítette: leandev, 2026-09-14.
Ez TERVEZÉSI dokumentum, nem megvalósítás. A választás lean-chief / István döntése,
mert az autentikációs modell megváltoztatása felügyeleti mechanizmus.

## 1. A kérdés

A `PUT /api/memories/<id>` és a `DELETE /api/memories/<id>` ma nem tudja
megállapítani, MELYIK ágens hívta, ezért a tulajdonos-ellenőrzés
("idegen ágens emlékét írod felül") nem kényszeríthető ki.

## 2. Amit MEGMÉRTEM (2026-09-14, ezen a telepítésen)

| # | Mérés | Eredmény | Mivel |
|---|-------|----------|-------|
| 1 | Autentikációs sávok | `token` / `device` / `federation` / `session` / `none` | `src/web/auth-gate.ts` |
| 2 | A közös token hivatkozásai | **119 fájl, 321 előfordulás** (node_modules, dist, .git nélkül) | `grep -rl '\.dashboard-token'` |
| 3 | Az ágensek UNIX-felhasználója | **mind uid 1000 (`istvan`)**, 15 folyamat | `ps -eo user,uid` |
| 4 | A token fájl jogosultsága | `-rw------- istvan:istvan` | `stat -c '%A %U:%G'` |
| 5 | Ágens-könyvtárak | `drwxrwxr-x istvan:istvan` — minden ágens olvassa a másikét | `ls -ld agents/*/` |
| 6 | Titok-tár (vault) | **nincs telepítve** (`store/vault.json`, `store/.vault-key` hiányzik) | `stat` |
| 7 | OS-szintű kulcstartó | `isKeychainAvailable()` → csak `darwin`; ez a gép Linux/WSL2 | `src/web/keychain.ts:19` |
| 8 | Az auth-eredmény eljut-e a route-okig | **IGEN**, `ctx.auth` már létezik | `src/web/routes/types.ts:24` |
| 9 | Van-e megbízható helyi ágens-azonosító | **IGEN, a hook-rétegben**: `ledger_lib.agent_id_from_cwd(payload.cwd)` | 8+ hook használja |
| 10 | Env-injektálás ágens-indításkor | **létezik**: `export ANTHROPIC_API_KEY="..." && ...` | `src/web/agent-process.ts:1399` |
| 11 | Mért kockázat (2026-09-13..14) | 8 romboló hívás, ebből **0 idegen-emlék írás**, 6 a fő-ágenstől | `tool_call_log` |
| 12 | Másik ágens folyamatának környezete | `/proc/<pid>/environ` **olvasható** (48 bejegyzés; tartalmat nem írtam ki) | `test -r` |
| 13 | Másik ágens fájljai | `agents/leanscout/CLAUDE.md`, `agents/leanwriter/CLAUDE.md` **olvasható** | `test -r` |

### Meglévő előzmények a kódban (nem kell nulláról tervezni)

- **`device_keys`** (`src/web/auth-device-keys.ts`): per-eszköz Bearer kulcs,
  `mvdk_` prefixszel, csak `sha256(kulcs)` tárolva, egyenként visszavonható,
  **nulla sor = a funkció ki van kapcsolva**. Ez pontosan a kívánt alakú gépezet.
- **Föderációs per-peer tokenek**: végpont-hatókörrel korlátozott azonosítás.
- **`POST /api/messages` `from`-ellenőrzése** (`routes/messages.ts:128`): a `from`
  a hívó SAJÁT állítása, a szerver csak azt nézi, létező ágens-e. A kód kommentje
  maga mondja ki: *"This is not impersonation-proof between fleet agents (they
  share the same token)"*. Ez a mostani kérdés már megválaszolt, kicsiben.

## 3. A KÖZPONTI KÖVETKEZTETÉS

**Az azonosítás nem egyenlő a kikényszerítéssel, és ezen a telepítésen a kettő
nem is hozható össze pusztán kód-változtatással.**

Mind a hét ágens ugyanazzal a UNIX-felhasználóval fut (3. mérés), a fájlok
egymás számára olvashatók (5. mérés), OS-szintű titok-tár nincs (6-7. mérés).
Ebből következik: **bármilyen fájlban vagy környezeti változóban tárolt
per-ágens hitelesítőt bármelyik másik ágens el tud olvasni** (a 12. mérés szerint egy másik ágens `/proc/<pid>/environ`-ja
olvasható). Egy elszánt vagy kompromittált ágens
tehát bármelyik séma mellett a másik nevében tud hívni.

Amit az azonosítás EL TUD érni:
- **attribúció** (ki írta felül) — ma ez sincs meg;
- **baleset-megelőzés / poka-yoke** — a mért kockázat pontosan ez (11. mérés:
  0 rosszindulatú, a #27ab6a18 kiváltó esete egy *képesség-próba* volt, nem támadás);
- **granuláris visszavonás** (egy ágens kulcsának letiltása a flotta megbénítása nélkül);
- **per-ágens korlátozás** (rate limit, végpont-hatókör).

Amit NEM tud elérni OS-szintű elkülönítés nélkül:
- **kikényszerítés hamisítással szemben**.

Ezt azért kell kimondani, mert ha a tulajdonos-szabály "megvédettnek" látszik,
akkor a védelem hamis biztonságérzetet ad — és a #27ab6a18 egész tanulsága az
volt, hogy a poka-yoke (verziózás) többet ér, mint a kapu, ami megkerülhető.

## 4. Három lehetőség

### A) `X-Agent-Id` fejléc a meglévő közös token mellé
- **Mit ad**: önbevallott azonosítás. A route látja, ki állítja magáról, hogy hívott.
- **Erő**: hamisítás ellen **nulla**; baleset ellen **teljes** (aki elgépel vagy
  próbál, az a saját nevét küldi, nem hazudik).
- **Költség**: kicsi. `AuthResult`-ba egy `agent?: string` mező, a `ctx.auth`
  vezeték már megvan (8. mérés). Additív: fejléc nélkül minden hívó a mai módon
  működik tovább, a 119 fájlból **egyet sem kötelező** átírni.
- **Kockázat**: a mező "azonosításnak" látszhat. Ezért a szerver-oldali kezelés
  KÖTELEZŐEN `warn`-szintű legyen, és a hibaüzenet mondja ki, hogy önbevallott.

### B) Per-ágens token (`mvak_` prefix), a `device_keys` gépezetére építve
- **Mit ad**: az azonosság titok, nem állítás. Egy ágens csak akkor tud a másik
  nevében hívni, ha ELMEGY a másik kulcsáért — ez már szándékos lépés, nem baleset.
- **Költség**: közepes. Kulcs-mintázás ágens-létrehozáskor; kiosztás az indító
  sorban ugyanúgy, ahogy az `ANTHROPIC_API_KEY` megy (10. mérés); a
  `store/.dashboard-token` idióma lecserélése a flotta CLAUDE.md-jeiben.
- **Buktató, amit meg kell oldani**: az indító sor `export X="..." && claude`
  alakú, tehát a kulcs megjelenik a shell parancssorában (és így a `ps`
  kimenetében). Ez a mai `ANTHROPIC_API_KEY`-re is igaz — meglévő minta, de nem
  jó minta; per-ágens fájl (`agents/<n>/.agent-token`, 0600) tisztább.
- **Migráció**: additív, a `device_keys` mintájára — **nulla kulcs = kikapcsolva**,
  a közös token továbbra is működik, csak `kind: 'token'` (azonosítatlan) marad.

### C) Valódi elkülönítés: külön UNIX-felhasználó ágensenként
- **Mit ad**: kernel által garantált azonosítás (fájljogosultság, `SO_PEERCRED`),
  tehát tényleges **kikényszerítés**.
- **Költség**: nagy, és túlmutat a kódon: felhasználó-létrehozás, a közös
  `store/` és `agents/` jogosultsági modelljének átszabása, tmux/systemd
  átalakítás. Ez üzemeltetési döntés, nem fejlesztési feladat.
- **Mikor indokolt**: ha a fenyegetés-modell megváltozik arra, hogy egy ágens
  kompromittálódhat. Ma a mért adat ezt nem támasztja alá (11. mérés).

## 5. AJÁNLÁS

**Most: A) opció, `warn`-szinten.** Indok: a mért kockázat baleset (0 rosszindulatú
eset 8 romboló hívásból), és az A pontosan a baleseteket fogja meg, közel nulla
költséggel és nulla migrációval. A `/api/messages` `from`-ellenőrzése ugyanezt az
utat járta be, és bevált.

**Majd: B) opció, ha lesz egy MÁSODIK ok is** rá — per-ágens rate limit, egy ágens
hozzáférésének visszavonása, vagy külső (nem-flotta) hívó megjelenése. Önmagában a
tulajdonos-szabályért nem éri meg a 119 fájlos idióma-váltás.

**C) csak fenyegetés-modell-változásra**, és az István döntése.

**Amit semmiképp**: a `body.agent_id` mezőt tulajdonos-azonosításra használni. Az
a mező azt jelenti, hogy "írd át a tulajdonost", szokásos szerkesztésnél nincs is
jelen, és ugyanúgy a hívó saját állítása lenne — csak épp egy olyan mező, aminek
már van más jelentése. Ez a legrosszabb kombináció: hamisítható ÉS félreérthető.

## 6. Ha az A) opcióra esik a döntés — a konkrét munka

1. `src/web/auth-gate.ts`: `AuthResult`-ba `{ kind: 'token'; agent?: string }`,
   az `X-Agent-Id` fejlécből, `sanitizeAgentIdent` + `isKnownAgent` szűréssel
   (ismeretlen név → a mező eldobva, nem 403; a hívás ma is érvényes).
2. `src/web.ts:161` körül: a `ctxAuth` `token` ágába átvezetni.
3. `src/web/routes/memories.ts`: a PUT/DELETE meglévő őrében, a 409-es ág mellé:
   ha `ctx.auth.agent` megvan ÉS `!== before.agent_id`, akkor `logger.warn` +
   a válaszba egy `owner_mismatch` jelzés — **blokkolás nélkül**, és a szöveg
   mondja ki, hogy önbevallott azonosításon áll.
4. A flotta CLAUDE.md-jeibe egy sor: a memória-hívásokhoz `-H "X-Agent-Id: <sajat>"`.
5. Teszt: az `auth-gate.test.ts` a flotta-regressziós szerződés — a meglévő
   Bearer-sáv bájtra változatlan kell maradjon.

Becsült méret: ~1 fájl-csoport, a meglévő tesztkészlettel ellenőrizhető.

## 7. Megvalósítás (2026-09-14, lean-chief döntése: A) opció)

Leszállítva, az 5 lépés szerint:

| Lépés | Fájl | Mi lett |
|-------|------|---------|
| 1 | `src/web/auth-gate.ts` | `AuthResult`: `{ kind: 'token'; agent?: string }`; `resolveAgentClaim()` — `X-Agent-Id`, 64 karakteres vágás a fs-hívás ELŐTT, `sanitizeAgentIdent` + `isKnownAgent`, hibás igény esetén **eldobás, nem 403** |
| 2 | `src/web.ts` | a `ctxAuth` `token` ága továbbadja az `agent`-et |
| 2b | `src/web/routes/types.ts` | `ctx.auth.agent`, a doc-kommentben kimondva, hogy önbevallott |
| 3 | `src/web/routes/memories.ts` | `ownerMismatch()` + `ownerMismatchPayload()`; PUT és DELETE `logger.warn` + `owner_mismatch` a 200-as válaszban. **Blokkolás nincs.** |
| 4 | `src/web/agent-scaffold.ts` | `ensureAgentIdHeaderSection()` — generált CLAUDE.md-blokk, ugyanaz az öt-szabályos idempotencia-szerződés; hívva `agent-process.ts`-ből (minden respawn) és `web.ts`-ből (fő-ágens) |
| 5 | `src/__tests__/auth-gate.test.ts`, `memories-destructive-write.test.ts` | +9 és +7 teszt |

Tervezési döntések, amelyek a kódolás közben dőltek el:

- **A `shared` tier NEM kivétel.** Egy megosztott emléknek is van szerzője, és
  nyolc ágens olvassa, amit ráírnak.
- **A 409-es kapu előbbre való a figyelmeztetésnél.** Ha egy idegen hívó
  destruktív felülírást kísérel meg, 409 jön, nem 200 + `owner_mismatch`.
- **A gazdátlan sor ága holt kód.** A `memories.agent_id` **NOT NULL**
  (`src/db.ts:264`), tehát minden sornak van tulajdonosa; a `!row.agent_id`
  ellenőrzés üres sztringre véd, nem támogatott állapotra. Ezt teszt rögzíti,
  nem komment.

## 8. A B) opció megvalósítása: `AGENT_TOKENS` (opt-in)

A 6-7. fejezet A) opciója (önbevallott `X-Agent-Id`) változatlanul marad. A B) opció mellé
került, **alapból kikapcsolva**. A 3. fejezet következtetése továbbra is áll: ez balesetek
ellen véd, nem egy elszánt ügynök ellen. Minden ügynök ugyanazzal a UNIX-felhasználóval fut,
és a közös `store/.dashboard-token` olvasható marad.

Mit csinál bekapcsolva (`AGENT_TOKENS=1`, `.env` vagy a Beállítások oldal):

| Hol | Mi történik |
|-----|-------------|
| al-ügynök létrehozása és minden indítása | `agents/<név>/.dashboard-token` (0600, véletlen, idempotens). Az al-ügynök CLAUDE.md-jében a közös token abszolút útja erre cserélődik, és egy MÁSIK ágens token-fájlára mutató abszolút út is (egy `cp -r`-rel másolt mappa a testvére fájlát nevezi meg), a generált blokkok is erre mutatnak. A fő ügynök és a heartbeat-worker nem kap saját tokent. |
| `src/web/agent-tokens.ts` | a szerver a bemutatott tokent ágens-névre képezi (időzítés-biztos összevetés, 5 mp-es cache). Szimlinket, rövid vagy a fő tokennel azonos tartalmú fájlt nem fogad el. Azt az értéket, amelyet egynél több ágens fájlja tartalmaz (pl. `cp -r`-rel másolt mappa), EGYIKÜKNEK sem fogadja el; a következő indítás az ismétlődő értéket újra cseréli. Az SSE pane-stream `?token=` paraméterében al-ügynök tokent nem fogad el. |
| `src/web/auth-gate.ts` `gateRequest` | a saját tokenes hívó (`ctx.auth.tokenAgent`) csak az `AGENT_TOKEN_ALLOWLIST` végpontjait éri el (üzenetek, kanban, memória, napi napló, jóváhagyás kérése/lekérdezése/felhasználása, ütemezések és vault OLVASÁSA, a hook-végpontok); minden más 403 `agent-token-scope`. Ütemezést nem írhat (403 `schedule-writes-main-agent-only`). |
| ugyanott, `AGENT_IDENTITY_BINDINGS` | minden azonosság, amit a kérés állít (`from`, `agent_id`, `author`, `actor`, `updated_by`, út-beli ágensnév, a szerkesztett sor gazdája) a token ágense kell legyen; a tulajdonosi mezők (`owner_approved_message_id`, kanban `force`) tiltottak. 403 `agent-identity-binding`. |
| `PUT /api/messages/:id` | saját tokennel csak a NEKI címzett, nyitott üzenet zárható, és ezt maga az UPDATE köti ki (`closeMessageAsRecipient`). |
| vault | saját tokennel titkot csak a `store/vault-acl.json` szerint lehet olvasni, a `VAULT_ACL_MODE` értékétől függetlenül; üres fájl = egyetlen érték sem. SSH-azonosító és vault-alerőforrás soha. |
| `mayIssueCredentials` | a saját token sosem tulajdonos, akkor sem, ha még nincs dashboard-felhasználó. |

Kikapcsolva (alapértelmezés): semmi nem jön létre és egyetlen CLAUDE.md sem változik. Token
fájl híján a feloldó sosem talál, így a csak közös tokenes telepítés pontosan úgy működik, mint
eddig (`src/__tests__/agent-tokens-scope.test.ts`, "shared-token-only install"). Visszakapcsolás
után az al-ügynök következő indítása a CLAUDE.md-t visszaírja a közös tokenre. A még meglévő
token fájl addig a SZŰKÍTETT jogkörrel hitelesít, amíg kézzel ki nem törlöd, tehát a kapcsoló
lekapcsolása egy futó ügynököt sem dob 401-re.

Jóváhagyás felhasználása saját tokennel (`POST /api/approvals/:id/consume`): az al-ügynök a
SAJÁT kérését használhatja fel (amit a tulajdonos jóváhagyott), vagy azt a sort, amit a fő
ügynök `for_agent`-tel neki adott ki. A `for_agent` a `POST /api/approvals` opcionális mezője
(egy ágensnév, 1-64 karakter: betű, szám, `_`, `-`); csak a közös tokennel adható meg, saját
tokennel 403. Akkor kell, ha a sort a fő ügynök iktatja (például a tulajdonos chaten adott
jóváhagyásával, `owner_approved_message_id`), de a műveletet végző eszköz egy al-ügynök saját
tokenjével fut. Ha a sor `for_agent`-et visz, CSAK az az ügynök használhatja fel a saját
tokenjével, az iktató nem. Minden más esetben ugyanaz a 403 jön (`agent-identity-binding`),
ismeretlen azonosítóra is, így a válasz nem árulja el, létezik-e a sor. A közös token
viselkedése nem változik.

Ismert korlátok: a szigorú profilú (`dontAsk`) ügynökök receptjei a `scripts/marveen-api.sh`
segéden mennek, ami a közös tokent olvassa, ezért ők a közös tokenen maradnak. A hookok és a
flotta-szintű szkriptek szintén a közös tokent olvassák.
