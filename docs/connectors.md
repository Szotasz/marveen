# connectors.hu

> Üzleti API-átjáró ügynököknek: NAV, Billingo, Wise, fal.ai — egy helyen, MCP-n keresztül.

---

## 🎯 Mit tud / miért érdekes

Egy ügynök önmagában nem tudja, hogyan kell NAV-on számlaadatot lekérni, Billingo-n számlát kiállítani, vagy Wise-on devizát konvertálni. A connectors.hu ezt adja meg: **hosted MCP-átjáró**, ami magyar és nemzetközi üzleti API-kat tesz elérhetővé ügynökök számára egységesen. Bekötsz egy fiókot, az ügynök azonnal eléri — külön integrációs munka nélkül.

A jelenlegi connectorok: NAV Online Számla, Billingo (számlázás), Wise (deviza/utalás), fal.ai (képgenerálás). Új connector hozzáadása percek kérdése, nem napoké.

**Kuriózum:** a platform önkiszolgáló irányba megy — az ügyfelek a saját connectorukat is feltölthetik. Ez a terjeszkedési modell: nem egyedi fejlesztés minden integrációhoz, hanem egy piactér, ahol a connectorok skálázódnak a felhasználók számával (use-based billing).

---

## 🛠 Hogyan működik

### Architektúra

- **Backend:** Supabase Edge Function (Deno), `/v1/manifest` végpont, ami a felhasználó-fiók aktuális tool-listáját adja vissza (Bearer auth).
- **Master CLI:** egy `conn` Go binary + per-OS release; helyi SQLite cache, a skill automatikusan frissül.
- **Frontend:** Astro (connect-claude, CLI-install banner), magyar + angol (`/en/`) oldalakkal.

### Auth

Supabase Auth, **6-jegyű OTP-kódos** belépés/regisztráció (magic link helyett — a céges email-szkennerek a linket elhasználnák; lásd [Skool CLI](skool-cli.md) tanulság). Az email-sablonok a GoTrue configban, Resend SMTP-vel kiküldve.

### Connector hozzáadás

Új connector teljes élesítése: backend deploy + DB seed + frontend kártya + MCP reconnect. A folyamat ellenőrzőlistával dokumentált a flottán belül.

### Üzemeltetési tanulságok

- A `mailer_otp_length` (Supabase) egyezzen a frontend kód-mező hosszával (különben "8-jegyű kód, 6-jegyű form" hiba).
- Auth-érintő változás után **kötelező end-to-end teszt**: valódi OTP kérés → a tényleges email kódjának ellenőrzése, nem elég a build/review.
- Custom domain (api.connectors.hu) Cloudflare for SaaS proxy-n keresztül a Supabase Function-höz.
