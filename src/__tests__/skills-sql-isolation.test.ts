import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  createSkill, getSkill, updateSkill, deleteSkill,
  listSkillsForTenant, listAllSkills,
  grantSkillAccess, revokeSkillAccess, listSkillAccess,
} from '../db.js'

// Integration tests: real SQLite in-memory, all migrations applied.
// Verifies tenant isolation for SQL-backed skills (716).

beforeAll(() => {
  initDatabase(':memory:')
})

describe('SQL skills tenant isolation (716)', () => {
  it('tenant A cannot see tenant B skills via listSkillsForTenant', () => {
    createSkill({ id: 'iso-acme-skill', name: 'Acme Skill', content: 'content A', tenant_id: 'iso-acme' })
    createSkill({ id: 'iso-corp-skill', name: 'Corp Skill', content: 'content B', tenant_id: 'iso-corp' })

    const acmeSkills = listSkillsForTenant('iso-acme')
    expect(acmeSkills.some(s => s.id === 'iso-acme-skill')).toBe(true)
    expect(acmeSkills.some(s => s.id === 'iso-corp-skill')).toBe(false)

    const corpSkills = listSkillsForTenant('iso-corp')
    expect(corpSkills.some(s => s.id === 'iso-corp-skill')).toBe(true)
    expect(corpSkills.some(s => s.id === 'iso-acme-skill')).toBe(false)
  })

  it('fleet skills (tenant_id=fleet, is_global=1) are NOT visible to B2B tenants by default', () => {
    createSkill({ id: 'fleet-priv-skill', name: 'Fleet Private', content: 'fleet content', tenant_id: 'fleet', is_global: true })

    const visibleToTenant = listSkillsForTenant('iso-acme')
    expect(visibleToTenant.some(s => s.id === 'fleet-priv-skill')).toBe(false)
  })

  it('fleet skill becomes visible after explicit grantSkillAccess', () => {
    createSkill({ id: 'fleet-granted-skill', name: 'Fleet Granted', content: 'fleet content', tenant_id: 'fleet', is_global: true })
    grantSkillAccess('fleet-granted-skill', 'iso-acme', 'admin')

    const skills = listSkillsForTenant('iso-acme')
    expect(skills.some(s => s.id === 'fleet-granted-skill')).toBe(true)
  })

  it('revokeSkillAccess removes the visibility for the granted tenant', () => {
    createSkill({ id: 'fleet-revoke-skill', name: 'Fleet Revoke', content: 'content', tenant_id: 'fleet', is_global: true })
    grantSkillAccess('fleet-revoke-skill', 'iso-acme', 'admin')
    revokeSkillAccess('fleet-revoke-skill', 'iso-acme')

    const skills = listSkillsForTenant('iso-acme')
    expect(skills.some(s => s.id === 'fleet-revoke-skill')).toBe(false)
  })

  it('deleteSkill cascades skill_tenant_access rows', () => {
    createSkill({ id: 'cascade-skill', name: 'Cascade', content: 'content', tenant_id: 'iso-acme' })
    grantSkillAccess('cascade-skill', 'iso-corp', 'admin')

    deleteSkill('cascade-skill')

    const corpSkills = listSkillsForTenant('iso-corp')
    expect(corpSkills.some(s => s.id === 'cascade-skill')).toBe(false)
    const access = listSkillAccess('cascade-skill')
    expect(access).toHaveLength(0)
  })

  it('updateSkill updates content and description', () => {
    createSkill({ id: 'update-skill', name: 'Update Me', content: 'v1', tenant_id: 'iso-acme' })
    const updated = updateSkill('update-skill', { content: 'v2', description: 'updated desc' })
    expect(updated?.content).toBe('v2')
    expect(updated?.description).toBe('updated desc')
  })

  it('updateSkill on non-existent id returns undefined', () => {
    const result = updateSkill('does-not-exist-xyz', { content: 'x' })
    expect(result).toBeUndefined()
  })

  it('getSkill returns undefined for unknown id', () => {
    expect(getSkill('no-such-skill-xyz')).toBeUndefined()
  })

  it('listAllSkills returns skills from all tenants', () => {
    createSkill({ id: 'all-acme', name: 'All Acme', content: 'ca', tenant_id: 'iso-acme-all' })
    createSkill({ id: 'all-corp', name: 'All Corp', content: 'cb', tenant_id: 'iso-corp-all' })
    createSkill({ id: 'all-fleet', name: 'All Fleet', content: 'cc', tenant_id: 'fleet', is_global: true })

    const all = listAllSkills()
    expect(all.some(s => s.id === 'all-acme')).toBe(true)
    expect(all.some(s => s.id === 'all-corp')).toBe(true)
    expect(all.some(s => s.id === 'all-fleet')).toBe(true)
  })

  it('grantSkillAccess is idempotent (double-grant does not throw)', () => {
    createSkill({ id: 'idempotent-skill', name: 'Idempotent', content: 'c', tenant_id: 'iso-acme' })
    grantSkillAccess('idempotent-skill', 'iso-corp', 'admin')
    expect(() => grantSkillAccess('idempotent-skill', 'iso-corp', 'admin')).not.toThrow()
  })
})
