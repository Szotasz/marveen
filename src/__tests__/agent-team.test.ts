import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, AGENTS_BASE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'agent-team-test-'))
  const agentsDir = join(root, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  return { TMP_ROOT: root, AGENTS_BASE_DIR: agentsDir }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR: join(TMP_ROOT, 'store'),
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    AGENTS_BASE_DIR,
    agentDir: (name: string) => join(AGENTS_BASE_DIR, name),
    readFileOr: (path: string, fallback: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readFileSync, existsSync } = require('node:fs')
        return existsSync(path) ? readFileSync(path, 'utf-8') : fallback
      } catch { return fallback }
    },
    listAgentNames: vi.fn().mockReturnValue(['alice', 'bob']),
    readAgentSecurityProfile: vi.fn().mockReturnValue(null),
  }
})

import {
  readAgentTeam, writeAgentTeam, resolveSecurityProfileId,
  sanitizeTeamConfig, reportsToCreatesCycle, cleanupTeamReferences,
  DEFAULT_TEAM,
} from '../web/agent-team.js'

function makeAgentDir(name: string): string {
  const dir = join(AGENTS_BASE_DIR, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('readAgentTeam', () => {
  it('returns DEFAULT_TEAM when no config file', () => {
    makeAgentDir('no-config')
    const team = readAgentTeam('no-config')
    expect(team.role).toBe('member')
    expect(team.reportsTo).toBeNull()
    expect(team.delegatesTo).toEqual([])
  })

  it('reads team config from agent-config.json', () => {
    makeAgentDir('has-config')
    writeFileSync(
      join(AGENTS_BASE_DIR, 'has-config', 'agent-config.json'),
      JSON.stringify({ team: { role: 'leader', reportsTo: null, delegatesTo: ['bob'], autoDelegation: true } }),
    )
    const team = readAgentTeam('has-config')
    expect(team.role).toBe('leader')
    expect(team.delegatesTo).toContain('bob')
    expect(team.autoDelegation).toBe(true)
  })

  it('normalizes unknown role to member', () => {
    makeAgentDir('bad-role')
    writeFileSync(
      join(AGENTS_BASE_DIR, 'bad-role', 'agent-config.json'),
      JSON.stringify({ team: { role: 'superadmin' } }),
    )
    expect(readAgentTeam('bad-role').role).toBe('member')
  })

  it('trims whitespace from reportsTo', () => {
    makeAgentDir('trim-reports')
    writeFileSync(
      join(AGENTS_BASE_DIR, 'trim-reports', 'agent-config.json'),
      JSON.stringify({ team: { reportsTo: '  alice  ' } }),
    )
    expect(readAgentTeam('trim-reports').reportsTo).toBe('alice')
  })

  it('returns null reportsTo for empty string', () => {
    makeAgentDir('empty-reports')
    writeFileSync(
      join(AGENTS_BASE_DIR, 'empty-reports', 'agent-config.json'),
      JSON.stringify({ team: { reportsTo: '' } }),
    )
    expect(readAgentTeam('empty-reports').reportsTo).toBeNull()
  })
})

describe('writeAgentTeam / readAgentTeam roundtrip', () => {
  it('persists and retrieves a full team config', () => {
    makeAgentDir('roundtrip')
    const config = { role: 'leader' as const, reportsTo: 'marveen', delegatesTo: ['alice'], autoDelegation: true, trustFrom: ['bob'] }
    writeAgentTeam('roundtrip', config)
    const read = readAgentTeam('roundtrip')
    expect(read.role).toBe('leader')
    expect(read.reportsTo).toBe('marveen')
    expect(read.delegatesTo).toEqual(['alice'])
    expect(read.trustFrom).toEqual(['bob'])
  })

  it('preserves other keys in agent-config.json', () => {
    makeAgentDir('preserve-keys')
    writeFileSync(
      join(AGENTS_BASE_DIR, 'preserve-keys', 'agent-config.json'),
      JSON.stringify({ someOtherKey: 'value', team: { role: 'member' } }),
    )
    writeAgentTeam('preserve-keys', { ...DEFAULT_TEAM, role: 'leader' })
    // Read raw JSON to verify
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = JSON.parse(require('node:fs').readFileSync(join(AGENTS_BASE_DIR, 'preserve-keys', 'agent-config.json'), 'utf-8'))
    expect(raw.someOtherKey).toBe('value')
    expect(raw.team.role).toBe('leader')
  })
})

describe('resolveSecurityProfileId', () => {
  it('returns applier for leader with no explicit profile', () => {
    expect(resolveSecurityProfileId(null, { role: 'leader' })).toBe('applier')
  })

  it('returns default for member with no explicit profile', () => {
    expect(resolveSecurityProfileId(null, { role: 'member' })).toBe('default')
  })

  it('returns default when stored profile is "default"', () => {
    expect(resolveSecurityProfileId('default', { role: 'leader' })).toBe('applier')
  })

  it('returns explicit profile when set (non-default)', () => {
    expect(resolveSecurityProfileId('sub-dev', { role: 'member' })).toBe('sub-dev')
    expect(resolveSecurityProfileId('applier', { role: 'member' })).toBe('applier')
  })

  it('strips whitespace from stored profile', () => {
    expect(resolveSecurityProfileId('  ', { role: 'leader' })).toBe('applier')
  })
})

describe('reportsToCreatesCycle', () => {
  const readTeam = (name: string) => ({
    alice: { reportsTo: 'bob' },
    bob: { reportsTo: 'marveen' },
    charlie: { reportsTo: null },
  }[name] ?? { reportsTo: null })

  it('returns false when proposedReportsTo is null', () => {
    expect(reportsToCreatesCycle('alice', null, readTeam, 'marveen')).toBe(false)
  })

  it('returns false when proposedReportsTo is mainAgentId', () => {
    expect(reportsToCreatesCycle('alice', 'marveen', readTeam, 'marveen')).toBe(false)
  })

  it('returns true for direct self-reference', () => {
    expect(reportsToCreatesCycle('alice', 'alice', readTeam, 'marveen')).toBe(true)
  })

  it('returns true for indirect cycle (alice -> bob -> alice)', () => {
    const cyclicRead = (name: string) => ({
      bob: { reportsTo: 'alice' },
    }[name] ?? { reportsTo: null })
    expect(reportsToCreatesCycle('alice', 'bob', cyclicRead, 'marveen')).toBe(true)
  })

  it('returns false for valid chain', () => {
    expect(reportsToCreatesCycle('charlie', 'alice', readTeam, 'marveen')).toBe(false)
  })
})

describe('sanitizeTeamConfig', () => {
  it('removes self-reference from delegatesTo', () => {
    const team = { role: 'member' as const, reportsTo: null, delegatesTo: ['alice', 'alice-self'], autoDelegation: false, trustFrom: [] }
    const { team: out, warnings } = sanitizeTeamConfig('alice', team)
    expect(out.delegatesTo).not.toContain('alice')
    expect(warnings.droppedSelf).toContain('delegatesTo')
  })

  it('removes unknown agents from trustFrom', () => {
    const team = { role: 'member' as const, reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: ['ghost'] }
    const { warnings } = sanitizeTeamConfig('alice', team)
    expect(warnings.droppedUnknown).toContain('ghost')
  })

  it('keeps known agents in delegatesTo', () => {
    const team = { role: 'member' as const, reportsTo: null, delegatesTo: ['bob'], autoDelegation: false, trustFrom: [] }
    const { team: out } = sanitizeTeamConfig('alice', team)
    expect(out.delegatesTo).toContain('bob')
  })

  it('clears self-reference in reportsTo', () => {
    const team = { role: 'member' as const, reportsTo: 'alice', delegatesTo: [], autoDelegation: false, trustFrom: [] }
    const { team: out, warnings } = sanitizeTeamConfig('alice', team)
    expect(out.reportsTo).toBeNull()
    expect(warnings.droppedSelf).toContain('reportsTo')
  })

  it('clears unknown reportsTo', () => {
    const team = { role: 'member' as const, reportsTo: 'ghost-agent', delegatesTo: [], autoDelegation: false, trustFrom: [] }
    const { team: out, warnings } = sanitizeTeamConfig('alice', team)
    expect(out.reportsTo).toBeNull()
    expect(warnings.droppedUnknown).toContain('ghost-agent')
  })
})
