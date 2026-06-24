# Printing-press CLIs

> Agent-native command-line tools for any service — even ones with no public API.

---

## 🎯 What it does / why it matters

Agents often work slowly and expensively with external services: browser clicking, many small API calls, coordination overhead. **printing-press** inverts this: from a single command it generates an agent-native **CLI** for a service — from an API spec, or if there's no API, directly from recorded browser traffic (HAR file).

The generated CLI is token-efficient (one compound command instead of many API round-trips), has a local cache, and installs as a skill — so agents use it immediately and consistently.

If there's no time for custom development: the press ships **149+ ready-to-install CLIs** (YouTube, Stripe, Supabase, Notion, Slack, Cal.com and others). Anything not in the library can be built in minutes.

**Highlight:** works for sites **with no API**. By recording a logged-in session's network traffic, the press extracts the "hidden" endpoints and builds a ready CLI from them — more robust than browser automation and won't break with every design change. For example, a community platform with no official API got a full command-line tool in 20 minutes: post, course, upload, all running in under a second.

---

## 🛠 How it works

### Input formats

`printing-press` (open source, `mvanhorn/cli-printing-press`) accepts three inputs:
- **OpenAPI spec** (`--spec`)
- **Docs URL** (`--docs`)
- **HAR file** (`--har`) — for API-less sites, exported from DevTools

### Output

One run: Go CLI binary + Claude Code skill + MCP server bundle.

### HAR capture for API-less sites

1. Headed browser (Playwright `recordHar`), user logs in.
2. Clicks through the actions (network calls are recorded). For live communities the user does the clicking — the HAR doesn't care who, and this avoids content accidents.
3. `printing-press --har capture.har` → ready CLI.

### Pre-built library

The press ships a library of 149+ ready CLIs (youtube, stripe, cal-com, google-search-console, supabase, notion, slack, etc.). Install: `npx @mvanhorn/printing-press install <name>`, then manually install the fleet skill into `~/.claude/skills/`. Auth from the secret store (vault), without exposing the value.

### Custom aggregation

Generated CLIs sync into a generic `resources(id, resource_type, data JSON)` SQLite table; anything the built-in `analytics` can't do (e.g. monthly revenue breakdown) can be extracted with a direct SQL `json_extract` query.

### Pitfall

Generated `create-*` commands sometimes require every body field as a mandatory flag (with duplicate variants); it's worth using `--stdin` body or a convenience wrapper. Watch auth string lengths: e.g. the code field length must match the backend OTP length.
