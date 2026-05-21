# Printing-press CLI-k

> Bármelyik szolgáltatásból agent-natív parancssori eszköz — még akkor is, ha nincs is publikus API-ja.

---

## 🎯 Mit tud / miért érdekes

Az ügynökök sokszor lassan és drágán dolgoznak külső szolgáltatásokkal (sok API-hívás, vagy böngésző-kattintgatás). A **printing-press** ezt megfordítja: egy parancsból agent-natív **CLI**-t generál egy szolgáltatáshoz — API-specifikációból, vagy ha nincs API, akár a böngésző-forgalom rögzítéséből (HAR fájl).

A generált CLI token-hatékony (egy összetett parancs sok API-round-trip helyett), helyi gyorsítótárral, és skill-ként is települ, így az ügynökök azonnal használják.

**Kuriózum:** API NÉLKÜLI oldalakhoz is működik. Egy belépett munkamenet hálózati forgalmát rögzítve a press kiolvassa a "rejtett" végpontokat, és kész CLI-t épít belőlük — robusztusabb mint a böngésző-automatizálás. Pl. egy közösségi platformhoz (amihez nincs hivatalos API) percek alatt lett teljes parancssori eszköz: poszt, kurzus, feltöltés, mind másodperc alatt.

---

## 🛠 Hogyan működik

### Bemenet-formátumok

A `printing-press` (nyílt forrású, `mvanhorn/cli-printing-press`) három inputot fogad:
- **OpenAPI spec** (`--spec`)
- **Docs URL** (`--docs`)
- **HAR fájl** (`--har`) — API nélküli oldalhoz, DevTools-ból exportálva

### Kimenet

Egy futás: Go CLI binary + Claude Code skill + MCP server bundle.

### HAR-capture API nélküli oldalhoz

1. Headed böngésző (Playwright `recordHar`), a felhasználó belép.
2. Végigkattintja a műveleteket (a hálózati hívások rögzülnek). Élő közösségnél a felhasználó kattint — a HAR szempontjából mindegy ki, és így nincs tartalom-baleset.
3. `printing-press --har capture.har` → kész CLI.

### Kész könyvtár

A press-nek 149+ kész CLI-t tartalmazó könyvtára van (youtube, stripe, cal-com, google-search-console, supabase, notion, slack, stb.). Telepítés: `npx @mvanhorn/printing-press install <name>`, majd a flotta-skill kézi telepítése a `~/.claude/skills/`-be. Auth a titkos-tárból (vault), érték kiírása nélkül.

### Egyedi aggregáció

A generált CLI-k egy generikus `resources(id, resource_type, data JSON)` SQLite-táblába szinkronizálnak; amit a beépített `analytics` nem tud (pl. havi bevétel-bontás), azt közvetlen SQL `json_extract` lekérdezéssel ki lehet nyerni.

### Buktató

A generált `create-*` parancsok néha minden body-mezőt kötelező flagként kérnek (duplikált variánsokkal); érdemes `--stdin` body-t vagy convenience wrappert használni. Auth-hosszra figyelni: pl. a kód-mező hossza egyezzen a backend OTP-hosszával.
