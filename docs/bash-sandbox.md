# Bash-sandbox ágensenként (BASH_SANDBOX_AGENTS)

**Mérve: 2026-10-22, Claude Code 2.1.306, macOS, eldobható gyerek-sessionökön (kanban 79f60a8a).**

## Mit zár be

A `bash-egress-parser` hook a parancssort olvassa. Ha egy ügynök fájlba írja a kódot, és úgy futtatja
(`python3 crawl.py`, `node x.mjs`), a szkript hálózati hívását a hook nem látja. Ez valós esetben is
előfordult: Soma audit-crawlere.

A Claude Code beépített sandboxa (macOS Seatbelt + szűrő proxy) a Bash tool minden parancsára és
azok minden gyerekfolyamatára hat. A `BASH_SANDBOX_AGENTS` kapcsolón felsorolt ágensek ebben futnak.

Kifelé ennyit érnek el:
- a `store/egress-vendor-hosts.json` hosztjait, illetve a domainjeit az aldomainekkel együtt;
- a localhostot és a helyi hálózatot.

Minden más hoszt kérdés nélkül tiltva van, nyers sockettel és proxy-megkerüléssel is.

## Bekapcsolás

1. Beállítások: `BASH_SANDBOX_AGENTS = soma` (vesszővel vagy szóközzel több ágens is megadható).
   Alapból üres, vagyis senki nincs sandboxban. A fő ágensre nem hat.
   - Ágenst felvenni bármely hívó tud.
   - LEVENNI csak a gazda tud: ugyanaz a szabály, mint a hitelesítő adatok kiadásánál
     (`mayIssueCredentials`, #2163). A bejelentkezett gazda-session (akkor is, ha a böngésző mellette a
     tárolt tokent is küldi) igen; a közös token egymagában nem (403), eszközkulcs sem. A sandboxolt
     ágens ugyanis a localhoston eléri a dashboardot, és ugyanazt a tokent birtokolja, amit a gazda
     UI-ja is használ; a tokenről nem dönthető el, ki a hívó. Dashboard-login nélküli telepítésen
     (még nincs egyetlen felhasználó sem) a token a levételt is megteheti, ugyanúgy, mint a kiadást.
   - A szabály a registry `loosens` mezője: minden olyan beállítás megkaphatja, amelynek egy változása
     egy biztonsági kontrollt lazít.
2. Ha az ágensnek a saját mappáján és a `~/worktrees/<azonosító>` mappán kívül is írnia kell,
   a gazda felveszi a helyet a `store/bash-sandbox-write-paths.json` fájlba:
   ```json
   {"agents": {"soma": ["~/Library/Mobile Documents/com~apple~CloudDocs/!seo/SEO Projects"]}}
   ```
3. Az ágens újraindítása. A dashboard minden indításkor megírja a
   `store/bash-sandbox/<azonosító>.settings.json` fájlt, és `--settings` kapcsolóval adja át.
   A `watchdog.sh` újraindítása ugyanezt a fájlt adja át, ha létezik.

Fail-closed: ha a fájl nem írható meg (például sérült a vendor-lista), vagy az ágens távoli gépen fut,
az ágens nem indul el. A `sandbox.failIfUnavailable` miatt a Claude Code is kilép, ha a sandbox nem
áll fel, és nem fut nélküle.

## Miért pont ezek a beállítások (mind mérve)

| Beállítás | Mit mértünk nélküle / vele |
|---|---|
| `network.strictAllowlist: true` | Az ügynökök `--dangerously-skip-permissions` módban futnak, és ebben a módban a sima `allowedDomains` NEM tilt: az új hosztra vonatkozó kérdést a Claude Code magától jóváhagyja (az example.com és a github.com is átment). A `strictAllowlist` kérdés nélkül tilt (403, 0,01 s). Egy ember nélküli tmux-sessionben sem jelenik meg kérdés, és a session nem akad el. User- és `--settings` forrásból is hat, gépszintű (managed) beállítás nem kell hozzá. |
| `--settings` fájlban, nem a user settingsben | Ha a sandbox a user settingsben van, a cwd-ben lévő `.claude/settings.json` vagy `settings.local.json` egyetlen `sandbox.enabled: false` sorral kikapcsolja: kijut a nyers socket, bármely hoszt elérhető. Az ügynök a saját mappájába ír, így ezt meg tudná tenni. `--settings`-ből adva a projekt-fájl nem tudja kikapcsolni a sandboxot, és hosztot vagy írási helyet sem tud hozzáadni. |
| `allowUnsandboxedCommands: false` | `true` mellett a `dangerouslyDisableSandbox` kéréssel bypass módban kérdés nélkül ki lehetett lépni a sandboxból. `false` mellett ez hatástalan. |
| `network.allowLocalBinding: true` | A `localhost:3420` dashboard elérhető marad. A sandbox NO_PROXY-ja a 127.0.0.1-et és a privát tartományokat is közvetlenül engedi; ez utóbbit nem mértük. |
| `filesystem.allowWrite` | Alapból a Bash csak a cwd-be és a temp-mappába ír. A `~/worktrees` írása tiltott, a `~/.npm` szintén (az npm erre félrevezető "root-owned files, sudo chown" hibát ad). |

