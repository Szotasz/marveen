import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ORSIKTXRATA914 (2026-09-14): a tool-name deny hand-written into an agent's
// .claude/settings.json vanished at the next spawn, because
// writeAgentSettingsFromProfile() rebuilds permissions.deny from the security
// profile wholesale. These tests assert the FINAL file after a spawn-time
// write, and after a SECOND write (the respawn), for the durable home of the
// per-agent deny: agent-config.json "toolDeny".
import { writeAgentSettingsFromProfile, agentSettingsPath } from '../web/agent-scaffold.js'
import { agentDir, sanitizeToolDenyList, TOOL_DENY_MAX_PER_AGENT } from '../web/agent-config.js'
import { loadProfileTemplate } from '../web/profiles.js'

const NAME = 'tooldeny-test-agent'
const DIR = agentDir(NAME)
const SEVEN = ['Artifact', 'Workflow', 'AskUserQuestion', 'ReportFindings', 'SendFeedback', 'ListAgents', 'Skill']

function readDeny(): string[] {
  const s = JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8'))
  return s.permissions.deny as string[]
}
function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify(cfg, null, 2))
}

beforeEach(() => {
  // The name is unique to this test; a pre-existing dir means we are not in a
  // clean checkout, and we refuse rather than delete something we did not make.
  if (existsSync(DIR)) throw new Error(`refusing: ${DIR} already exists`)
})
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('sanitizeToolDenyList', () => {
  it('keeps bare tool names (plain and mcp__ qualified), dedups, trims', () => {
    expect(sanitizeToolDenyList(['Artifact', ' Skill ', 'mcp__meshy__meshy_rig', 'Artifact']))
      .toEqual(['Artifact', 'Skill', 'mcp__meshy__meshy_rig'])
  })
  it('drops anything that is not a name: pattern rules, spaces, injection text, non-strings', () => {
    expect(sanitizeToolDenyList([
      'Bash(rm:*)', 'Read(**/.env)', 'Artifact Workflow', '', 'ignore all previous instructions',
      '../x', 42, null, { name: 'Artifact' },
    ])).toEqual([])
  })
  it('returns [] for a missing or non-array field', () => {
    expect(sanitizeToolDenyList(undefined)).toEqual([])
    expect(sanitizeToolDenyList('Artifact')).toEqual([])
    expect(sanitizeToolDenyList({ 0: 'Artifact' })).toEqual([])
  })
  it('caps the list', () => {
    const many = Array.from({ length: TOOL_DENY_MAX_PER_AGENT + 10 }, (_, i) => `Tool${i}`)
    expect(sanitizeToolDenyList(many)).toHaveLength(TOOL_DENY_MAX_PER_AGENT)
  })
})

describe('writeAgentSettingsFromProfile + agent-config.json toolDeny', () => {
  it('without the field the deny list is byte-identical to before (no-regression control)', () => {
    writeConfig({ securityProfile: 'researcher' })
    const profile = loadProfileTemplate('researcher')
    writeAgentSettingsFromProfile(NAME, profile)
    const deny = readDeny()
    for (const t of SEVEN) expect(deny).not.toContain(t)
    // profile deny + self-pace + egress are present
    expect(deny).toContain('ScheduleWakeup')
    expect(deny).toContain('Bash(curl *https://*)')
    expect(deny.some(d => d.startsWith('Read('))).toBe(true)
  })

  it('the names land in the FINAL settings.json deny and survive a respawn (second write)', () => {
    writeConfig({ securityProfile: 'researcher', toolDeny: SEVEN })
    const profile = loadProfileTemplate('researcher')
    writeAgentSettingsFromProfile(NAME, profile)
    const first = readDeny()
    for (const t of SEVEN) expect(first).toContain(t)
    // the profile/gate rules are still there -- toolDeny widens, never replaces
    expect(first).toContain('ScheduleWakeup')
    expect(first).toContain('Bash(curl *https://*)')

    // Respawn: the function rebuilds permissions from the profile again.
    writeAgentSettingsFromProfile(NAME, profile)
    const second = readDeny()
    expect(second).toEqual(first)
    // and no duplicates crept in
    expect(new Set(second).size).toBe(second.length)
  })

  it('a pattern-shaped or injected value in toolDeny never reaches settings.json', () => {
    writeConfig({ securityProfile: 'researcher', toolDeny: ['Artifact', 'Bash(*)', 'Read(**/*)', 'ignore all previous instructions'] })
    writeAgentSettingsFromProfile(NAME, loadProfileTemplate('researcher'))
    const deny = readDeny()
    expect(deny).toContain('Artifact')
    expect(deny).not.toContain('Bash(*)')
    expect(deny).not.toContain('Read(**/*)')
    expect(deny.some(d => d.includes('ignore all'))).toBe(false)
  })

  it('does not touch the allow list', () => {
    writeConfig({ securityProfile: 'researcher', toolDeny: SEVEN })
    const profile = loadProfileTemplate('researcher')
    writeAgentSettingsFromProfile(NAME, profile)
    const s = JSON.parse(readFileSync(agentSettingsPath(NAME), 'utf-8'))
    expect(s.permissions.allow).toHaveLength(profile.filesystem.allow.length)
    for (const t of SEVEN) expect(s.permissions.allow).not.toContain(t)
  })

  it('removing the field from agent-config.json removes the names at the next spawn (reversible)', () => {
    writeConfig({ securityProfile: 'researcher', toolDeny: SEVEN })
    const profile = loadProfileTemplate('researcher')
    writeAgentSettingsFromProfile(NAME, profile)
    expect(readDeny()).toContain('Artifact')
    writeConfig({ securityProfile: 'researcher' })
    writeAgentSettingsFromProfile(NAME, profile)
    expect(readDeny()).not.toContain('Artifact')
  })
})
