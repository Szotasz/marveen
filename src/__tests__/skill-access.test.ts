// Unit tests for readSkillAccessConfig() exported from src/web/routes/skills.ts.
// Tests cover: missing file, malformed JSON, non-array values, valid config,
// and the MAIN_AGENT_ID fail-safe.
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
