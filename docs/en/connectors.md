# connectors.hu

> Business API gateway for agents: NAV, Billingo, Wise, fal.ai — in one place, over MCP.

---

## 🎯 What it does / why it matters

An agent by itself doesn't know how to fetch invoice data from NAV, issue an invoice via Billingo, or convert currency on Wise. connectors.hu provides exactly that: a **hosted MCP gateway** that makes Hungarian and international business APIs uniformly accessible to agents. Connect an account, and the agent can reach it immediately — no custom integration work.

Current connectors: NAV Online Invoice, Billingo (invoicing), Wise (FX/transfers), fal.ai (image generation). Adding a new connector takes minutes, not days.

**Highlight:** the platform is moving toward self-serve — customers will be able to upload their own connectors. That's the growth model: not bespoke integrations for each client, but a marketplace where connectors scale with user count (use-based billing).

---

## 🛠 How it works

### Architecture

- **Backend:** Supabase Edge Function (Deno), `/v1/manifest` endpoint that returns the authenticated user's current tool list (Bearer auth).
- **Master CLI:** a `conn` Go binary + per-OS release; local SQLite cache, skills auto-update.
- **Frontend:** Astro (connect-claude, CLI-install banner), Hungarian + English (`/en/`) pages.

### Auth

Supabase Auth, **6-digit OTP code** sign-in/registration (instead of magic links — corporate email scanners "click" the link and consume the one-time token; OTP codes are not affected; see [Skool CLI](skool-cli.md) lesson). Email templates in GoTrue config, sent via Resend SMTP.

### Adding a connector

Full connector launch: backend deploy + DB seed + frontend card + MCP reconnect. The process is documented with a checklist within the fleet.

### Operational lessons

- The `mailer_otp_length` (Supabase) must match the frontend code-field length (otherwise "8-digit code, 6-digit form" error).
- After any auth-touching change, an **end-to-end test is mandatory**: real OTP request → verify the code from the actual email — review/build passing is not enough.
- Custom domain (api.connectors.hu) via Cloudflare for SaaS proxy to the Supabase Function.
