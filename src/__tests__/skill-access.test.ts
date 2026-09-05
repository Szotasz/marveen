// Unit tests for readSkillAccessConfig() exported from src/web/routes/skills.ts,
// and for the gate-logic exports from scripts/hooks/skill-access-gate.mjs.
//
// STORE_DIR is never reached because readFileSync is stubbed; no config mock needed.
import { describe, it, expect, beforeEach, vi } from 'vitest'

let _mockFsContent: string | null = null

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (): string => {
      if (_mockFsContent !== null) return _mockFsContent
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
})

import { readSkillAccessConfig } from '../web/routes/skills.js'
import { MAIN_AGENT_ID } from '../config.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { deriveAgentIdFromCwd, gateDecision } from '../../scripts/hooks/skill-access-gate.mjs'

describe('readSkillAccessConfig', () => {
  beforeEach(() => {
    _mockFsContent = null
  })

  it('returns an empty Record when the file is missing', () => {
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty Record for malformed JSON', () => {
    _mockFsContent = 'not json{{'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty Record for a non-object root value (array)', () => {
    _mockFsContent = '[]'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('builds the correct Record for a valid config', () => {
    _mockFsContent = JSON.stringify({ alpha: ['agent-a', 'agent-b'], beta: ['agent-c'] })
    const result = readSkillAccessConfig()
    expect(result['alpha']).toContain('agent-a')
    expect(result['alpha']).toContain('agent-b')
    expect(result['beta']).toContain('agent-c')
  })

  it('always includes MAIN_AGENT_ID in restricted lists (fail-safe)', () => {
    _mockFsContent = JSON.stringify({ 'secret-skill': ['agent-a'] })
    const result = readSkillAccessConfig()
    expect(result['secret-skill']).toContain(MAIN_AGENT_ID)
  })

  it('skips entries with non-array values', () => {
    _mockFsContent = JSON.stringify({ good: ['agent-a'], bad_string: 'oops', bad_number: 42 })
    const result = readSkillAccessConfig()
    expect('bad_string' in result).toBe(false)
    expect('bad_number' in result).toBe(false)
    expect(result['good']).toContain(MAIN_AGENT_ID)
  })
})

// --- gate-script exports: agent identity derivation (FIX 1: nested cwd) ---

describe('deriveAgentIdFromCwd', () => {
  it('identifies a sub-agent from a direct agents/<name> path', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/')).toBe('agent-a')
  })

  it('identifies a sub-agent from a nested path inside agents/<name> (FIX 1: no end-anchor bypass)', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/workspace')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/workspace/some-project')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-b/.claude/worktree-abc')).toBe('agent-b')
  })

  it('returns null for the repo root (main agent)', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen')).toBeNull()
    expect(deriveAgentIdFromCwd('/home/user/marveen/')).toBeNull()
  })

  it('returns null for paths that happen to contain "agents" as a directory prefix in an unrelated segment', () => {
    // A path like /home/agents-backup/marveen must not match
    expect(deriveAgentIdFromCwd('/home/user/projects/marveen')).toBeNull()
  })
})

// --- gate-script exports: access decision (known-positive control) ---

describe('gateDecision', () => {
  it('allows non-Skill tool calls unconditionally', () => {
    expect(gateDecision('Bash', { command: 'ls' }, 'agent-a', {})).toEqual({ allow: true })
    expect(gateDecision('WebFetch', { url: 'https://x.com' }, 'agent-a', { 'web-skill': ['main-agent'] })).toEqual({ allow: true })
  })

  it('allows a main agent (agentId null) regardless of config', () => {
    const config = { 'secret-skill': ['agent-a'] }
    expect(gateDecision('Skill', { skill: 'secret-skill' }, null, config)).toEqual({ allow: true })
  })

  it('allows a skill that is not in the config', () => {
    expect(gateDecision('Skill', { skill: 'unknown-skill' }, 'agent-b', {})).toEqual({ allow: true })
  })

  it('allows a listed agent to call a restricted skill', () => {
    const config = { 'restricted-skill': ['agent-a', 'main-agent'] }
    expect(gateDecision('Skill', { skill: 'restricted-skill' }, 'agent-a', config)).toEqual({ allow: true })
  })

  it('DENIES an unlisted agent calling a restricted skill (known-positive control)', () => {
    const config = { 'restricted-skill': ['main-agent'] }
    const result = gateDecision('Skill', { skill: 'restricted-skill' }, 'agent-b', config)
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('"restricted-skill"')
    expect(result.reason).toContain('"agent-b"')
  })

  it('DENIES any sub-agent when config is null (corrupt config fail-closed, FIX 2)', () => {
    const result = gateDecision('Skill', { skill: 'any-skill' }, 'agent-a', null)
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('corrupt or unreadable')
  })

  it('fails open for a malformed (non-array) allow-list entry', () => {
    const config = { 'bad-entry': 'not-an-array' }
    expect(gateDecision('Skill', { skill: 'bad-entry' }, 'agent-b', config)).toEqual({ allow: true })
  })

  it('handles a missing skill name as allow', () => {
    expect(gateDecision('Skill', {}, 'agent-b', { '': ['main-agent'] })).toEqual({ allow: true })
    expect(gateDecision('Skill', null, 'agent-b', {})).toEqual({ allow: true })
  })
})
