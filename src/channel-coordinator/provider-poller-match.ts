// Provider-specific poller cmdline matcher.
//
// `hasChannelPluginAlive` walks the process tree under a marveen-channels claude
// looking for the plugin's bun/node poller. Before this module, the per-provider
// check was a loose substring search: `cmd.includes('/telegram/') && ...` or a
// generic `bun + server.ts` fallback. In a multi-plugin setup -- e.g. Marveen
// running both the upstream Telegram plugin AND a SynoChat worker (both spawned
// as `bun run --cwd <plugin-dir>` children of the same claude pid) -- the
// generic fallback can MATCH the unrelated SynoChat process and report
// "telegram alive" while the real telegram poller is dead (masking). The fix:
// match against the plugin's own directory slug bounded by path separators, so
// each provider only matches its own poller. The masking gap is closed at the
// matcher layer regardless of whether the consumer is the tree-walk, the
// bot.pid fallback, or the slack/discord cross-tree scan.

import type { ChannelProviderType } from '../channel-provider.js'

// Runtime token: bun OR node. A poller is always one of these two. Bare
// substring `bun` would match a process whose argv merely mentions bun
// (a help line, an unrelated tool); `\bbun\b` anchors on token boundaries.
const RUNTIME_TOKEN_RX = /\b(bun|node)\b/

// Per-provider plugin-directory slug, anchored on path-boundary so a substring
// inside an unrelated argv (e.g. the literal word "discord" in someone's MCP
// description) is not enough -- the slug must look like a real plugin path
// segment, with a path separator (or end-of-token whitespace, or end-of-string)
// on at least one side.
//
// Slug derivation:
//   - telegram: 'telegram' -- the @claude-plugins-official cache layout puts
//     pollers under `.../cache/claude-plugins-official/telegram/<ver>/` AND
//     the marketplace layout puts them under
//     `.../marketplaces/claude-plugins-official/external_plugins/telegram`,
//     so both `/telegram/<ver>` and `/telegram` (token-end) shapes are covered
//     by the same path-boundary pattern.
//   - discord: 'discord' -- same dual layout, same pattern.
//   - slack: 'slack(-channel)?' -- the marveen `slack-channel@marveen-marketplace`
//     plugin checks in under a `slack-channel` directory, while any upstream
//     `slack@...` plugin would land at `/slack`. Both are accepted. NOTE: if
//     upstream ever ships the slack plugin under a different directory name
//     (e.g. `slack-mcp` or similar), this slug needs an update; today it is
//     derived from the marveen-marketplace plugin-id and the conventional
//     upstream layout, both documented in scripts/channels.sh (PLUGIN_ID).
//
// The `(?:\/|\s|$)` trailing anchor accepts:
//   - `/telegram/0.0.6/server.ts ...`  → trailing `/`
//   - `/telegram --shell=bun ...`      → trailing whitespace
//   - `... /telegram`                  → end-of-string
const SLUG_RX: Record<ChannelProviderType, RegExp> = {
  telegram: /\/telegram(?:\/|\s|$)/,
  slack: /\/slack(?:-channel)?(?:\/|\s|$)/,
  discord: /\/discord(?:\/|\s|$)/,
  googlechat: /\/googlechat(?:\/|\s|$)/,
}

// Slack-specific behavior-preserving fallback. The pre-fix cross-tree scan
// accepted `socket-mode` as a valid liveness signal:
//   (cmd.includes('slack') || cmd.includes('socket-mode')) && (node|bun)
// `socket-mode` is the Slack Bolt SDK / `@slack/socket-mode` connection mode.
// A live slack poller process whose ps row does NOT carry a `/slack` or
// `/slack-channel` path segment (e.g. an unusual plugin layout, a reparented
// orphan whose cwd no longer reflects the install dir, or a different upstream
// distribution layout we cannot test against from here) would still be caught
// by this signal. Preserving it as an OR-branch avoids a regression for any
// slack user whose poller cmdline differs from the marveen-marketplace shape
// we tested against. Whole-word anchored (`\b`) so a substring inside an
// unrelated argv does not match. ONLY applies to provider='slack' -- the
// telegram/discord branches stay strict.
const SLACK_SOCKET_MODE_RX = /\bsocket-mode\b/

/**
 * Pure: does this process command line look like a channel poller for `provider`?
 *
 * Match requires BOTH:
 *  - bun OR node runtime token (whole-word, not substring)
 *  - provider-specific plugin-directory slug bounded by path separators
 *
 * Reject everything else, including the historical `bun + server.ts` generic
 * fallback that masked a co-resident plugin's poller as "the provider's alive."
 */
export function matchesProviderPollerCmd(
  cmd: string,
  provider: ChannelProviderType,
): boolean {
  if (!cmd) return false
  if (!RUNTIME_TOKEN_RX.test(cmd)) return false
  if (SLUG_RX[provider].test(cmd)) return true
  if (provider === 'slack' && SLACK_SOCKET_MODE_RX.test(cmd)) return true
  return false
}
