# Chat app — több-szálas, per-user webes chat

A kollégák a saját agentjükkel több párhuzamos beszélgetés-szálban dolgozhatnak
(ChatGPT-stílusú szál-lista + chat), az admin dashboardtól teljesen elkülönítve.
Egy szál = egy külön Claude Code session az agent saját workdirjében: a
személyiség (CLAUDE.md) és a memória-tierek közösek, csak a beszélgetés-kontextus
válik szét szálanként. A fő session (`agent-<név>`), a Telegram-csatorna, a
heartbeat és a scheduled taskok érintetlenek.

## Bekapcsolás

Alapból ki van kapcsolva. A `.env`-ben:

```
CHAT_APP_ENABLED=1
CHAT_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
CHAT_GOOGLE_CLIENT_SECRET=...
CHAT_ALLOWED_DOMAIN=cegem.hu
CHAT_PUBLIC_URL=https://chat.cegem.hu
# opcionális:
# CHAT_SESSION_TTL_HOURS=24
# CHAT_THREAD_IDLE_MINUTES=45
# CHAT_MAX_OPEN_THREADS_PER_AGENT=10
```

1. **Google OAuth web-kliens** (Cloud Console → Credentials → OAuth client ID →
   Web application; a consent screen *Internal* típusú):
   - Authorized redirect URI: `https://chat.cegem.hu/chat-api/auth/callback`
2. **Email → agent leképezés**: `store/chat-users.json`
   (minta: `chat-users.example.json`). Ez egyben az allowlist: aki nincs benne,
   érvényes céges fiókkal sem tud belépni. Restart nélkül újraolvasódik.
3. **Reverse proxy** a chat aldomainre (DNS + TLS az üzemeltetőé). A proxy
   mindent változatlan útvonalon továbbít a backendre, a gyökeret a chat appra
   irányítva — így az admin dashboard statikus fájljai nem jelennek meg a
   kollégák felé szóló originen:

```nginx
server {
    server_name chat.cegem.hu;
    # ... TLS ...
    location = / { return 302 /chat/; }
    location /chat/     { proxy_pass http://BACKEND:3420; }
    location /chat-api/ { proxy_pass http://BACKEND:3420; }
}
```

## Biztonsági modell

- A belépés Google OAuth: a szerver az id_token `hd` claimjét **és** az email
  domainjét is ellenőrzi (a kérésbeli `hd` paraméter csak UX-hint, hamisítható).
- A session HttpOnly + SameSite=Lax (+ Secure) cookie; a DB-ben csak a session-id
  SHA-256 hash-e van.
- A `/chat-api/*` névtér teljesen különálló az admin `/api/*`-tól: a chat-cookie
  semmit nem ér az adminon, az admin bearer token sosem jut a kolléga böngészőjébe.
- Minden végpont kizárólag a belépett user saját agentjére scope-ol; más agent
  szál-id-je megkülönböztethetetlenül 404.

## Szál-életciklus

- A nyit/zár user-vezérelt (feladatonként egy szál a jó minta).
- Lezárt/felfüggesztett szál `--resume`-mal veszteség nélkül újranyitható
  (determinisztikus session-id: a transcript `<uuid>.jsonl`).
- Backstop: az üresjáratú szálakat a szerver `CHAT_THREAD_IDLE_MINUTES` után
  automatikusan felfüggeszti; nyitott szálból agentenként legfeljebb
  `CHAT_MAX_OPEN_THREADS_PER_AGENT` lehet. Minden nyitott szál egy élő
  tmux+claude processz (több száz MB RSS) — a méretezésnél ezzel számolj.
- Távoli (ssh-s) agentekhez a chat-szál nem támogatott.
