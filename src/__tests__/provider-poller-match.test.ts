// Standalone matcher tests. The masking-prevention guarantee is proven here
// at the matcher layer, independent of the higher-level integration test for
// `decideHasPluginAlive` -- so a future refactor cannot silently re-introduce
// the broad substring matching even if the integration path moves.
//
// All POSITIVE cmdlines are taken VERBATIM from a live `ps -axo pid,command`
// snapshot captured on a production host on 2026-06-09 (two plugins
// resident: the upstream telegram plugin + a locally installed synology-chat worker).

import { describe, it, expect } from 'vitest'
import { matchesProviderPollerCmd } from '../channel-coordinator/provider-poller-match.js'

// Live cmdlines from `ps -axo pid,command` (2026-06-09 production snapshot).
const TELEGRAM_CACHE_CMD =
  'bun run --cwd /home/user/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start'
const TELEGRAM_MARKETPLACE_CMD =
  'bun run --cwd /home/user/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram --shell=bun --silent start'
const SYNOLOGY_CHAT_CMD =
  'bun run --cwd /home/user/.claude/plugins/local-src/synology-chat --shell=bun --silent start'
// Slack live snapshot was not available on that host (telegram is the
// production provider). The cmdline below mirrors the marveen-marketplace
// `slack-channel@marveen-marketplace` plugin layout documented in
// scripts/channels.sh (PLUGIN_ID) -- adjust if the upstream slack plugin
// ever ships under a different directory name.
const SLACK_CHANNEL_CMD =
  'node /home/user/.claude/plugins/marketplaces/marveen-marketplace/slack-channel/0.1.0/server.js'
const SLACK_BUN_CMD =
  'bun run --cwd /home/user/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0 --silent start'
const DISCORD_CACHE_CMD =
  'bun run --cwd /home/user/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start'

