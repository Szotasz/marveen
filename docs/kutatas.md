# Kutatás oldal

Az ágensek a hosszabb kutatási anyagaikat a saját `research/` mappájukba írják: piac- és
versenytárs-elemzést, landing-teardownt, incidens-diagnózist, bármit ami túl terjedelmes
ahhoz, hogy csevegésben elférjen. A **Kutatás** oldal ezeket teszi olvashatóvá a
dashboardon, hogy ne kelljen SSH-zni egy anyagért, amit te magad kértél.

Az oldal **csak olvas**. Nincs benne feltöltés, szerkesztés és törlés.

## Használat

A bal oldali sávban a **Kutatás** menüpontra kattintva a lista ágensenként csoportosítva
mutatja a dokumentumokat: minden ágens neve fejlécként jelenik meg, alatta a saját
anyagai. Egy elemre kattintva a jobb oldalon megjelenik a megformázott tartalom, ahonnan
letöltheted az eredeti Markdown fájlt.

A sorrend a legutóbbi módosítás szerinti, a legfrissebb elöl. Az azonos napon módosított
anyagok név szerint rendeződnek. Minden elem mellett látszik a módosítás dátuma.

Az a lista, amelyikhez egyetlen anyag sem tartozik, nem jelenik meg -- az üres ágensek
nem foglalnak helyet a nézetben.

## Honnan olvas

| Ágens | Mappa |
|-------|-------|
| Fő ágens | a projekt gyökerében lévő `research/` |
| Sub-ágensek | `agents/<nev>/research/` |

Csak `.md` kiterjesztésű fájlok jelennek meg. A dokumentum címe az első `#` fejléc a
fájlban; ha nincs benne fejléc, a fájlnév marad a cím.

Új anyag megjelenítéséhez semmit nem kell beállítani: elég a megfelelő `research/`
mappába írni egy Markdown fájlt, és a következő betöltésnél már ott lesz.

## Végpontok

Mindkét végpont `GET`, és ugyanaz a Bearer-token védi, mint a többi `/api/*` útvonalat.

| Végpont | Válasz |
|---------|--------|
| `/api/research` | `[{agent, docs: [{name, title, updated}]}]` -- ágensenként csoportosított lista |
| `/api/research/<agent>/<fajlnev>.md` | `{agent, name, title, content}` -- egy dokumentum tartalma |

## Biztonság

- Az útvonal kizárólag olvas: nincs író, törlő vagy feltöltő művelet.
- A fájlnév mintára van szűrve (`^[A-Za-z0-9._-]+\.md$`), és a `basename` egyezését is
  ellenőrzi a kód -- a könyvtár-bejárásos próbálkozás (`../`) `400`-zal elszáll.
- Ismeretlen ágens-név `404`-et ad, nem szivárogtat könyvtár-szerkezetet.
- A `research/` mappán kívülre az oldal nem lát ki.
