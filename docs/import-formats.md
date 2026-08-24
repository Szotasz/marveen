# Import formátumok

Ez a dokumentum az import rendszer által támogatott fájlformátumokat írja le: milyen
kiterjesztéseket fogad el, mik a méretkorlátok, és mi a biztonsági modell.

---

## Állapot (2026-08-24)

**Élesben, ma működik:**

- Szöveges fájlformátumok beolvasása (txt, md, json, csv, html stb.)
- Bináris fájlok tartalom-kinyeréssel, worker-izolációban: xlsx, xls, docx
- Méret- és extension-alapú szűrés importálás előtt
- Titkos tartalom szűrése (Bearer tokenek, privát kulcsok, IBAN-minták stb.)

**Tervezett, következő körben:**

- PDF (.pdf) -- kinyerő könyvtár kiválasztása folyamatban
- ODS (.ods) -- OpenDocument Spreadsheet, alacsony prioritású

---

## Támogatott formátumok

### Szöveges fájlok (500 KB limit)

| Kategória   | Kiterjesztések                                      |
|-------------|-----------------------------------------------------|
| Szöveg/Markdown | txt, md, mdx, mdc, rst                         |
| Adat        | json, csv, tsv, xml, yaml, yml, toml, ini, cfg, sql |
| Web         | html, htm                                           |
| Log         | log                                                 |

A fájl tartalma közvetlenül kerül beolvasásra. Az UTF-8 kódolást a rendszer feltételezi;
más kódolású fájloknál a szöveg torzulhat.

### Bináris fájlok tartalom-kinyeréssel (5 MB limit)

| Kiterjesztés | Formátum                        | Kinyerés módja          |
|--------------|---------------------------------|-------------------------|
| xlsx, xls    | Microsoft Excel munkafüzet      | SheetJS (xlsx csomag)   |
| docx         | Microsoft Word dokumentum       | Mammoth (docx-to-text)  |

A bináris fájlok feldolgozása **külön worker thread-ben** történik, 10 másodperces
timeout-tal. Ha a worker időtúllépés vagy hiba miatt leáll, a fájl kihagyásra kerül
(nem okoz összeomlást a crawl-folyamatban). Ez a worker-izoláció biztosítja, hogy egy
sérült vagy rosszindulatú fájl ne veszélyeztesse a fő folyamatot.

---

## Kihagyott fájlok

A következő fájlok sosem kerülnek importálásra, még ha a kiterjesztésük egyébként
elfogadott lenne:

- **Extension alapján:** `.env`, `.key`, `.pem`, `.p12`, `.pfx`, `.crt`, `.cer` és
  hasonló kulcs/tanúsítvány típusok
- **Fájlnév alapján:** `id_rsa`, `id_ed25519` és hasonló SSH-kulcs nevek
- **Tartalom alapján:** Bearer tokenek, privát kulcsok (`-----BEGIN`), jelszó-értékek,
  IBAN-szerű minták

---

## Méretkorlátok

| Típus       | Limit  | Hatás túllépéskor         |
|-------------|--------|---------------------------|
| Szöveges    | 500 KB | Fájl kihagyva, logolva    |
| Bináris     | 5 MB   | Fájl kihagyva, logolva    |

A limitek az `src/web/import-config.ts`-ben (`MAX_FILE_SIZE_BYTES`) és az
`src/web/import-crawler.ts`-ben (`MAX_BINARY_FILE_SIZE_BYTES`) vannak definiálva.