describe('matchesProviderPollerCmd', () => {
  describe('telegram', () => {
    it('matches the live cache-path telegram poller', () => {
      expect(matchesProviderPollerCmd(TELEGRAM_CACHE_CMD, 'telegram')).toBe(true)
    })
    it('matches the live marketplace-path telegram poller', () => {
      // Behavior IMPROVEMENT over the pre-fix substring `cmd.includes('/telegram/')`,
      // which missed this row (no trailing `/` after telegram in the marketplace
      // path). The path-boundary regex now accepts either `/telegram/` or
      // `/telegram<whitespace|EOS>`.
      expect(matchesProviderPollerCmd(TELEGRAM_MARKETPLACE_CMD, 'telegram')).toBe(true)
    })
  })

  describe('slack', () => {
    it('matches a slack-channel node poller (documented plugin path)', () => {
      expect(matchesProviderPollerCmd(SLACK_CHANNEL_CMD, 'slack')).toBe(true)
    })
    it('matches a slack-channel bun poller', () => {
      expect(matchesProviderPollerCmd(SLACK_BUN_CMD, 'slack')).toBe(true)
    })
    it('matches a slack poller whose cmdline carries the socket-mode signal but no /slack/ path-slug', () => {
      // Behavior-preserving for the pre-fix cross-tree scan which accepted
      // `socket-mode` as a Slack liveness signal regardless of plugin path.
      // Covers slack pollers whose cwd does not reflect the plugin install
      // dir (reparented orphan, unusual upstream layout). 2026-06-09
      // review catch: the original fix narrowed slack matching to the path
      // slug only and dropped this signal.
      const cmd = 'node /opt/some-other-layout/bolt-app --mode socket-mode'
      expect(matchesProviderPollerCmd(cmd, 'slack')).toBe(true)
    })
  })

  describe('discord', () => {
    it('matches a discord cache-path bun poller', () => {
      expect(matchesProviderPollerCmd(DISCORD_CACHE_CMD, 'discord')).toBe(true)
    })
  })

  describe('masking-prevention (2026-06-09 fix, the load-bearing guarantee)', () => {
    it('synology-chat poller is NOT misidentified as telegram alive', () => {
      // Before this fix, the generic `bun + server.ts` clause could match an
      // unrelated plugin's poller (any future bun process whose argv
      // mentioned server.ts) -- a real telegram outage would be masked while
      // the SynoChat worker kept the channel-monitor at "telegram alive."
      // The path-boundary regex requires `/telegram` in the cmdline.
      expect(matchesProviderPollerCmd(SYNOLOGY_CHAT_CMD, 'telegram')).toBe(false)
    })
    it('synology-chat poller is NOT misidentified as slack alive', () => {
      expect(matchesProviderPollerCmd(SYNOLOGY_CHAT_CMD, 'slack')).toBe(false)
    })
    it('synology-chat poller is NOT misidentified as discord alive', () => {
      expect(matchesProviderPollerCmd(SYNOLOGY_CHAT_CMD, 'discord')).toBe(false)
    })
    it('a hypothetical bun + server.ts cmdline without /telegram/ does NOT match telegram', () => {
      // Regression-lock on the removed generic clause: any `bun ... server.ts`
      // command without the provider slug must be rejected.
      const cmd = 'bun run /home/user/some-other-plugin/server.ts'
      expect(matchesProviderPollerCmd(cmd, 'telegram')).toBe(false)
    })
    it('a node process whose argv mentions "slack" but not as a plugin path does NOT match slack', () => {
      // Regression-lock on the removed `cmd.includes('slack') && cmd.includes('node')`
      // pair: the word slack must appear as a plugin-path slug, not free-text.
      const cmd = 'node /home/user/tools/notify.js --webhook slack'
      expect(matchesProviderPollerCmd(cmd, 'slack')).toBe(false)
    })
    it('a node process whose argv mentions "discord" but not as a plugin path does NOT match discord', () => {
      const cmd = 'node /home/user/tools/notify.js --service discord'
      expect(matchesProviderPollerCmd(cmd, 'discord')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('empty cmd -> false for all providers', () => {
      expect(matchesProviderPollerCmd('', 'telegram')).toBe(false)
      expect(matchesProviderPollerCmd('', 'slack')).toBe(false)
      expect(matchesProviderPollerCmd('', 'discord')).toBe(false)
    })
    it('plugin path present but no bun/node runtime -> false', () => {
      // A grep / cat / ls happening to print the plugin path. Without bun
      // or node tokens, this is not a poller process.
      const cmd = '/bin/cat /home/user/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/README.md'
      expect(matchesProviderPollerCmd(cmd, 'telegram')).toBe(false)
    })
    it('bun substring inside a word -> false (\\bbun\\b token requirement)', () => {
      // `embun` is not bun. The runtime-token check uses `\b` so a partial
      // substring inside a larger word does not count.
      const cmd = 'embuncher --cwd /home/user/.claude/plugins/.../telegram/0.0.6'
      expect(matchesProviderPollerCmd(cmd, 'telegram')).toBe(false)
    })
    it('telegram slug at end-of-string -> true', () => {
      const cmd = 'bun --cwd /home/user/.claude/plugins/marketplaces/.../telegram'
      expect(matchesProviderPollerCmd(cmd, 'telegram')).toBe(true)
    })
  })

  describe('socket-mode signal is slack-scoped (no cross-provider leak)', () => {
    it('socket-mode in a node cmdline does NOT match telegram', () => {
      const cmd = 'node /opt/something --mode socket-mode'
      expect(matchesProviderPollerCmd(cmd, 'telegram')).toBe(false)
    })
    it('socket-mode in a bun cmdline does NOT match discord', () => {
      const cmd = 'bun run /opt/something --mode socket-mode'
      expect(matchesProviderPollerCmd(cmd, 'discord')).toBe(false)
    })
    it('socket-mode WITHOUT bun/node runtime token does NOT match slack', () => {
      // The runtime-token gate stays in effect: socket-mode alone is not
      // enough; the process must look like a JS runtime.
      const cmd = '/bin/cat /var/log/socket-mode.log'
      expect(matchesProviderPollerCmd(cmd, 'slack')).toBe(false)
    })
    it('"socket-modemax" (substring inside a word) does NOT match slack', () => {
      // Whole-word anchor on socket-mode to avoid partial-substring drift.
      const cmd = 'node /opt/socket-modemax/server.js'
      expect(matchesProviderPollerCmd(cmd, 'slack')).toBe(false)
    })
  })

  describe('cross-provider non-confusion', () => {
    it('telegram cmdline does NOT match slack or discord', () => {
      expect(matchesProviderPollerCmd(TELEGRAM_CACHE_CMD, 'slack')).toBe(false)
      expect(matchesProviderPollerCmd(TELEGRAM_CACHE_CMD, 'discord')).toBe(false)
    })
    it('slack cmdline does NOT match telegram or discord', () => {
      expect(matchesProviderPollerCmd(SLACK_CHANNEL_CMD, 'telegram')).toBe(false)
      expect(matchesProviderPollerCmd(SLACK_CHANNEL_CMD, 'discord')).toBe(false)
    })
    it('discord cmdline does NOT match telegram or slack', () => {
      expect(matchesProviderPollerCmd(DISCORD_CACHE_CMD, 'telegram')).toBe(false)
      expect(matchesProviderPollerCmd(DISCORD_CACHE_CMD, 'slack')).toBe(false)
    })
  })
})
