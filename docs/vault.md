# Vault & titkosítás

> Az API-kulcsok nem plaintext fájlokban hevernek. Titkosított széf, OS-kulcstárral.

---

## 🎯 Mit tud / miért érdekes

Az MCP-szerverek API-kulcsait, tokenjeit és jelszavait egy **titkosított vault** kezeli (AES-256-GCM). A Claude Code alapból **plaintext**-ben tárolja ezeket a `.mcp.json`-ben — ami biztonsági kockázat: bármely process olvashatja, prompt-injection kiszedheti, és véletlenül git-be is kerülhet.

A vault ezt úgy oldja meg, hogy a `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak, a tényleges értékek titkosítva vannak, és csak induláskor, memóriában oldódnak fel. Az ügynökök a titok értékét sosem írják ki (logba, üzenetbe) — referenciaként használják.

**Kuriózum:** a beolvasáskor a rendszer a titkot a működő folyamatba injektálja anélkül, hogy az érték valaha is megjelenne a transzkriptben vagy egy fájlban — így egy kulcsot fel lehet használni úgy, hogy az asszisztens "nem is látja".

---

## 🛠 Hogyan működik

### Master key tárolás

- **macOS**: a master key a Keychain-ben (`com.<slug>.vault` service) — az OS titkosított kulcstára, a disk encryption része, a bejelentkezéshez kötött, transzparens. Korábbi fájl-alapú kulcs (`store/.vault-key`) első induláskor automatikusan a Keychain-be migrálódik.
- **Linux**: a Keychain nem elérhető → fájl-alapú master key (`store/.vault-key`, `chmod 600`). A titkosítás itt is AES-256-GCM; a kulcs védelme az OS fájljogosultságokra + disk encryption-re hárul (éles környezetben LUKS ajánlott).

### Scan & Import

A dashboard Vault-oldalán a **Scan & Import** megkeresi a `.mcp.json` fájlokban lévő plaintext titkokat és felajánlja az importálást. Utána a `.mcp.json`-ben `vault:SECRET_ID` referencia áll a plaintext helyett, és az MCP-parancs becsomagolódik a `vault-env-wrapper.sh`-val, ami induláskor feloldja a referenciákat.

A scanner a `.mcp.json` `env` szekciójának érzékeny kulcsait fogja (`_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `API_*`, `AUTH_*`, `OAUTH_*` stb.). Az `args`-ban átadott titkokat (pl. `--api-key`) nem érzékeli — azokat manuálisan env-re kell állítani.

### Struktúra

```
store/vault.json               # titkosított titkok (AES-256-GCM)
store/vault-bindings.json      # titok ↔ MCP-szerver hozzárendelés
scripts/vault-env-wrapper.sh   # runtime feloldó wrapper
scripts/vault-resolve.mjs      # secret ID → plaintext feloldás
```

### Ügynök-használat

Az ügynökök programatikusan kiolvashatják a titkot (pl. egy press-CLI auth beállításához) a dist vault-modulon át — érték kiírása nélkül. A titkok címke (label) szerint azonosítva. A dashboard `/api/autonomy`-hoz hasonlóan Bearer-token védett API.

---

## 🔑 SSH Vault (szerver- és kulcskezelés)

> Központi SSH szerver- és kulcsnyilvántartás a flottának -- külön a generikus titkosított titkoktól.

A generikus secret-vault mellett a dashboard egy dedikált **SSH Vault** modult is biztosít, ami a flotta által elért SSH szervereket és a hozzájuk tartozó kulcsokat tartja nyilván.

### Adatmodell

- `vault_ssh_servers`: nyilvántartott szerverek (host, user, opcionális `ssh_key_id` hivatkozás).
- `vault_ssh_keys`: megosztott SSH kulcs-készlet (label, username, publikus kulcs, fingerprint, kulcstípus). Egy kulcs **több szerverhez** is hozzárendelhető (many-servers-to-one-key modell).
- A privát kulcsok a generikus `vault.ts` titkosított tárolóban élnek (`ssh-key-<id>` prefixű bejegyzésként), de a generikus `/api/vault` listázásból ki vannak szűrve -- kizárólag a Kulcstároló saját endpointján (`/api/vault/ssh-keys`) érhetők el, hogy ne duplikálódjanak a UI-n.

### API végpontok

- `GET/POST /api/vault/ssh-servers`, `PUT/DELETE /api/vault/ssh-servers/:id` -- szerver CRUD.
- `GET/POST /api/vault/ssh-keys` -- kulcs-készlet listázás/generálás (új ed25519 pár).
- `POST /api/vault/ssh-keys/import` -- meglévő privát kulcs importálása (publikus kulcs + fingerprint automatikus levezetéssel, `ssh-keygen -y`).
- `GET /api/vault/ssh-keys/:id/public-key` -- publikus kulcs + telepítési (`authorized_keys`) instrukció lekérése.
- `DELETE /api/vault/ssh-keys/:id` -- kulcs törlése; a hozzárendelt szerverek referenciája is törlődik, és a mögöttes titkosított secret is takarítva (`deleteSecret`), nincs árva bejegyzés.

### UI

A dashboard Vault oldalán külön szekció (Kulcstároló) mutatja a kulcs-készletet (lista/másolás/törlés), és a SSH Szerverek szekció (kártya- és táblázat-nézet) a szerverekhez rendelt kulcsot egy legördülőben lehet váltani. Új szerver felvételekor egy önálló, csak-kulcsválasztós info-modal mutatja a telepítési parancsokat -- szerver-kiválasztás nélkül, mivel az új szerver még nincs felvéve.
