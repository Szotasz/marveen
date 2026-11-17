# Vendored: claude-plugins-official Discord channel plugin (server.ts only)

- **Upstream**: https://github.com/anthropics/claude-plugins-official, `external_plugins/discord`
  (Apache-2.0, (c) Anthropic; `LICENSE` next to each version is upstream's).
- **Pinned**: version 0.0.4. `0.0.4/upstream/server.ts` is the upstream file **verbatim**
  (sha256 `6edc17d9e9d04930967361ba51c8e03b8f8508647a1dfc11d79ee6a0eb1010b7`), identical to the
  marketplace copy and to upstream main on 2026-11-11 (last code commit there: 48aa4351, 2026-04-14).
- **Ours**: `0.0.4/overlay/` -- the plugin as Marveen runs it. Changed lines in `server.ts` carry
  a `MARVEEN-PATCH(...)` / `MARVEEN-EXT` marker; the new logic lives in `marveen-ext.ts`.
  Review it as a diff: `diff 0.0.4/upstream/server.ts 0.0.4/overlay/server.ts`.
- **What the overlay changes** (DCEXT1111):
  - answer buttons on `reply` (the former DCBTN1023 patch, its lines still tagged `MARVEEN-PATCH(dcbtn1023)`);
  - F1: a tool-permission prompt goes to the owner only (`DISCORD_OWNER_USER_ID`, else the sole paired DM, else
    nobody), and only the owner, in a DM, decides it (upstream: every paired DM, and a typed `yes <code>` from
    any guild channel too);
  - F2: paired DM channels are opened at start, so a restart does not make them "not allowlisted";
  - F3: a voice message carries `voice="true"`;
  - F4: messages that came while the plugin was down are delivered once at start (`recovered="true"`), at most
    every 10 minutes, REST only (`DISCORD_BACKFILL`, cursor in `$DISCORD_STATE_DIR/backfill-cursor.json`);
  - F5: `fetch_messages` pages with `before`/`after`; a `create_thread` tool.
  - Hermes parity, PR1:
    - D1: every outgoing message pings users only, never `@everyone`/`@here`/a role (client default; no call
      site overrides it, tested);
    - A1: a follow-up in the bot's own thread under an opted-in channel needs no @mention
      (`$DISCORD_STATE_DIR/bot-threads.json`);
    - A2: a reply carries `reply_to_*` (what it answers);
    - A3: a forwarded message arrives with its text and files, `forwarded="1"`;
    - D2: a reply needing more than 8 messages is refused before anything is sent.
- **How it gets in**: `scripts/patch-discord-plugin.py`, at every channel start, puts the overlay
  over a cached `server.ts` ONLY when that file is this exact upstream version (or our own earlier
  output). Any other file -- a plugin update -- is left as shipped, with one loud log line.
- **Switch**: `DISCORD_PLUGIN_EXT=off` puts the verbatim upstream file back at the next channel start.
- **Dependencies**: none added; the overlay uses only what the plugin's own `node_modules` has
  (discord.js 14.25.1, @modelcontextprotocol/sdk).
- **Version bumps are never silent**: when upstream ships a new version, add
  `vendor/discord-plugin/<new>/upstream/server.ts` verbatim, port the overlay onto it as a reviewed
  diff, run `src/__tests__/patch-discord-plugin.test.ts`, then let the old version folder go.
