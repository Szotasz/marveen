import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isManagedSettingsReady,
  getManagedSettingsSudoCommand,
  setAgentEnabledPlugins,
  resetAgentEnabledPlugins,
} from '../web/routes/agents.js'

const SLACK_ENTRY = { plugin: 'slack-channel', marketplace: 'marveen-marketplace' }
const TELEGRAM_ENTRY = { plugin: 'telegram', marketplace: 'claude-plugins-official' }

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `managed-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('isManagedSettingsReady (algorithm)', () => {
  function check(path: string): boolean {
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

  it('returns false when file does not exist', () => {
    expect(check(join(tmpDir, 'nonexistent.json'))).toBe(false)
  })

  it('returns false when file has no allowedChannelPlugins', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, '{}')
    expect(check(p)).toBe(false)
  })

  it('returns false when slack entry is missing', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, JSON.stringify({ allowedChannelPlugins: [TELEGRAM_ENTRY] }))
    expect(check(p)).toBe(false)
  })

  it('returns true when slack entry is present', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, JSON.stringify({ allowedChannelPlugins: [SLACK_ENTRY, TELEGRAM_ENTRY] }))
    expect(check(p)).toBe(true)
  })

  it('returns false on corrupt JSON', () => {
    const p = join(tmpDir, 'managed.json')
    writeFileSync(p, 'not json')
    expect(check(p)).toBe(false)
  })
})

describe('getManagedSettingsSudoCommand merge logic', () => {
  function runMerge(existingContent: string | null, targetPath: string): Record<string, unknown> {
    const cmd = getManagedSettingsSudoCommand()
    const pipeIdx = cmd.indexOf('|')
    const echoAndPayload = cmd.slice(0, pipeIdx).trim()
    const pythonPart = cmd.slice(pipeIdx + 1).trim()
    const innerMatch = pythonPart.match(/python3 -c '([\s\S]+?)' \|/)
    if (!innerMatch) throw new Error('Could not parse python script from command')
    const script = innerMatch[1]
      .replace(new RegExp('/Library/Application Support/ClaudeCode/managed-settings\\.json|/etc/claude-code/managed-settings\\.json', 'g'), targetPath)
      .replace(/; /g, '\n')

    if (existingContent !== null) writeFileSync(targetPath, existingContent)

    const payloadMatch = echoAndPayload.match(/echo '(.+)'/)
    if (!payloadMatch) throw new Error('Could not extract payload')

    const result = execSync(`echo '${payloadMatch[1]}' | python3 -c "${script.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    })
    return JSON.parse(result)
  }

  it('creates fresh config when file does not exist', () => {
    const p = join(tmpDir, 'managed.json')
    const result = runMerge(null, p)
    expect(result.allowedChannelPlugins).toHaveLength(2)
  })

  it('merges into existing config preserving other keys', () => {
    const p = join(tmpDir, 'managed.json')
    const existing = JSON.stringify({ customKey: 'keep', allowedChannelPlugins: [] })
    const result = runMerge(existing, p)
    expect(result.customKey).toBe('keep')
    expect(result.allowedChannelPlugins).toHaveLength(2)
  })

  it('is idempotent (running twice yields same result)', () => {
    const p = join(tmpDir, 'managed.json')
    const first = runMerge(null, p)
    writeFileSync(p, JSON.stringify(first, null, 2))
    const second = runMerge(JSON.stringify(first, null, 2), p)
    expect(second.allowedChannelPlugins).toHaveLength(2)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('does not duplicate existing entries', () => {
    const p = join(tmpDir, 'managed.json')
    const existing = JSON.stringify({
      allowedChannelPlugins: [SLACK_ENTRY],
    })
    const result = runMerge(existing, p)
    const slackEntries = (result.allowedChannelPlugins as Array<{plugin: string}>).filter(
      e => e.plugin === 'slack-channel'
    )
    expect(slackEntries).toHaveLength(1)
    expect(result.allowedChannelPlugins).toHaveLength(2)
  })
})

describe('setAgentEnabledPlugins (algorithm)', () => {
  function set(settingsPath: string, provider: 'slack' | 'telegram'): void {
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

  it('disables telegram when provider is slack', () => {
    const p = join(tmpDir, '.claude', 'settings.json')
    set(p, 'slack')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
    expect(data.enabledPlugins['slack-channel@marveen-marketplace']).toBeUndefined()
  })

  it('disables slack when provider is telegram', () => {
    const p = join(tmpDir, '.claude', 'settings.json')
    set(p, 'telegram')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins['slack-channel@marveen-marketplace']).toBe(false)
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBeUndefined()
  })

  it('preserves existing settings', () => {
    const dir = join(tmpDir, '.claude')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ existingKey: 'value' }))
    set(p, 'slack')
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.existingKey).toBe('value')
    expect(data.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })
})

describe('resetAgentEnabledPlugins (algorithm)', () => {
  function reset(settingsPath: string): void {
    if (!existsSync(settingsPath)) return
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      delete existing.enabledPlugins
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
    } catch { /* corrupt */ }
  }

  it('removes enabledPlugins key', () => {
    const dir = join(tmpDir, '.claude')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ enabledPlugins: { 'foo': true }, other: 1 }))
    reset(p)
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.enabledPlugins).toBeUndefined()
    expect(data.other).toBe(1)
  })

  it('is a no-op when file does not exist', () => {
    const p = join(tmpDir, 'nonexistent.json')
    expect(() => reset(p)).not.toThrow()
  })
})
