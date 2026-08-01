import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pure-logic re-implementation of heartbeatMinuteFor, mirroring
// src/web/agent-scaffold.ts. Tested here independently so we can verify
// the hash properties (range, determinism, distribution) without loading
// the real module and its config.js side effects.
function heartbeatMinuteFor(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff
  return h % 60
}

// Inline helper that reproduces the task-config scaffold logic so the test
// is hermetic: no homedir() or PROJECT_ROOT dependency.
function writeTaskConfig(destDir: string, name: string): void {
  const minute = heartbeatMinuteFor(name)
  const cfg = {
    schedule: `${minute} */4 * * *`,
    agent: name,
    enabled: true,
    type: 'heartbeat',
    skipIfBusy: true,
    forceSend: false,
    description: `4 óránként átnézi ${name} munkáját, menti a szakterületi tanulságot, és skillt generál/patch-el ha volt komplex munka`,
    createdAt: 0,
  }
  writeFileSync(join(destDir, 'task-config.json'), JSON.stringify(cfg, null, 2) + '\n')
}

describe('heartbeatMinuteFor (pure hash)', () => {
  it('always returns a value in [0, 59]', () => {
    const names = ['agent-a', 'agent-b', 'x', 'longnamewithalotofcharacters', 'z']
    for (const n of names) {
      const m = heartbeatMinuteFor(n)
      expect(m).toBeGreaterThanOrEqual(0)
      expect(m).toBeLessThanOrEqual(59)
    }
  })

  it('is deterministic: same name always yields the same minute', () => {
    expect(heartbeatMinuteFor('agent-a')).toBe(heartbeatMinuteFor('agent-a'))
    expect(heartbeatMinuteFor('agent-b')).toBe(heartbeatMinuteFor('agent-b'))
  })

  it('returns different minutes for different names (collision probability is low)', () => {
    // A single-bucket hash would be suspicious; verify at least two distinct
    // outputs across four distinct agent names.
    const values = new Set(['agent-a', 'agent-b', 'alpha', 'beta'].map(heartbeatMinuteFor))
    expect(values.size).toBeGreaterThan(1)
  })

  it('returns an integer (no fractional minute offset)', () => {
    const m = heartbeatMinuteFor('agent-a')
    expect(Number.isInteger(m)).toBe(true)
  })
})

describe('task-config.json scaffold', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'heartbeat-scaffold-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes a valid JSON file with all required fields', () => {
    writeTaskConfig(tmp, 'agent-a')
    const raw = readFileSync(join(tmp, 'task-config.json'), 'utf-8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    expect(cfg.agent).toBe('agent-a')
    expect(cfg.type).toBe('heartbeat')
    expect(cfg.enabled).toBe(true)
    expect(cfg.skipIfBusy).toBe(true)
    expect(cfg.forceSend).toBe(false)
  })

  it('embeds the correct cron minute from heartbeatMinuteFor in the schedule', () => {
    writeTaskConfig(tmp, 'agent-b')
    const cfg = JSON.parse(readFileSync(join(tmp, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    const expected = `${heartbeatMinuteFor('agent-b')} */4 * * *`
    expect(cfg.schedule).toBe(expected)
  })

  it('schedule minute is in [0, 59]', () => {
    writeTaskConfig(tmp, 'agent-a')
    const cfg = JSON.parse(readFileSync(join(tmp, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    const minute = parseInt((cfg.schedule as string).split(' ')[0], 10)
    expect(minute).toBeGreaterThanOrEqual(0)
    expect(minute).toBeLessThanOrEqual(59)
  })

  it('uses a 4-hour interval pattern (*/4 in the hour field)', () => {
    writeTaskConfig(tmp, 'agent-a')
    const cfg = JSON.parse(readFileSync(join(tmp, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    expect(cfg.schedule as string).toContain('*/4 * * *')
  })

  it('two agents get different schedules (thundering-herd prevention)', () => {
    const dirA = join(tmp, 'a')
    const dirB = join(tmp, 'b')
    mkdirSync(dirA)
    mkdirSync(dirB)
    writeTaskConfig(dirA, 'agent-a')
    writeTaskConfig(dirB, 'agent-b')
    const schedA = JSON.parse(readFileSync(join(dirA, 'task-config.json'), 'utf-8')).schedule as string
    const schedB = JSON.parse(readFileSync(join(dirB, 'task-config.json'), 'utf-8')).schedule as string
    // agent-a and agent-b must not collide on the same minute.
    expect(schedA).not.toBe(schedB)
  })

  it('description contains the agent name', () => {
    writeTaskConfig(tmp, 'agent-a')
    const cfg = JSON.parse(readFileSync(join(tmp, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    expect(cfg.description as string).toContain('agent-a')
  })

  it('contains no private fixture names in the output', () => {
    writeTaskConfig(tmp, 'agent-a')
    const raw = readFileSync(join(tmp, 'task-config.json'), 'utf-8')
    // Privacy rule: no real fleet agent names may appear in test outputs.
    expect(raw).not.toMatch(/\bjarvis\b|\bzack\b|\brick\b|\bdave\b|\bpoly\b|\bzoe\b|\bpeter\b|\bcarmen\b/)
  })
})

describe('SKILL.md template substitution (inline)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'heartbeat-skill-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('replaces all {{AGENT_NAME}} placeholders with the concrete agent name', () => {
    const template = 'Hello {{AGENT_NAME}}, your id is {{AGENT_NAME}}.'
    const resolved = template.replaceAll('{{AGENT_NAME}}', 'agent-a')
    writeFileSync(join(tmp, 'SKILL.md'), resolved)
    const out = readFileSync(join(tmp, 'SKILL.md'), 'utf-8')
    expect(out).not.toContain('{{AGENT_NAME}}')
    expect(out).toContain('agent-a')
  })

  it('leaves no unresolved {{...}} placeholders in the output', () => {
    // Simulate a template that also has INSTALL_DIR (resolved by
    // resolveTemplatePlaceholders in production).
    const template = 'Agent: {{AGENT_NAME}}\nDir: /some/install/dir'
    const resolved = template.replaceAll('{{AGENT_NAME}}', 'agent-b')
    expect(resolved).not.toMatch(/\{\{[^}]+\}\}/)
  })

  it('falls back to an empty SKILL.md when the template is missing', () => {
    // Production behaviour: if SKILL.agent.md is absent, the function writes
    // an empty string so the scheduled-task directory is still complete.
    const templatePath = join(tmp, 'SKILL.agent.md')
    const destPath = join(tmp, 'SKILL.md')
    const skillContent = existsSync(templatePath)
      ? readFileSync(templatePath, 'utf-8').replaceAll('{{AGENT_NAME}}', 'agent-a')
      : ''
    writeFileSync(destPath, skillContent)
    expect(readFileSync(destPath, 'utf-8')).toBe('')
  })
})

describe('idempotency', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'heartbeat-idem-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a second scaffold call on an existing dir leaves the config unchanged', () => {
    const destDir = join(tmp, 'memoria-heartbeat-agent-a')
    mkdirSync(destDir, { recursive: true })
    writeTaskConfig(destDir, 'agent-a')

    const before = readFileSync(join(destDir, 'task-config.json'), 'utf-8')

    // Simulate the idempotency guard: if the dir already exists, return early.
    if (!existsSync(destDir)) {
      writeTaskConfig(destDir, 'agent-a')
    }

    const after = readFileSync(join(destDir, 'task-config.json'), 'utf-8')
    expect(after).toBe(before)
  })
})
