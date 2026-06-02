import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 09:00-incident fix: the heartbeat
// sub-agent must NOT load the Telegram / Slack / Discord channel plugins,
// because doing so spawns a duplicate bun poller against Marveen's bot
// token and crashes the live Marveen channel via 409 Conflict.
//
// The #237 fix scoped only project-level MCPs (empty .mcp.json), but
// `enabledPlugins` lives at the USER scope in ~/.claude/settings.json and
// is global to every Claude Code spawn unless a project-scope settings.json
// overrides it. This PR adds that override.

const SRC = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')

describe('heartbeat worker cwd isolation (2026-06-02 09:00 incident)', () => {
  it('declares the disabled-plugins list explicitly', () => {
    expect(SRC).toMatch(/HEARTBEAT_DISABLED_PLUGINS/)
    expect(SRC).toMatch(/telegram@claude-plugins-official/)
    expect(SRC).toMatch(/slack-channel@marveen-marketplace/)
  })

  it('writes a project-scope .claude/settings.json with enabledPlugins:false', () => {
    expect(SRC).toMatch(/\.claude/)
    expect(SRC).toMatch(/enabledPlugins/)
    // The write path must call writeFileSync with a settings.json target.
    expect(SRC).toMatch(/settingsPath/)
    expect(SRC).toMatch(/writeFileSync\(settingsPath/)
  })

  it('MERGES with existing settings.json (preserves hooks/etc., does not clobber)', () => {
    // The Claude Code TUI auto-generates a settings.json with a PreCompact
    // hooks section. The ensureHeartbeatWorkerCwd must NOT overwrite that
    // (Marveen audit memoria-mentes hook relies on it). Re-read, parse,
    // merge enabledPlugins only.
    expect(SRC).toMatch(/readFileSync\(settingsPath/)
    expect(SRC).toMatch(/JSON\.parse/)
    expect(SRC).toMatch(/\.\.\.current/)
  })

  it('idempotent: a no-op tick must NOT rewrite the file (dirty flag)', () => {
    // Repeated writes would tick the mtime every minute and add noise to
    // any file watcher / SCM diff. Only write when the enabledPlugins map
    // actually changes.
    expect(SRC).toMatch(/dirty/)
    expect(SRC).toMatch(/dirty\s*\|\|/)
  })

  it('keeps the empty .mcp.json -- defense in depth for project-scope MCPs', () => {
    expect(SRC).toMatch(/mcpServers/)
    expect(SRC).toMatch(/"mcpServers":\{\}/)
  })

  it('runs in the same ensureHeartbeatWorkerCwd that heartbeat.ts already calls', () => {
    expect(SRC).toMatch(/function ensureHeartbeatWorkerCwd/)
    expect(SRC).toMatch(/ensureHeartbeatWorkerCwd\(\)/)
  })
})