## Amit NEM fed (mérve vagy nyíltan nem mérve)

- **Hookok és MCP-szerverek**: a sandboxon kívül futnak, és a hálózatuk szabad (mérve: mindkettőből
  example.com HTTP 200).
- **Az ügynök a következő indítására sandbox nélküli hálózati utat telepíthet magának (korlát, élőben
  NEM mérve; kódolvasással igazolva).** A sandbox `allowWrite`-ja tartalmazza az ügynök saját mappáját
  (`agents/<név>`), és ott van a projekt-szintű `.mcp.json` és a `.claude/settings.json` a hookokkal.
  Ezeket a Claude Code a sandboxon KÍVÜL, hálózattal futtatja (lásd az előző pontot), és a
  `writeAgentSettingsFromProfile` minden indításkor a meglévő `settings.json`-ra épít: a saját
  kapu-bejegyzéseit cseréli, az idegen `PreToolUse`-bejegyzéseket megtartja. Egy listás ügynök tehát a
  sandboxolt Bash-ével beírhat egy MCP-szervert vagy egy hookot, ami a következő újraindítástól sandbox
  nélkül, hálózattal fut. Javasolt külön lépés (nem ebben a változásban): a `.mcp.json` és a
  `.claude/` kikerül az `allowWrite`-ból (a Seatbelt-profilban írástiltásként), vagy a
  `writeAgentSettingsFromProfile` az ismeretlen hookokat eldobja.
- **Write/Edit tool**: nem sandboxolt.
  - A generált fájlokat a `store/bash-sandbox` 0555-ös könyvtár (és a 0444-es fájlok) védi. Ebben a
    Write és az Edit is EACCES-szel bukik (mérve), mert ideiglenes fájlon át írnak. Egy önmagában
    0444-es fájlt viszont felülírtak (mérve).
  - A sandboxolt Bash a könyvtárat nem tudja visszaállítani: a chmod és a rename EPERM (mérve).
  - Egy sandboxon kívüli, azonos felhasználóval futó folyamat viszont igen: egy másik, nem
    sandboxolt ügynök Bash-e, egy hook vagy egy MCP-szerver.
- **A `store/egress-vendor-hosts.json`-t semmi nem védi írás ellen**: sem a self-pace kapu, sem a
  fájlmód (mérve: Write és Edit ALLOW). Egy ügynök által odaírt hoszt a következő indításkor kerülne a
  sandbox listájára, és a `bash-egress-parser`-ben azonnal hatna. Ez a hook óta így van, a sandbox nem
  rontja. Javasolt külön lépés: a self-pace kapu védett fájljai közé felvenni, ahogy az
  `egress-allowlist.json`-t.
- **Menet közbeni csere**: a Claude Code nem olvassa újra a `--settings` fájlt a session alatt (mérve:
  a kibővített fájl cseréje után az example.com tiltva maradt). Új session viszont a kibővített fájllal
  átengedte.
- **Headless Chrome a sandboxban**: nem indul. A Seatbelt-profil a `sysctl` olvasást fix névlistára
  szűkíti. A hw.model, kern.hv_vmm_present, kern.boottime és 8 további a sandboxban EPERM-et ad, a
  hoston olvasható, és egyik beállítás sem bővíti a listát. A PDF-et ezért a dashboard rendereli,
  lásd lent.
- **Ismert kockázat: csonka vagy megszakadt válaszok az engedélyezett hosztról.**
  - A sandbox proxyján át 30 dentalsalon.hu-lekérésből 3 hibás volt, mind a `sitemap.xml`-en: 2
    `IncompleteRead` nagyjából 16 KB-nál, 1 `RemoteDisconnected`. Ugyanez sandbox nélkül 30-ból 0.
    A főoldal és az árak oldal mindkét módban 10/10 rendben volt.
  - Korábban, 13 futásból 2-ben, a főoldal és a www is `RemoteDisconnected`-et adott.
  - Az okát nem tudjuk. Tipp, nem mért: a proxy bizonyos válaszokat (chunked átvitel?) idő előtt lezár.
  - A hiba kivételként jön, tehát nem néma. Soma szkriptjei (`crawl.py`, `sitemaps.py`) újrapróbálást
    kapnak.
- **`brctl` sandboxban nem fut** ("Trying to invoke brctl from a sandboxed process", rc=1). A már
  letöltött iCloud-fájl olvasása működik, de egy kiürített (csak felhőben lévő) fájlt a sandboxolt
  ügynök nem tud lehozni. Ez nyitott kérdés.

