# Egy Google-jóváhagyás minden Google-fogyasztónak

> Egy jóváhagyás a telefonon, egy refresh token, ami a telepítés minden Google
> token-fájljába bekerül, mindegyikbe a saját formátumában.

---

## 🎯 Mit tud / miért érdekes

Egy telepítés gyakran több kliensen át beszél a Google-lel: a Gmail, a Calendar és
a Drive MCP-szerver, mellettük kisebb API-szkriptek (Search Console, GA4, Tag
Manager). Mindegyik a saját jóváhagyását futtatja, és a saját refresh tokenjét
tartja, így a tokenek egyenként járnak le, vonódnak vissza és csúsznak szét, a
gazdát pedig újra meg újra jóváhagyásra kérik.

A `scripts/google-consent.py` **egyetlen** jóváhagyást kér, amely minden
beállított fogyasztó scope-jainak unióját hordozza, és az így kapott tokent minden
fogyasztó fájljába beírja:

- **Telefonbarát.** A `link` egy URL-t ír ki. A gazda megnyitja, jóváhagyja, és a
  `http://localhost/?state=...&code=...` címet visszamásolja (maga az oldal nem töltődik be,
  ez így rendben van). Nincs helyi webszerver, nem kell böngésző a gépen.
- **Semmi nem vész el.** Amit egy fogyasztó fájlja már hordoz, az hozzáadódik a
  beállított alaphoz, így egy új jóváhagyás nem dob el csendben scope-ot.
- **Hangosan áll meg hiányos engedélynél.** Ha egy jelölőnégyzet kimaradt, a
  `redeem` megnevezi a fogyasztót és a hiányzó scope-ot, és semmit nem ír (vagy
  `--partial`-lal csak a lefedett fogyasztókat írja).
- **Elkapja a 7 napos csapdát.** Ha a token-válaszban van
  `refresh_token_expires_in`, az OAuth app még "Testing" állapotban van, és a token
  7 nap múlva meghal; a `redeem` ezt kiírja, és 4-gyel lép ki.
- **Külön jóváhagyás** azokra a scope-okra, amelyeket a Google nem enged egy
  kérésben a többivel (látott eset: a `youtube.upload` a `drive.file` mellett
  `400 invalid_request ... scopes that cannot be requested together` hibát ad).

## 🛠 Hogyan működik

### Beállítás

Másold le a példát és szerkeszd; a fájl nincs verziókezelve, telepítésenként más:

```bash
cp scripts/google-consent.example.json store/google-consent.json
```

Az útvonal a `GOOGLE_CONSENT_CONFIG` változóval vagy a `--config` kapcsolóval
írható felül. Kulcsok:

| Kulcs | Jelentés |
|-------|----------|
| `client_file` | A Google Cloudból letöltött OAuth kliens JSON (Desktop app; `installed` vagy `web` szakasz). Minden fogyasztónak ugyanezt a klienst kell használnia: a refresh token csak azzal a klienssel működik, amelyiknek kiadták. |
| `state_dir` | A PKCE/state és a parkoló fájlok helye (alapból `store/`). |
| `mcp_scan_root` | Ennek a mappának a `.mcp.json`-ját és az `agents/*/.mcp.json` fájlokat nézi át: van-e Google MCP, amely más OAuth klienst vagy saját token-útvonalat használ (alapból a telepítés gyökere). |
| `consumers.<név>.format` | `gmail-mcp`, `google-auth` (opcionálisan egy `account` kulcs alatt, pl. a Calendar MCP `normal` fiókja), `drive-mcp-v2`, vagy `raw` (a token-végpont válasza plusz `obtained_at`). |
| `consumers.<név>.path` | A token-fájl, amit ez a fogyasztó olvas. |
| `consumers.<név>.scopes` | A scope-alap; a rövid nevek elé a `https://www.googleapis.com/auth/` előtag kerül. |
| `consumers.<név>.process` | Opcionális node-bináris név; írás után kilistázza a futó példányokat, mert azok a régi tokent tartják memóriában. |
| `consumers.<név>.separate` | `true`: saját jóváhagyás `--only NÉV`-vel, sosem része az uniónak. Csak `raw` lehet, és nem oszthat scope-ot az unióval. |

### Parancsok

