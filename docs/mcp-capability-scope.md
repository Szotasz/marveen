# MCP hatáskör (per-agent tool-korlátozás)

> Szabályozd, hogy egy ágens az MCP-szerverei melyik eszközeit hívhatja meg -- alapból nincs korlátozás, de opt-in alapon szerverre és toolra bontva zárolható bármi.

---

## Miért kell ez?

Egy MCP-szerverhez csatlakozó ágens alapból az összes elérhető eszközt hívhatja. Egy kutatói ágensnek elég a `get_issue` / `list_commits`, de a `push_files` vagy `merge_pull_request` nem kell -- és ha rossz promptot kap, kár nélkül visszadobja. Az MCP hatáskör-konfiguráció pontosan ezt teszi lehetővé: egy explicit allow-listával csak a valóban szükséges eszközöket engedélyezed, minden mást a rendszer automatikusan tiltja.

A szigorítás **opt-in**: ha nincs beállítva hatáskör, az ágens úgy viselkedik, mint eddig (nincs tiltás, backward-compatible).

---

## Hogyan állítsd be a dashboardon

1. Nyisd meg az ágenst a flotta-nézetből (kártyára kattintás).
2. Keresd az **"MCP hatáskör"** fület az ágens részletes nézetében.
3. Válassz a három preset közül:

| Preset | Mit jelent |
|--------|------------|
| **Teljes hozzáférés (profil alapján)** | Nincs hatáskör-korlátozás -- az ágens a biztonsági profil szabályai szerint hívhat mindent. Ez az alapértelmezett. |
| **Csak olvasás** | Automatikusan a `list_`, `get_`, `search_` stb. prefixű eszközöket engedélyezi szerverenként; minden írási/törlési tool tiltva. |
| **Egyéni** | Szerverenként kézzel jelölöd be a megengedett eszközöket. |

### Egyéni módban

- Minden MCP-szerver (amit az ágens `.mcp.json`-ja tartalmaz) egy expandálható szekción belül jelenik meg.
- **"Mind" toggle** (szerver-szinten): az egész szerver összes toolja engedélyezett -- ha ezt bekapcsolod, az egyes checkboxok figyelmen kívül maradnak.
- **Eszköz-checkboxok**: egyenként pipáld be a megengedett toolokat.
- **Veszélyes eszközök** (pl. `push_files`, `merge_pull_request`, `delete_*`) pirossal jelöltek és megerősítést kérnek mentés előtt.
- **Egyéni tool**: ha az ágens katalógusban nem szereplő MCP-szervert vagy toolt használ, szövegesen is felveheted.

4. Kattints a **Mentés** gombra. A beállítás azonnal az `agent-config.json`-ba kerül.

> Ha egy ágensnek nincs MCP-szervere konfigurálva (`.mcp.json` üres vagy hiányzik), a fül megjelenik ugyan, de nincs mit szabályozni -- a szerverlista üres.

---

## Séma (agent-config.json)

```json
{
  "mcpScope": {
    "github": ["get_issue", "list_pull_requests", "search_code"],
    "gitlab": "*"
  }
}
```

- A kulcs a szerver azonosítója (pl. `"github"`, `"gitlab"`).
- Az érték lehet:
  - **string-tömb**: csak a felsorolt toolok engedélyezettek ennél a szerveren.
  - **`"*"`**: az egész szerver minden toolja engedélyezett.
- Ha egy szerver **nincs** a `mcpScope`-ban, de az ágensnek be van kötve: az összes toolja tiltva lesz (fail-closed).
- Ha a `mcpScope` mező **hiányzik** az agent-config.json-ból: nincs korlátozás (backward-compatible, unmanaged mód).

---

## Érvényesítés (enforcement)

Mentés után a rendszer az ágens `.claude/settings.json`-jébe generálja a deny-listát: minden MCP-tool, amelyik nem szerepel az allow-listán, explicit `deny` bejegyzést kap `mcp__<szerver>__<tool>` formátumban.

```json
{
  "permissions": {
    "deny": [
      "mcp__github__push_files",
      "mcp__github__merge_pull_request",
      "mcp__gitlab__delete_branch"
    ]
  }
}
```

A `deny` szabályok az MCP-bypass (pl. `--dangerously-skip-permissions`) alatt is érvényesülnek, mert a Claude Code a tool-névtiltást a bypass előtt ellenőrzi. Ez a **fail-closed** garancia: ha a scope be van állítva, a nem engedélyezett toolok nem hívhatók meg semmilyen üzemmódban.

### Veszélyes toolok

Az alábbi toolok alapból a "veszélyes" kategóriába esnek, és a dashboard pirossal jelzi őket:

- `push_files`, `create_pull_request`, `merge_pull_request`, `fork_repository`, `create_repository` (GitHub)
- `merge_merge_request`, `delete_branch`, `delete_issue`, `delete_label`, `delete_milestone`, `delete_wiki_page`, `fork_repository` (GitLab)

Ha ezeket egy ágensnek nem kellene hívnia, a Csak olvasás preset automatikusan kizárja mindegyiket.

---

## Mikor használd

| Ágens típusa | Ajánlott beállítás |
|---|---|
| Csak olvas, elemez, kutat | Csak olvasás preset |
| Issue-kat ír, de nem push-ol | Egyéni -- engedélyezd a `create_issue`, `add_issue_comment` toolokat |
| Teljeskörű fejlesztő | Teljes hozzáférés, profil alapján |
| Ismeretlen / kísérletező | Egyéni, minimális allow-lista |
