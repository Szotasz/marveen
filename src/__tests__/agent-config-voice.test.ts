import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentDir,
  agentConfigRoot,
  readAgentVoiceConfig,
  writeAgentVoiceConfig,
  isKnownAgent,
  readAgentCapabilities,
  writeAgentCapabilities,
} from '../web/agent-config.js'

const TEST_AGENT = 'zz-voice-cap-test-tmp'

describe('readAgentVoiceConfig', () => {
  afterEach(() => rmSync(agentDir(TEST_AGENT), { recursive: true, force: true }))

  it('returns defaults when .claude/agent-config.json is absent', () => {
    const vc = readAgentVoiceConfig(TEST_AGENT)
    expect(vc.responseMode).toBe('text')
    expect(vc.voiceModel).toBe('hu_HU-imre-medium')
  })

  it('reads valid responseMode and voiceModel from config file', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ voice: { responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' } }),
    )
    const vc = readAgentVoiceConfig(TEST_AGENT)
    expect(vc.responseMode).toBe('voice')
    expect(vc.voiceModel).toBe('hu_HU-imre-medium')
  })

  it('falls back to defaults for unrecognised responseMode', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ voice: { responseMode: 'unknown-mode', voiceModel: 'hu_HU-imre-medium' } }),
    )
    const vc = readAgentVoiceConfig(TEST_AGENT)
    expect(vc.responseMode).toBe('text')
  })

  it('falls back to defaults for unrecognised voiceModel', () => {
    mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true })
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ voice: { responseMode: 'auto', voiceModel: 'no-such-voice' } }),
    )
    const vc = readAgentVoiceConfig(TEST_AGENT)
    expect(vc.voiceModel).toBe('hu_HU-imre-medium')
  })
})

describe('writeAgentVoiceConfig', () => {
  beforeEach(() => mkdirSync(agentConfigRoot(TEST_AGENT), { recursive: true }))
  afterEach(() => rmSync(agentDir(TEST_AGENT), { recursive: true, force: true }))

  it('persists valid responseMode', () => {
    writeAgentVoiceConfig(TEST_AGENT, { responseMode: 'auto' })
    expect(readAgentVoiceConfig(TEST_AGENT).responseMode).toBe('auto')
  })

  it('persists valid voiceModel', () => {
    writeAgentVoiceConfig(TEST_AGENT, { voiceModel: 'hu_HU-imre-medium' })
    expect(readAgentVoiceConfig(TEST_AGENT).voiceModel).toBe('hu_HU-imre-medium')
  })

  it('merges with existing config (does not clobber unrelated keys)', () => {
    writeFileSync(
      join(agentConfigRoot(TEST_AGENT), 'agent-config.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', voice: { responseMode: 'text', voiceModel: 'hu_HU-imre-medium' } }),
    )
    writeAgentVoiceConfig(TEST_AGENT, { responseMode: 'voice' })
    const raw = JSON.parse(require('fs').readFileSync(join(agentConfigRoot(TEST_AGENT), 'agent-config.json'), 'utf-8'))
    expect(raw.model).toBe('claude-sonnet-4-6')
    expect(raw.voice.responseMode).toBe('voice')
  })

  it('throws for invalid responseMode', () => {
    expect(() => writeAgentVoiceConfig(TEST_AGENT, { responseMode: 'bad' as any })).toThrow(/responseMode/)
  })

  it('throws for unknown voiceModel', () => {
    expect(() => writeAgentVoiceConfig(TEST_AGENT, { voiceModel: 'no-such-model' })).toThrow(/voiceModel/)
  })
})

describe('isKnownAgent', () => {
  it('returns false for path traversal (catch path via safeJoin throw)', () => {
    // safeJoin throws on path traversal, the catch returns false
    expect(isKnownAgent('../../etc/passwd')).toBe(false)
  })
})

describe('readAgentCapabilities / writeAgentCapabilities', () => {
  beforeEach(() => mkdirSync(agentDir(TEST_AGENT), { recursive: true }))
  afterEach(() => rmSync(agentDir(TEST_AGENT), { recursive: true, force: true }))

  it('returns empty array when no config or persona file', () => {
    expect(readAgentCapabilities(TEST_AGENT)).toEqual([])
  })

  it('writes and reads back capabilities list', () => {
    writeAgentCapabilities(TEST_AGENT, ['backend', 'api', 'database'])
    expect(readAgentCapabilities(TEST_AGENT)).toEqual(['backend', 'api', 'database'])
  })

  it('overwrites previous capabilities on second write', () => {
    writeAgentCapabilities(TEST_AGENT, ['old'])
    writeAgentCapabilities(TEST_AGENT, ['new1', 'new2'])
    expect(readAgentCapabilities(TEST_AGENT)).toEqual(['new1', 'new2'])
  })

  it('preserves other config keys when writing capabilities', () => {
    writeFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), JSON.stringify({ model: 'claude-opus-4-5' }))
    writeAgentCapabilities(TEST_AGENT, ['tag1'])
    const raw = JSON.parse(require('fs').readFileSync(join(agentDir(TEST_AGENT), 'agent-config.json'), 'utf-8'))
    expect(raw.model).toBe('claude-opus-4-5')
    expect(raw.capabilities).toEqual(['tag1'])
  })
})
