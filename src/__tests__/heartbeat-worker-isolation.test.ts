import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 channel-disconnect chain.
//
// - #237: project-scope .mcp.json={} -- necessary but not sufficient
// - #247: project-scope .claude/settings.json enabledPlugins:false --
//         DID NOT WORK in production (9/10/11/12 hb all spawned the
//         Telegram plugin and crashed Marveen via 409 Conflict). The
//         claude-agent-sdk reads ~/.claude/settings.json directly and
//         ignores the project-scope override.
// - THIS PR: CLAUDE_CONFIG_DIR repointing -- the SDK-documented way to
//         override the entire ~/.claude/ root for an SDK-spawned claude.
//         Combined with a symlinked passthrough of auth + projects, the
//         heartbeat sub-agent now operates with enabledPlugins:{} and
//         cannot load any channel plugin.

const SRC = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')

describe('heartbeat worker cwd + CLAUDE_CONFIG_DIR isolation (2026-06-02 incident chain)', () => {
  it('uses CLAUDE_CONFIG_DIR as the load-bearing override -- not just project-scope settings.json', () => {
    expect(SRC).toMatch(/CLAUDE_CONFIG_DIR/)
    expect(SRC).toMatch(/HEARTBEAT_CONFIG_DIR/)
  })

  it('passes CLAUDE_CONFIG_DIR to runAgent via the env override', () => {
    // runAgent's 6th positional arg is env: Record<string, string | undefined>.
    // CLAUDE_CONFIG_DIR must travel through that channel to actually reach the
    // SDK-spawned claude.
    expect(SRC).toMatch(/runAgent\([^)]+CLAUDE_CONFIG_DIR/)
  })

  it('symlinks ~/.claude/ entries INTO the isolated config dir (preserve auth + projects)', () => {
    // An empty CLAUDE_CONFIG_DIR would lose the OAuth tokens needed for the
    // sub-agent to call the Anthropic API. We symlink everything except
    // settings.json (which we replace) and noise files.
    expect(SRC).toMatch(/symlinkSync/)
    expect(SRC).toMatch(/homedir\(\)/)
    expect(SRC).toMatch(/readdirSync/)
    expect(SRC).toMatch(/HEARTBEAT_CONFIG_SKIP/)
  })

  it('explicitly skips settings.json from the symlink set (it is the WHOLE POINT to replace it)', () => {
    expect(SRC).toMatch(/HEARTBEAT_CONFIG_SKIP[^)]*settings\.json/s)
  })

  it('writes a fresh settings.json with enabledPlugins:false for telegram/slack/discord', () => {
    expect(SRC).toMatch(/HEARTBEAT_DISABLED_PLUGINS/)
    expect(SRC).toMatch(/telegram@claude-plugins-official/)
    expect(SRC).toMatch(/slack-channel@marveen-marketplace/)
    expect(SRC).toMatch(/discord@claude-plugins-official/)
  })

  it('refuses to read through a settings.json symlink (would import user-scope enabledPlugins)', () => {
    // If a prior tick's HEARTBEAT_CONFIG_SKIP didn't contain settings.json
    // and it got symlinked, we must unlink it and write our own file --
    // never inherit the user-scope content silently.
    expect(SRC).toMatch(/isSymbolicLink/)
    expect(SRC).toMatch(/rmSync\(settingsPath/)
  })

  it('keeps the empty .mcp.json -- defense in depth', () => {
    expect(SRC).toMatch(/"mcpServers":\{\}/)
  })

  it('idempotent: stale non-symlinks under the config dir get rebuilt, not appended', () => {
    expect(SRC).toMatch(/rmSync\(linkPath/)
  })
})
