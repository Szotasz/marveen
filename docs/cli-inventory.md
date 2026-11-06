# CLI-nyilvántartás

> A flotta által futtatható parancssori eszközök egy oldalon, az MCP-szerverek mellett ([EN](en/cli-inventory.md)).

---

## 🎯 Mit tud / miért érdekes

A Kapcsolatok csoport MCP oldala csak MCP-szervereket mutat. Egy [Printing Press](printing-press-cli.md) CLI viszont ugyanúgy éles fiókhoz nyúlhat, és eddig a dashboard nem látta. A **Kapcsolatok > CLI** oldal ezeket sorolja fel, az MCP oldal kinézetével: összesítő kártyák, mappánként egy csoport, eszközönként egy kártya, és kattintásra egy részletablak.

A részletablakban:
- **bináris, verzió, licenc, mappa**: a CLI `manifest.json`-jából;
- **hitelesítés**: a mód és a szükséges környezeti változók NEVE (érték soha);
- **parancsok**: a felső szintű parancsok rövid leírással és alparancsokkal;
- **skillek, amelyek hivatkoznak rá**: a globális és az ügynökönkénti skillek közül azok, amelyek a bináris nevét említik (csak az ügynök és a skill neve, a skill szövegéből semmi);
- **README-részlet**: a mappa README-jének eleje.

A lista magától épül, kézi nyilvántartás nélkül.

---

## 🛠 Hogyan működik

- **Generátor:** `scripts/cli-inventory.py` a `store/cli-inventory.json` fájlt írja (atomikusan, determinisztikusan, saját hálózati hívás nélkül).
- **Route:** `GET /api/cli-inventory` (bearer-kapus, csak GET) a fájlt szolgálja ki, és újragenerálja, ha hiányzik, egy óránál régebbi, vagy `?refresh=1` érkezik (az oldal Frissítés gombja). Ha a generálás nem sikerül, az előző fájl látszik a hibával együtt; fájl nélkül 500 a válasz, nem üres lista. A szerkezet szándékosan az átvett nyílt forrású projektek leltárának (`/api/opensource-inventory`) mintája.
- **Mappák:** a `CLI_INVENTORY_DIRS` beállítás (alapból `~/printing-press/library`, lásd [config-reference](config-reference.md)). Minden beállított mappa minden közvetlen almappája, amelyben `manifest.json` áll, egy eszköz.
- **A manifestből** csak a `display_name`, `version`, `description` és `license` mező kerül át; az `author`, a `user_config` és a `server` nem.

### A generátor FUTTATJA a talált binárisokat

A parancslistához a generátor minden almappa `*-pp-cli` fájlját **elindítja a dashboard felhasználójának jogával**, kizárólag leíró hívással: `agent-context`, ennek hiányában `--help`. A hívás:
- hívásonként 5 másodperces időkorláttal fut, túllépésnél az egész folyamatcsoport leáll;
- lezárt bemenettel, üres, ideiglenes `HOME`-mal és munkakönyvtárral (utána törlődik), és csak `PATH`, `HOME`, `LANG` környezettel indul: örökölt token nem jut el hozzá.

Ez **nem homokozó**: a bináris közben írhat fájlt vagy nyithat hálózati kapcsolatot. **Ezért a `CLI_INVENTORY_DIRS`-be csak olyan mappát adj meg, amelynek a binárisaiban megbízol.** A kimenetéből csak a fent felsorolt mezők kerülnek a JSON-ba.

Ugyanezért a `CLI_INVENTORY_DIRS`-t **csak a gazda állíthatja**: a Beállítások oldalon a változtatáshoz és a visszaállításhoz dashboard-belépés kell, a közös ügynök-token 403-at kap. A kulcs csak felülírásból él: a `.env`-ben álló, az alapértéktől eltérő sor nem érvényesül (a Beállítások oldal jelzi). Ha egy ügynök a saját mappájára állíthatná, oda tett binárist a dashboard a saját jogával, az ügynök-hookok kapuján kívül futtatna.

### Ami nem kerül be

- A beállított mappákon kívül semmit nem olvas: szimbolikus linket nem követ (sem almappát, sem binárist, sem README-t); a kihagyott linkek száma `summary.skipped_symlinks`.
- Utolsó lépésként minden szöveg átmegy egy szűrőn: e-mail-cím, URL query-string és fragment (`?token=`, `?key=`, `#access_token=`), `kulcs=érték` alakú titok és token-alakú érték helyére `[redacted]` kerül; a cserék száma `summary.redactions`.

### Ami még nincs benne

A burkok (pl. csak olvasó wrapper) jogosultság-kiírása, a hitelesítés lejárata és a használati számláló egy későbbi bővítés.

A CLI saját, parancsonkénti „read-only” jelölését az oldal szándékosan NEM mutatja: egy szülőparancs jelölése nem fedi az alparancsait (mérve: egy „read-only” jelölésű parancscsoport alatt író alparancsok állnak), így jogosultságnak olvasva félrevezetne.