## PDF sandboxban: POST /api/pdf/render

Törzs: `{"agent": "soma", "html_path": "/abs/riport.html", "pdf_path": "/abs/riport.pdf"}`, Bearer tokennel.

- Az `agent` mező **önbevallott, nem hitelesítés**: a flotta egyetlen közös tokent használ, így bárki
  bármelyik ágens nevét beírhatja. A mező csak annyit enged, ami belőle következik:
  - az ágensnek szerepelnie kell a `BASH_SANDBOX_AGENTS`-en;
  - a HTML-t és a PDF-et csak az ágens sandbox-írási gyökerei alatt olvassa, illetve írja, realpath-szal,
    így symlinkkel sem lehet kijutni;
  - a meglévő symlinket vagy könyvtárat nem írja felül, és a PDF célkönyvtárát a beírás előtt újra
    ellenőrzi (mérve: egy renderelés közben symlinkre cserélt könyvtárba nem ír).
- A HTML-t egyszer, a memóriába olvassa be. A Chrome egy egy-dokumentumos 127.0.0.1-es originről kapja,
  minden más útvonal 404, NEM fájlként.
  - Fájlként megnyitva egy `file://` oldal más helyi fájlokat is a PDF-be húzhatna (`<iframe>`/`<object>`),
    olyat is, amelynek olvasását az ágensnek tiltja egy Read-szabály. Http-originről a Chrome `file://`-t
    nem tölt be.
  - Mérve (`pdftotext`): egy kívül lévő titok-fájl szövege az új úton nem kerül a PDF-be, fájlként
    renderelve viszont igen. Ez a kontroll.
  - Az önálló riport (`data:` képek és betűk, ahogy Soma renderelője írja) változatlanul működik. A
    relatív `src`/`href`-et a végpont nem szolgálja ki.
- Korlátok: törzs legfeljebb 8 KB, HTML legfeljebb 10 MB, PDF legfeljebb 50 MB, 90 s, egyszerre
  legfeljebb két renderelés (a többi 429).
- A Chrome fix argv-vel, shell nélkül, eldobható profillal fut, és hálózata nincs:
  - minden kérés egy halott proxyra megy (127.0.0.1:9, a loopbackkel együtt), kivéve a dokumentum
    saját originjét;
  - minden más hosztnév NOTFOUND-ra oldódik fel (a 127.0.0.1-et ki kell venni, különben a szabály a
    dokumentumot sem engedi betölteni);
  - a nem proxyzott WebRTC UDP tiltva van.
  - Mérve: egy oldal, amelynek képe, stíluslapja és szkriptje is egy helyi figyelő szerverre mutat,
    semmit nem ér el. Ugyanez az oldal a kapcsolók nélkül eléri a szervert.
  - A JavaScript fut: a `--blink-settings=scriptEnabled=false` mellett a `--print-to-pdf` nem írt PDF-et.

Kliens-minta (Soma `render.py`-jához: sandboxban a végpont, azon kívül a régi Chrome-út; a
`SANDBOX_RUNTIME` változót a sandbox állítja be):

```python
def html_to_pdf(html_path, pdf_path, agent, endpoint='http://127.0.0.1:3420/api/pdf/render',
                token_file='/Users/gyuri/marveen/store/.dashboard-token'):
    html_path, pdf_path = os.path.abspath(html_path), os.path.abspath(pdf_path)
    if not os.environ.get('SANDBOX_RUNTIME'):
        subprocess.run([CHROME, '--headless', '--disable-gpu', '--no-pdf-header-footer',
                        f'--print-to-pdf={pdf_path}', html_path], check=True, capture_output=True, timeout=180)
        return
    token = open(token_file).read().strip()
    req = urllib.request.Request(endpoint, method='POST',
                                 data=json.dumps({'agent': agent, 'html_path': html_path, 'pdf_path': pdf_path}).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'PDF render refused ({e.code}): {e.read().decode(errors="replace")[:300]}')
    if not res.get('ok'):
        raise SystemExit(f'PDF render failed: {res}')
```

Mérve sandboxban, egy fejlesztői porton futó végponttal: a `SANDBOX_RUNTIME` be volt állítva, és a PDF
`%PDF-` fejléccel elkészült.

## Mérés újra

`bash scripts/bash-sandbox-e2e.sh store/bash-sandbox/soma.settings.json dentalsalon.hu example.com`

A szkript egy eldobható gyerek-claude-ot indít a megadott fájllal. A sessionben egy fájlba írt
python3 szkript fut. Exit 0, ha az engedélyezett hoszt válaszol, a tiltott elérhetetlen, és a
dashboard is elérhető.

Ellenpróba: ugyanez `network.strictAllowlist` nélkül exit 1-et ad (az example.com HTTP 200).