```bash
# 1. egy jóváhagyó URL (nincs hálózati hívás)
python3 scripts/google-consent.py link

# 2. próbafutás: minden ellenőrzés, a változó fájlok és kulcsok listája, írás nélkül
python3 scripts/google-consent.py redeem '<visszamásolt http://localhost/?state=...&code=... URL>' --dry-run

# 3. az éles írás (a próbafutás parkolt válaszát használja: a kód egyszer váltható be)
python3 scripts/google-consent.py redeem '<ugyanaz az URL>'

# offline jelentés: jogosultság, mely fájlok osztoznak egy tokenen, lejárat-mező, scope-lefedettség
python3 scripts/google-consent.py status

# külön jóváhagyású fogyasztó
python3 scripts/google-consent.py link --only youtube
python3 scripts/google-consent.py redeem --only youtube '<visszamásolt URL>'
```

Kilépési kódok: `0` rendben, `1` hiba (konfighiba is), `2` hibás hívás vagy
elutasított kód (lásd Biztonság), `3`
scope-hiány (külön jóváhagyásnál: nem pontosan a kért scope-ok), `4` megírva vagy
ellenőrizve, de a token 7 napos "Testing" token.

### Biztonság

- **Titok sosem kerül a kimenetre**: sem a kliens-titok, sem access vagy refresh
  token, sem a PKCE verifier. A `status` csak csoportbetűvel jelzi, mely fájlok
  osztoznak egy tokenen.
- **Mindenhol 0600.** A token-fájlok atomikusan íródnak (friss `mkstemp`
  ideiglenes fájl ugyanabban a mappában + átnevezés), 0600 jogosultsággal, a
  umasktól függetlenül. Ha egy token-útvonal symlink, elutasítja (2-es kód, nincs
  írás), nem követi és nem cseréli le; a hiányzó mappák
  minden szintje 0700-zal jön létre. Minden meglévő fájlról előbb bájtra pontos másolat készül:
  `<fájl>.bak-<időbélyeg>` (0600, sosem íródik felül).
- **A maradék fájlokban élő token van, és semmi nem takarítja őket.** A parkolt válasz
  (`<state_dir>/.google-consent[-NÉV]-pending.json`) egy teljes, sikeres írásig megmarad, a
  `.bak-<időbélyeg>` másolatok pedig örökre: a parkolt fájlt töröld, ha félbehagyod a
  futást, a mentéseket pedig, ha az új token már működik.
- **Kódot csak akkor vált be, ha egy általa kiadott linkhez kötődik.** A
  visszamásolt URL `state` értékének egy tárolt PKCE-bejegyzéshez (S256) kell
  tartoznia, és a beváltás mindig annak a bejegyzésnek a `code_verifier`-ét küldi.
  A nyers kódot, a `state` nélküli URL-t, az olyan `state`-et, amit egyik `link`
  sem adott ki, és a 60 percnél régebbi linket 2-es kóddal elutasítja: nincs
  hálózati hívás, nincs írás. Enélkül
  egy kód, amit valaki a SAJÁT Google-fiókjára szerzett ugyanazon a kliensen,
  bemásolható lenne (megtévesztéssel, vagy prompt-injekcióval a szkriptet futtató
  ügynökbe), és minden fogyasztót ahhoz a fiókhoz kötne. Az uniónak és minden külön
  fogyasztónak saját state-fájlja van, így a kódjaik sem keveredhetnek.
- **Csak a `redeem` megy hálózatra**, és csak a Google token-végpontjára. A
  `GOOGLE_CONSENT_TOKEN_URL` tesztekhez egy loopback `http://` végpontra
  irányíthatja; minden más értéket elutasít.

Írás után indítsd újra a Google MCP-k minden futó sessionjét (a lista kiíródik):
ezek még a régi tokent tartják, és egy frissítő MCP visszaírhatja a régit a
fájljába. Utána futtasd a `status`-t.

### Tesztek

A `python3 scripts/__tests__/google-consent.test.py` hermetikus: ideiglenes HOME,
kamu token-fájlok, helyi kamu token-végpont, és egy őr, amely minden más hálózati
hívásra elbuktatja a tesztet. Minden futás ellenőrzi, hogy titok-jelölő nem kerül
a stdout-ra vagy a stderr-re.
