# Jogosultsági profilok (Permission Profiles)

> Előre definiált eszköz-engedélyek és fájlrendszer-hozzáférési sablonok -- egy ügynök indításakor kiválasztható profil szabja meg, mit tehet.

---

## 🎯 Mit tud / miért érdekes

Amikor egy új ügynököt indít a rendszer, a Claude Code engedélykezelő motorja egy **profil alapján dönti el**, milyen eszközök és fájlrendszer-műveletek engedélyeztek vagy tiltottak. Jogosultsági profil nélkül minden ügynök `--dangerously-skip-permissions` módban fut (permissive) -- a profilok ezt szabályozzák és szorítják.

Két futási mód:

| Mód | Leírás |
|-----|--------|
| `permissive` | Alapértelmezetten mindent engedélyez; a `deny` lista tilt le konkrétumokat |
| `strict` | Alapértelmezetten mindent tilt; csak az `allow` listán szereplők engedélyeztek |

**Strict módban a `--dangerously-skip-permissions` flag nem kerül az indítási parancsba**, így Claude Code ténylegesen érvényesíti az engedélylistát.

---

## 📁 Profilfájlok helye

```
templates/profiles/
  default.json
  developer-junior.json
  developer-senior.json
  marketer.json
  researcher.json
```

Minden fájl egy önálló JSON profil. A Marveen **dinamikusan olvassa** a könyvtárat -- új `.json` fájl hozzáadásával azonnal megjelenik a dashboardon (újraindítás nélkül).

---

## 🗂 Profil struktúra

```json
{
  "id": "developer-junior",
  "label": "Fejlesztő (junior)",
  "description": "Feature-fejlesztésre saját branch-en. Main-re tiltott push.",
  "permissionMode": "strict",
  "filesystem": {
    "allow": [
      "Read(${AGENT_DIR}/**)",
      "Write(${AGENT_DIR}/**)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "WebFetch(*)"
    ],
    "deny": [
      "Read(${HOME}/.ssh/**)",
      "Bash(sudo:*)",
      "Bash(git push --force:*)",
      "Bash(git push origin main:*)"
    ]
  }
}
```

| Mező | Leírás |
|------|--------|
| `id` | Egyedi azonosító (fájlnév = `<id>.json`) |
| `label` | Dashboard megjelenítési neve |
| `description` | Rövid leírás, mire való |
| `permissionMode` | `strict` vagy `permissive` |
| `filesystem.allow` | Engedélyezett eszközök/útvonalak |
| `filesystem.deny` | Tiltott eszközök/útvonalak |

---

## 🔤 Placeholder-ek

A profilfájlokban az alábbi placeholder-ek helyettesítődnek be az ügynök indításakor:

| Placeholder | Behelyettesített érték |
|-------------|----------------------|
| `${HOME}` | A gép `HOME` könyvtára |
| `${AGENT_DIR}` | Az ügynök munkakönyvtára (`agents/<nev>/`) |
| `${WORKDIR}` | Alias `${AGENT_DIR}`-re |

---

## 📋 Beépített profilok

### `default` -- Alapértelmezett (kompatibilitási)

```json
{
  "permissionMode": "permissive",
  "filesystem": { "allow": [], "deny": [] }
}
```

Régi ügynökök kompatibilitásához. Új ügynökhöz inkább szerep-specifikus profilt válassz.

### `developer-junior` -- Fejlesztő (junior)

- Mód: `strict`
- Engedélyez: saját `AGENT_DIR`, `/tmp`, git, npm, node, python3, curl, WebFetch/WebSearch
- Tilt: `~/.ssh`, `~/.aws`, `~/.gnupg`, `sudo`, force-push, push main/master-re

Mire jó: feature-fejlesztésre, saját branch-en, sandboxolt környezetben.

### `developer-senior` -- Fejlesztő (senior, bizalmi)

- Mód: `permissive`
- Tilt: `~/.ssh`, `~/.aws`, `~/.gnupg`, `sudo`, `rm -rf $HOME`, force-push

Mire jó: megbízható ügynöknek, aki szinte mindent tehet, de a legpusztítóbb parancsok tiltva maradnak.

### `marketer` -- Marketinges

- Mód: `strict`
- Engedélyez: saját `AGENT_DIR`, `~/Downloads`, WebFetch/WebSearch, ls/cat
- Tilt: mindent, ami fájlrendszer-írást jelent a saját mappán kívül; SSH/AWS/.env; exec jellegű parancsok

Mire jó: email-vázlat, hírlevél, social tartalom -- webes tartalmat olvas, szigorúan korlátozott.

### `researcher` -- Kutató

Webes keresés, olvasás, letöltés engedélyezve; fájlrendszer-írás minimális (saját mappa + `/tmp`).

---

## 🛠 API

### Profilok listázása

```
GET /api/agents/profiles
```

Visszaadja az összes elérhető profil azonosítóját, nevét, leírását és módját.

### Profil hozzárendelése ügynökhöz

Ügynök konfigurációján belül állítható (ld. [Ügynök-flotta](agent-fleet.md)):

```
PUT /api/agents/<name>/config
Content-Type: application/json

{ "permissionProfileId": "developer-junior" }
```

Az ügynök következő indításakor az új profil lép életbe.

---

## ➕ Saját profil létrehozása

1. Hozz létre egy új `.json` fájlt a `templates/profiles/` könyvtárban
2. Töltsd ki a struktúra szerint (`id`, `label`, `description`, `permissionMode`, `filesystem.allow/deny`)
3. Az `id` egyezzen a fájlnévvel (`.json` nélkül)
4. A Marveen automatikusan felismeri -- nem kell újraindítani

```json
{
  "id": "data-analyst",
  "label": "Adatelemző",
  "description": "SQL-lekérdezések, CSV-export, csak olvasás.",
  "permissionMode": "strict",
  "filesystem": {
    "allow": [
      "Read(${AGENT_DIR}/**)",
      "Write(${AGENT_DIR}/**)",
      "Bash(sqlite3:*)",
      "Bash(python3:*)",
      "Bash(ls:*)",
      "Bash(cat:*)"
    ],
    "deny": [
      "Read(${HOME}/.ssh/**)",
      "Bash(sudo:*)",
      "Bash(rm:*)"
    ]
  }
}
```

---

## ⚠️ Fontos megjegyzések

- A Telegram channel plugin engedély-promptjai (Allow/Deny gombok az üzenetben) **külön csatornán működnek**, és a profil nem befolyásolja őket.
- Permissive módban a `deny` lista érvényes, de a `allow` lista figyelmen kívül marad (felesleges feltölteni).
- Strict módban **csak** az `allow` listán szereplő eszközök/útvonalak engedélyeztek.
- Ha egy profil `id`-je nem található a fájlrendszeren, a rendszer visszaesik az `default` profilra.

---

## Kapcsolódó dokumentumok

- [Ügynök-flotta](agent-fleet.md) -- ügynök konfigurálása, indítása
- [Vault](vault.md) -- titkos értékek kezelése (secret a profilba soha nem kerül)
