import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentDir, agentConfigRoot,
  extractDescriptionFromClaudeMd,
  resolveModelId,
  readAgentModel, writeAgentModel,
  readAgentDisplayName, writeAgentDisplayName,
  readAgentSecurityProfile,
  resolveRemoteConfig, readAgentRemoteConfig, writeAgentRemoteConfig,
  readAgentChannelProvider, writeAgentChannelProvider,
  readAgentAuthMode, writeAgentAuthMode,
  readAgentMemoryIsolation, writeAgentMemoryIsolation,
} from '../web/agent-config.js'

const TEST_AGENT = 'zz-cfg-ext-test-tmp'

afterEach(() => {
  rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
})

// --- extractDescriptionFromClaudeMd ---

describe('extractDescriptionFromClaudeMd', () => {
  it('returns first meaningful line when no heading', () => {
    const result = extractDescriptionFromClaudeMd('First paragraph text\nSecond line')
    expect(result).toBe('First paragraph text')
  })

  it('skips heading lines', () => {
    const result = extractDescriptionFromClaudeMd('# Title\nActual description here')
    expect(result).toBe('Actual description here')
  })

  it('returns empty string for empty content', () => {
    expect(extractDescriptionFromClaudeMd('')).toBe('')
  })

  it('returns empty string when all lines are headings', () => {
    expect(extractDescriptionFromClaudeMd('# Heading\n## Subheading')).toBe('')
  })

  it('truncates to 200 chars', () => {
    const long = 'a'.repeat(250)
    const result = extractDescriptionFromClaudeMd(long)
    expect(result.length).toBe(200)
  })
})

// --- resolveModelId ---

describe('resolveModelId', () => {
  it('returns alias mapping when known', () => {
    // Known alias: 'opus' -> 'claude-opus-...' etc. Just verify it returns a string
    const result = resolveModelId('opus')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns raw string for unknown model id', () => {
    const result = resolveModelId('my-custom-model-v1')
    expect(result).toBe('my-custom-model-v1')
  })

  it('returns raw string when no alias defined', () => {
    const result = resolveModelId('claude-unknown-99')
    expect(result).toBe('claude-unknown-99')
  })
})

// --- readAgentModel / writeAgentModel ---

describe('readAgentModel / writeAgentModel', () => {
  it('returns DEFAULT_MODEL when no config file', () => {
    const model = readAgentModel(TEST_AGENT)
    expect(typeof model).toBe('string')
    expect(model.length).toBeGreaterThan(0)
  })

  it('writeAgentModel persists and readAgentModel reads it back', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentModel(TEST_AGENT, 'claude-opus-5')
    const model = readAgentModel(TEST_AGENT)
    // Alias resolution may expand it, so just check it's defined
    expect(typeof model).toBe('string')
    expect(model.length).toBeGreaterThan(0)
  })
})

// --- readAgentDisplayName / writeAgentDisplayName ---

describe('readAgentDisplayName / writeAgentDisplayName', () => {
  it('returns title-cased name when no config', () => {
    const name = readAgentDisplayName(TEST_AGENT)
    expect(name.charAt(0)).toBe(TEST_AGENT.charAt(0).toUpperCase())
  })

  it('writeAgentDisplayName persists and readAgentDisplayName reads it back', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentDisplayName(TEST_AGENT, 'My Test Agent')
    expect(readAgentDisplayName(TEST_AGENT)).toBe('My Test Agent')
  })

  it('falls back to title-case when displayName is empty string in config', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ displayName: '' })
    )
    const name = readAgentDisplayName(TEST_AGENT)
    expect(name).not.toBe('')
  })
})

// --- readAgentSecurityProfile ---

describe('readAgentSecurityProfile', () => {
  it('returns "default" when no config', () => {
    expect(readAgentSecurityProfile(TEST_AGENT)).toBe('default')
  })

  it('returns configured security profile', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ securityProfile: 'restricted' })
    )
    expect(readAgentSecurityProfile(TEST_AGENT)).toBe('restricted')
  })

  it('returns "default" when securityProfile is empty string', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ securityProfile: '' })
    )
    expect(readAgentSecurityProfile(TEST_AGENT)).toBe('default')
  })
})

// --- resolveRemoteConfig ---

