import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stageAgentDirForExport,
  importAgentBundle,
  readBundleManifest,
  sanitizeImportedConfig,
  bundleFilename,
  BUNDLE_SCHEMA_VERSION,
  type BundleManifest,
} from '../web/agent-bundle.js'

// Hermetic: every test builds its own agent source tree and install target in a
// temp dir, so nothing touches the real AGENTS_BASE_DIR. The full round-trip
// tars the staged dir the same way exportAgentBundle does (manifest.json +
// agent/), then imports via importAgentBundle with an injected resolveDest.

function makeAgent(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
}

function packBundle(stageRoot: string, agentName: string, includesSecrets: boolean): Buffer {
  const manifest: BundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    agentName,
    includesSecrets,
  }
  writeFileSync(join(stageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const out = join(stageRoot, '..', 'bundle.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', stageRoot, 'manifest.json', 'agent'])
  return readFileSync(out)
}

describe('agent bundle export/import', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'agent-bundle-test-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('stages the portable subset and excludes channel secrets by default', () => {
    const src = join(tmp, 'src')
    makeAgent(src, {
      'agent-config.json': '{"model":"claude-sonnet-4-6"}',
      'CLAUDE.md': '# Agent',
      'SOUL.md': 'soul',
      '.mcp.json': '{"mcpServers":{}}',
      '.claude/settings.json': '{}',
      '.claude/skills/foo/SKILL.md': 'skill',
      'memory/MEMORY.md': 'mem',
      '.claude/channels/telegram/.env': 'TELEGRAM_BOT_TOKEN=secret',
      '.claude/channels/telegram/access.json': '{"allowed":[]}',
    })
    const stage = join(tmp, 'stage')
    const staged = stageAgentDirForExport(src, stage, false)

    expect(existsSync(join(stage, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(stage, '.claude/skills/foo/SKILL.md'))).toBe(true)
    expect(existsSync(join(stage, 'memory/MEMORY.md'))).toBe(true)
    // Secrets excluded.
    expect(existsSync(join(stage, '.claude/channels/telegram/.env'))).toBe(false)
    expect(staged).toContain('agent-config.json')
    expect(staged).not.toContain(join('.claude', 'channels', 'telegram', '.env'))
  })

  it('includes channel secrets when asked', () => {
    const src = join(tmp, 'src')
    makeAgent(src, {
      'CLAUDE.md': '# Agent',
      '.claude/channels/slack/.env': 'SLACK_BOT_TOKEN=xoxb',
    })
    const stage = join(tmp, 'stage')
    stageAgentDirForExport(src, stage, true)
    expect(existsSync(join(stage, '.claude/channels/slack/.env'))).toBe(true)
    expect(readFileSync(join(stage, '.claude/channels/slack/.env'), 'utf-8')).toContain('xoxb')
  })

  it('round-trips through tar and installs under a destination base', () => {
    const src = join(tmp, 'src')
    makeAgent(src, {
      'agent-config.json': '{"model":"claude-opus-4-8[1m]","displayName":"Tester"}',
      'CLAUDE.md': '# Tester agent',
      'memory/MEMORY.md': 'remembered',
    })
    const stageRoot = join(tmp, 'pack')
    mkdirSync(stageRoot, { recursive: true })
    stageAgentDirForExport(src, join(stageRoot, 'agent'), false)
    const bundle = packBundle(stageRoot, 'tester', false)

    const destBase = join(tmp, 'agents')
    const result = importAgentBundle(bundle, { resolveDest: (n) => join(destBase, n) })

    expect(result.name).toBe('tester')
    expect(result.overwritten).toBe(false)
    expect(readFileSync(join(destBase, 'tester', 'CLAUDE.md'), 'utf-8')).toContain('Tester agent')
    expect(readFileSync(join(destBase, 'tester', 'memory', 'MEMORY.md'), 'utf-8')).toBe('remembered')
  })

  it('rejects a name collision unless overwrite is set', () => {
    const src = join(tmp, 'src')
    makeAgent(src, { 'CLAUDE.md': 'v1' })
    const stageRoot = join(tmp, 'pack')
    mkdirSync(stageRoot, { recursive: true })
    stageAgentDirForExport(src, join(stageRoot, 'agent'), false)
    const bundle = packBundle(stageRoot, 'dupe', false)

    const destBase = join(tmp, 'agents')
    const resolveDest = (n: string) => join(destBase, n)

    importAgentBundle(bundle, { resolveDest })
    expect(() => importAgentBundle(bundle, { resolveDest })).toThrow(/already exists/)

    // overwrite replaces it
    const r = importAgentBundle(bundle, { resolveDest, overwrite: true })
    expect(r.overwritten).toBe(true)
  })

  it('honors overrideName and re-sanitizes it', () => {
    const src = join(tmp, 'src')
    makeAgent(src, { 'CLAUDE.md': 'x' })
    const stageRoot = join(tmp, 'pack')
    mkdirSync(stageRoot, { recursive: true })
    stageAgentDirForExport(src, join(stageRoot, 'agent'), false)
    const bundle = packBundle(stageRoot, 'original', false)

    const destBase = join(tmp, 'agents')
    // sanitizeAgentName strips accents and any char outside [a-z0-9-]; a space
    // is removed (not hyphenated), so "Új Név!" decays to "ujnev".
    const r = importAgentBundle(bundle, {
      resolveDest: (n) => join(destBase, n),
      overrideName: 'Új Név!',
    })
    expect(r.name).toBe('ujnev')
    expect(existsSync(join(destBase, 'ujnev', 'CLAUDE.md'))).toBe(true)
  })

  it('strips machine-specific config fields on import', () => {
    const stagedAgent = join(tmp, 'agent')
    mkdirSync(stagedAgent, { recursive: true })
    writeFileSync(join(stagedAgent, 'agent-config.json'), JSON.stringify({
      model: 'claude-sonnet-4-6',
      remoteHost: 'devbox',
      remoteWorkdir: '/home/user/proj',
      claudeConfigDir: '/home/user/.claude-alt',
      displayName: 'Keep me',
    }))
    sanitizeImportedConfig(stagedAgent)
    const cfg = JSON.parse(readFileSync(join(stagedAgent, 'agent-config.json'), 'utf-8'))
    expect(cfg.remoteHost).toBeUndefined()
    expect(cfg.remoteWorkdir).toBeUndefined()
    expect(cfg.claudeConfigDir).toBeUndefined()
    expect(cfg.model).toBe('claude-sonnet-4-6')
    expect(cfg.displayName).toBe('Keep me')
  })

  it('rejects a bundle whose schema is newer than supported', () => {
    const extractRoot = join(tmp, 'extracted')
    mkdirSync(extractRoot, { recursive: true })
    writeFileSync(join(extractRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION + 1,
      agentName: 'future',
    }))
    expect(() => readBundleManifest(extractRoot)).toThrow(/newer than this install/)
  })

  it('rejects a bundle with no manifest', () => {
    const extractRoot = join(tmp, 'extracted')
    mkdirSync(extractRoot, { recursive: true })
    expect(() => readBundleManifest(extractRoot)).toThrow(/manifest.json missing/)
  })

  it('rejects a non-tar buffer with a friendly message', () => {
    expect(() => importAgentBundle(Buffer.from('not a tar archive'), {
      resolveDest: (n) => join(tmp, 'agents', n),
    })).toThrow(/could not extract/)
  })

  it('builds a safe download filename', () => {
    expect(bundleFilename('tester')).toBe('marveen-agent-tester.tar.gz')
    expect(bundleFilename('../../etc/passwd')).toBe('marveen-agent-passwd.tar.gz')
  })
})
