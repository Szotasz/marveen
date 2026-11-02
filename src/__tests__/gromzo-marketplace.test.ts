import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureGromzoMarketplace, stagedGromzoVersion, GROMZO_PLUGIN_KEY } from '../web/gromzo-marketplace.js'

// GROMZOMXDINSTALL1102 Q5: the dashboard registers the staged gromzo-local marketplace in the shared
// plugin files, never overwriting someone else's entry or an unreadable file.
let base: string, pluginsDir: string, pluginRoot: string
const now = () => new Date('2026-11-02T20:00:00.000Z')
const opts = () => ({ pluginsDir, pluginRoot, projectRoot: '/proj', now })
const read = (f: string) => JSON.parse(readFileSync(join(pluginsDir, f), 'utf-8'))

function stage(name = 'gromzo-local', version = '0.3.7') {
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'gromzo-channel', '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name }))
  writeFileSync(join(pluginRoot, 'gromzo-channel', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gromzo-channel', version }))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gz-mp-'))
  pluginsDir = join(base, 'plugins'); mkdirSync(pluginsDir)
  pluginRoot = join(base, 'marveen-local-plugins', 'gromzo')
})

describe('ensureGromzoMarketplace', () => {
  it('registers a staged marketplace in the live install\'s shape, keeping every other entry', () => {
    stage()
    writeFileSync(join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': { source: { source: 'github', repo: 'x/y' } } }))
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'telegram@x': [{ scope: 'user' }] } }))
    expect(ensureGromzoMarketplace(opts())).toBe('registered')
    const k = read('known_marketplaces.json')
    expect(k['claude-plugins-official']).toBeDefined()
    expect(k['gromzo-local']).toEqual({ source: { source: 'directory', path: pluginRoot }, installLocation: pluginRoot, lastUpdated: '2026-11-02T20:00:00.000Z' })
    const i = read('installed_plugins.json')
    expect(i.plugins['telegram@x']).toEqual([{ scope: 'user' }])
    expect(i.plugins[GROMZO_PLUGIN_KEY]).toEqual([{ scope: 'project', projectPath: '/proj', installPath: join(pluginRoot, 'gromzo-channel'), version: '0.3.7', installedAt: '2026-11-02T20:00:00.000Z', lastUpdated: '2026-11-02T20:00:00.000Z' }])
    expect(ensureGromzoMarketplace(opts())).toBe('present')
  })

  it('creates the files when absent, and keeps an existing file\'s mode', () => {
    stage()
    expect(ensureGromzoMarketplace(opts())).toBe('registered')
    expect(read('installed_plugins.json').version).toBe(2)
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }))
    chmodSync(join(pluginsDir, 'installed_plugins.json'), 0o644)
    expect(ensureGromzoMarketplace(opts())).toBe('registered')
    expect(statSync(join(pluginsDir, 'installed_plugins.json')).mode & 0o777).toBe(0o644)
  })

  it('never overwrites: another gromzo-local path, or an unreadable file, is left alone', () => {
    stage()
    const other = { 'gromzo-local': { source: { source: 'directory', path: '/elsewhere' } } }
    writeFileSync(join(pluginsDir, 'known_marketplaces.json'), JSON.stringify(other))
    expect(ensureGromzoMarketplace(opts())).toBe('other_path')
    expect(read('known_marketplaces.json')).toEqual(other)
    writeFileSync(join(pluginsDir, 'known_marketplaces.json'), '{broken')
    expect(ensureGromzoMarketplace(opts())).toBe('failed')
    expect(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf-8')).toBe('{broken')
  })

  it('does nothing without a staged gromzo-local marketplace (not staged, wrong name, odd version)', () => {
    expect(ensureGromzoMarketplace(opts())).toBe('no_plugin')
    stage('someone-else')
    expect(ensureGromzoMarketplace(opts())).toBe('no_plugin')
    stage('gromzo-local', '0.3.7"; rm -rf /')
    expect(stagedGromzoVersion(pluginRoot)).toBeNull()
    expect(ensureGromzoMarketplace(opts())).toBe('no_plugin')
  })

  it('agent-process calls it for a gromzo agent before the isolated config is seeded', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
    const call = src.indexOf('const reg = ensureGromzoMarketplace({')
    expect(call).toBeGreaterThan(src.indexOf('const extraLaunch = buildExtraChannelLaunch('))
    expect(call).toBeLessThan(src.indexOf('const isolated = ensureIsolatedChannelConfigDir(name'))
    expect(src.slice(call - 200, call)).toContain("if (extraLaunch.gromzo === 'on') {")
  })
})