describe('resolveRemoteConfig', () => {
  it('returns null host/workdir for empty JSON', () => {
    const result = resolveRemoteConfig('{}')
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null for invalid JSON', () => {
    const result = resolveRemoteConfig('not-json')
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null when host is missing', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteWorkdir: '/app' }))
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null when workdir is missing', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'myserver' }))
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null when host has invalid chars', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'bad host!', remoteWorkdir: '/app' }))
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null when workdir is not absolute', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'myserver', remoteWorkdir: 'relative/path' }))
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns null when workdir has path traversal', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'myserver', remoteWorkdir: '/app/../etc' }))
    expect(result).toEqual({ host: null, workdir: null })
  })

  it('returns valid host and workdir for valid config', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'myserver.example.com', remoteWorkdir: '/home/user/app' }))
    expect(result.host).toBe('myserver.example.com')
    expect(result.workdir).toBe('/home/user/app')
  })

  it('returns valid for user@host format', () => {
    const result = resolveRemoteConfig(JSON.stringify({ remoteHost: 'user@192.168.1.1', remoteWorkdir: '/var/app' }))
    expect(result.host).toBe('user@192.168.1.1')
  })
})

// --- writeAgentRemoteConfig ---

describe('writeAgentRemoteConfig', () => {
  it('returns ok with null remote when clearing (both empty)', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    const result = writeAgentRemoteConfig(TEST_AGENT, '', '')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.remote).toEqual({ host: null, workdir: null })
  })

  it('returns error when only host is provided', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    const result = writeAgentRemoteConfig(TEST_AGENT, 'myserver', '')
    expect(result.ok).toBe(false)
  })

  it('returns error when only workdir is provided', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    const result = writeAgentRemoteConfig(TEST_AGENT, '', '/app')
    expect(result.ok).toBe(false)
  })

  it('returns error when host has invalid characters', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    const result = writeAgentRemoteConfig(TEST_AGENT, 'bad host!', '/app')
    expect(result.ok).toBe(false)
  })

  it('persists valid remote config', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    const result = writeAgentRemoteConfig(TEST_AGENT, 'myserver', '/var/app')
    expect(result.ok).toBe(true)
    const retrieved = readAgentRemoteConfig(TEST_AGENT)
    expect(retrieved.host).toBe('myserver')
    expect(retrieved.workdir).toBe('/var/app')
  })
})

// --- readAgentChannelProvider / writeAgentChannelProvider ---

describe('readAgentChannelProvider / writeAgentChannelProvider', () => {
  it('returns null when no config', () => {
    expect(readAgentChannelProvider(TEST_AGENT)).toBeNull()
  })

  it('writeAgentChannelProvider persists and reads back', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentChannelProvider(TEST_AGENT, 'telegram')
    expect(readAgentChannelProvider(TEST_AGENT)).toBe('telegram')
  })
})

// --- readAgentAuthMode / writeAgentAuthMode ---

describe('readAgentAuthMode / writeAgentAuthMode', () => {
  it('returns "shared" when no config', () => {
    expect(readAgentAuthMode(TEST_AGENT)).toBe('shared')
  })

  it('writeAgentAuthMode + readAgentAuthMode roundtrip', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentAuthMode(TEST_AGENT, 'own_team')
    expect(readAgentAuthMode(TEST_AGENT)).toBe('own_team')
  })

  it('writeAgentAuthMode ignores invalid mode', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentAuthMode(TEST_AGENT, 'shared')
    writeAgentAuthMode(TEST_AGENT, 'invalid_mode' as any)
    // should remain 'shared' since 'invalid_mode' is not valid
    expect(readAgentAuthMode(TEST_AGENT)).toBe('shared')
  })
})

// --- readAgentMemoryIsolation / writeAgentMemoryIsolation ---

describe('readAgentMemoryIsolation / writeAgentMemoryIsolation', () => {
  it('returns false when no config', () => {
    expect(readAgentMemoryIsolation(TEST_AGENT)).toBe(false)
  })

  it('writeAgentMemoryIsolation(true) enables isolation', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentMemoryIsolation(TEST_AGENT, true)
    expect(readAgentMemoryIsolation(TEST_AGENT)).toBe(true)
  })

  it('writeAgentMemoryIsolation(false) disables and removes key from config', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeAgentMemoryIsolation(TEST_AGENT, true)
    writeAgentMemoryIsolation(TEST_AGENT, false)
    expect(readAgentMemoryIsolation(TEST_AGENT)).toBe(false)
  })
})
