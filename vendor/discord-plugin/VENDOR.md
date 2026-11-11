# Vendored: claude-plugins-official Discord channel plugin (server.ts only)

- **Upstream**: https://github.com/anthropics/claude-plugins-official, `external_plugins/discord`
  (Apache-2.0, (c) Anthropic; `LICENSE` next to each version is upstream's).
- **Pinned**: version 0.0.4. `0.0.4/upstream/server.ts` is the upstream file **verbatim**
  (sha256 `6edc17d9e9d04930967361ba51c8e03b8f8508647a1dfc11d79ee6a0eb1010b7`), identical to the
  marketplace copy and to upstream main on 2026-11-11 (last code commit there: 48aa4351, 2026-04-14).
- **Ours**: `0.0.4/overlay/` -- the plugin as Marveen runs it. Changed lines in `server.ts` carry
  a `MARVEEN-PATCH(...)` / `MARVEEN-EXT` marker; the new logic lives in `marveen-ext.ts`.
  Review it as a diff: `diff 0.0.4/upstream/server.ts 0.0.4/overlay/server.ts`.
- **How it gets in**: `scripts/patch-discord-plugin.py`, at every channel start, puts the overlay
  over a cached `server.ts` ONLY when that file is this exact upstream version (or our own earlier
  output). Any other file -- a plugin update -- is left as shipped, with one loud log line.
- **Switch**: `DISCORD_PLUGIN_EXT=off` puts the verbatim upstream file back at the next channel start.
- **Dependencies**: none added; the overlay uses only what the plugin's own `node_modules` has
  (discord.js 14.25.1, @modelcontextprotocol/sdk).
- **Version bumps are never silent**: when upstream ships a new version, add
  `vendor/discord-plugin/<new>/upstream/server.ts` verbatim, port the overlay onto it as a reviewed
  diff, run `src/__tests__/patch-discord-plugin.test.ts`, then let the old version folder go.
