import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatHeartbeatCardLabel } from '../heartbeat.js'
import { CHANNEL_PLUGIN_IDS } from '../web/plugin-ids.js'

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

  it('writes a fresh settings.json with enabledPlugins:false for all channel plugins', () => {
    // heartbeat.ts must reference HEARTBEAT_DISABLED_PLUGINS -- the contract
    // that drives the enabledPlugins loop. The actual ID strings now live in
    // plugin-ids.ts (single source of truth); this test verifies the import
    // and that plugin-ids.ts contains the canonical IDs.
    expect(SRC).toMatch(/HEARTBEAT_DISABLED_PLUGINS/)
    expect(SRC).toMatch(/CHANNEL_PLUGIN_IDS/)
    const IDS_SRC = readFileSync(join(__dirname, '../web/plugin-ids.ts'), 'utf-8')
    expect(IDS_SRC).toMatch(/telegram@claude-plugins-official/)
    expect(IDS_SRC).toMatch(/slack-channel@marveen-marketplace/)
    expect(IDS_SRC).toMatch(/discord@claude-plugins-official/)
    expect(IDS_SRC).toMatch(/googlechat@claude-channel-googlechat/)
    expect(IDS_SRC).toMatch(/teams@marveen-marketplace/)
  })

  it('CHANNEL_PLUGIN_IDS covers all five providers (regression: googlechat/teams were missing from heartbeat)', () => {
    const ids = Object.values(CHANNEL_PLUGIN_IDS)
    expect(ids).toContain('telegram@claude-plugins-official')
    expect(ids).toContain('slack-channel@marveen-marketplace')
    expect(ids).toContain('discord@claude-plugins-official')
    expect(ids).toContain('googlechat@claude-channel-googlechat')
    expect(ids).toContain('teams@marveen-marketplace')
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

describe('formatHeartbeatCardLabel', () => {
  it('leads with the bracketed id, the one authoritative handle', () => {
    expect(formatHeartbeatCardLabel({ id: '8290FF71', title: 'Installer re-run .env karositas' }))
      .toBe('[8290FF71] Installer re-run .env karositas')
  })

  it('truncates long titles so cross-referenced card names drop out of view', () => {
    const title = 'A'.repeat(70) + ' lasd meg CARD1 es CARD2 kartyakat reszletesen'
    const label = formatHeartbeatCardLabel({ id: 'X1', title })
    expect(label.startsWith('[X1] ')).toBe(true)
    expect(label.length).toBe('[X1] '.length + 80 + 3)
    expect(label).not.toContain('CARD2')
    expect(label.endsWith('...')).toBe(true)
  })

  it('keeps short titles verbatim, no ellipsis', () => {
    expect(formatHeartbeatCardLabel({ id: 'Y2', title: 'rovid cim' })).toBe('[Y2] rovid cim')
  })
})

describe('heartbeat prompt contract (source-pinned)', () => {
  const hbSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../heartbeat.ts'), 'utf-8')

  it('the kanban section instructs report-only, id-only naming', () => {
    expect(hbSrc).toContain('KIZAROLAG a szogletes zarojeles ID-javal nevezz meg')
    expect(hbSrc).toContain('eltunt tetelre okot ne kovetkeztess')
  })

  it('the prompt is fed labeled cards, not bare titles', () => {
    expect(hbSrc).toContain('urgentLabels.join')
    expect(hbSrc).toContain('waitingLabels.join')
    expect(hbSrc).toContain('summary.urgent.map(formatHeartbeatCardLabel)')
  })
})
