import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SLACK_ENTRY = { plugin: 'slack-channel', marketplace: 'marveen-marketplace' }
const TELEGRAM_ENTRY = { plugin: 'telegram', marketplace: 'claude-plugins-official' }

function isManagedSettingsReady(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as {
      allowedChannelPlugins?: Array<{ plugin: string; marketplace: string }>
    }
    const plugins = data.allowedChannelPlugins ?? []
    return plugins.some(
      p => p.plugin === SLACK_ENTRY.plugin && p.marketplace === SLACK_ENTRY.marketplace
    )
  } catch {
    return false
  }
}

function setAgentEnabledPlugins(
  settingsPath: string,
  provider: 'slack' | 'telegram'
): void {
  const dir = join(settingsPath, '..')
  mkdirSync(dir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const plugins = (existing.enabledPlugins ?? {}) as Record<string, boolean>
  if (provider === 'slack') {
    plugins['telegram@claude-plugins-official'] = false
  } else {
    plugins['slack-channel@marveen-marketplace'] = false
  }
  existing.enabledPlugins = plugins
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

function resetAgentEnabledPlugins(settingsPath: string): void {
  if (!existsSync(settingsPath)) return
  try {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    delete existing.enabledPlugins
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
  } catch { /* corrupt */ }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `managed-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('isManagedSettingsReady', () => {
  it('returns false when file does not exist', () => {
    expect(isManagedSettingsReady(join(tmpDir, 'nonexistent.json'))).toBe(false)
  })

  it('returns false when file has no allowedChannelPlugins', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, '{}')
    expect(isManagedSettingsReady(p)).toBe(false)
  })

  it('returns false when slack entry is missing', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, JSON.stringify({ allowedChannelPlugins: [TELEGRAM_ENTRY] }))
    expect(isManagedSettingsReady(p)).toBe(false)
  })

  it('returns true when slack entry is present', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, JSON.stringify({ allowedChannelPlugins: [SLACK_ENTRY, TELEGRAM_ENTRY] }))
    expect(isManagedSettingsReady(p)).toBe(true)
  })

  it('returns false on corrupt JSON', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, 'not json')
    expect(isManagedSettingsReady(p)).toBe(false)
  })
})

describe('setAgentEnabledPlugins', () => {
  it('disables telegram when provider is slack', () => {
    const settingsDir = join(tmpDir, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const p = join(settingsDir, 'settings.json')
    setAgentEnabledPlugins(p, 'slack')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
    expect(data.enabledPlugins['slack-channel@marveen-marketplace']).toBeUndefined()
  })

  it('disables slack when provider is telegram', () => {
    const settingsDir = join(tmpDir, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const p = join(settingsDir, 'settings.json')
    setAgentEnabledPlugins(p, 'telegram')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins['slack-channel@marveen-marketplace']).toBe(false)
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBeUndefined()
  })

  it('preserves existing settings', () => {
    const settingsDir = join(tmpDir, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const p = join(settingsDir, 'settings.json')
    writeFileSync(p, JSON.stringify({ existingKey: 'value' }))
    setAgentEnabledPlugins(p, 'slack')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.existingKey).toBe('value')
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })
})

describe('resetAgentEnabledPlugins', () => {
  it('removes enabledPlugins key', () => {
    const settingsDir = join(tmpDir, '.claude')
    mkdirSync(settingsDir, { recursive: true })
    const p = join(settingsDir, 'settings.json')
    writeFileSync(p, JSON.stringify({ enabledPlugins: { 'foo': true }, other: 1 }))
    resetAgentEnabledPlugins(p)
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins).toBeUndefined()
    expect(data.other).toBe(1)
  })

  it('is a no-op when file does not exist', () => {
    const p = join(tmpDir, 'nonexistent.json')
    expect(() => resetAgentEnabledPlugins(p)).not.toThrow()
  })
})
