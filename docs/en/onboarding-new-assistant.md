# New assistant onboarding (Marveen fleet)

This guide walks through setting up a new colleague assistant: a dedicated Telegram bot and dedicated Google (Gmail/Drive/Calendar) access. Example: "Dia's Marveen".

Two things need to be configured: **Telegram** (so the colleague can talk to their assistant) and **Google** (so the assistant can see the colleague's email, calendar, files). The two are independent — start with either.

---

## Principles

- **Every assistant = its own Telegram bot.** A bot token cannot be shared between two assistants (Telegram only allows one long-poll connection per bot, and the dashboard blocks duplicates).
- **Personal Google goes into the colleague's own assistant**, not the main orchestrator (Marveen). The orchestrator manages the fleet; it does not read anyone's mail.
- **Never send secrets (bot token, OAuth) in a Telegram chat.** The bot token goes into the dashboard field; the Google sign-in is a one-time browser step.

---

## 1. Creating and wiring the Telegram bot

1. **Create the bot (in Telegram, @BotFather):**
   - Open @BotFather, command: `/newbot`
   - Name: e.g. `Dia's Marveen`
   - Username: e.g. `dia_marveen_bot` (must be unique, ends with `_bot`)
   - BotFather will give you an API token. Copy it.
   - Tip: create the bot as admin so it stays in company hands. The colleague never sees the token.

2. **Create the assistant on the dashboard** (https://marveen.isolutions.hu):
   - "Add", same as for previous assistants.

3. **Wire the token:**
   - In the assistant's channel settings, paste the bot token.
   - The system verifies it, wires it, and sends a welcome message via the bot.

4. **Colleague access (pairing):**
   - The colleague opens the bot (`t.me/dia_marveen_bot`) and sends it a message.
   - By default, only allowlisted users can write (allowlist policy).
   - You approve the pairing in the dashboard. After that the colleague can talk to their assistant.

---

## 2. Google (Gmail / Drive / Calendar) setup

One-time company prerequisite (already in place, for reference):
- Google Cloud project, Gmail + Drive + Calendar API enabled.
- OAuth consent screen: Internal (company accounts only).
- A "Desktop" OAuth client; its secret is locked on the server.

Colleague setup:
1. The orchestrator (Marveen) prepares the assistant's Google config and generates a sign-in link.
2. The colleague opens the link **on their own machine**, signs in with **their own company Google account**, and grants access.
3. The browser will end up on a `localhost:...` address showing an error. This is normal. The colleague copies the full URL from the browser's address bar and sends it back to the orchestrator.
4. The orchestrator completes the sign-in on the server. After that the assistant restarts and can see Gmail/Drive/Calendar. No further sign-in needed.

The colleague never sees the token or technical details — they simply sign in with their Google account once.

---

## Who does what (quick reference)

| Step | Who |
|------|-----|
| Create bot (@BotFather) | Admin (you) |
| Add assistant on dashboard | Admin (you) |
| Wire bot token | Admin (you) |
| Approve pairing | Admin (you) |
| Google sign-in (once) | The colleague (their own account) |
| Google config + finalise on server | Marveen orchestrator |

---

## Troubleshooting

- **Colleague messages the bot but no reply:** the pairing is probably not approved yet. Check pending pairings in the dashboard.
- **Disappearing messages / connection errors:** almost certainly the same bot token was used for two assistants. Each assistant needs its own bot.
- **Google sign-in shows "origin not allowed" or similar:** contact the orchestrator — this is an OAuth config issue, not the colleague's fault.

---

*Created by: Marveen orchestrator. The fleet is accessible at marveen.isolutions.hu.*
