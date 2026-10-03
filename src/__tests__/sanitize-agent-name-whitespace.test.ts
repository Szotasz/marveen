import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeAgentName, sanitizeSkillName, sanitizeScheduleName } from '../web/sanitize.js'

// Card 39b36369: sanitizeAgentName deleted whitespace instead of hyphenating
// it, so "Lean Writer" became "leanwriter" while sanitizeScheduleName turned
// the same input into "lean-writer". Only NEW names change: every lookup path
// (URL agent name, bundle export, fleet import) feeds an existing directory
// name, which cannot contain whitespace, and a whitespace-free input sanitizes
// exactly as before.

describe('sanitizeAgentName: whitespace', () => {
  it('turns whitespace into a single hyphen', () => {
    expect(sanitizeAgentName('Lean Writer')).toBe('lean-writer')
    expect(sanitizeAgentName('  lean \t  writer  ')).toBe('lean-writer')
    expect(sanitizeAgentName('Új Név!')).toBe('uj-nev')
  })

  it('agrees with sanitizeScheduleName on plain ASCII input', () => {
    for (const s of ['Lean Writer', 'a  b', 'x - y', ' lead ']) {
      expect(sanitizeAgentName(s)).toBe(sanitizeScheduleName(s))
    }
  })

  it('leaves every whitespace-free name exactly as before (no retroactive change)', () => {
    // The pre-change pipeline, inline: an existing directory name must map to itself.
    const old = (raw: string) => raw.trim().toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
    for (const s of ['leanwriter', 'lean-chief', 'gembaecho', 'Étrendíró', 'a--b', '-x-', 'x'.repeat(60)]) {
      expect(sanitizeAgentName(s)).toBe(old(s))
    }
  })

  it('still strips path traversal', () => {
    expect(sanitizeAgentName('../ etc / passwd')).toBe('etc-passwd')
    expect(sanitizeAgentName(' . . ')).toBe('')
  })

  it('skill names follow the same rule', () => {
    expect(sanitizeSkillName('my skill')).toBe('my-skill')
  })
})

describe('POST /api/agents refuses the main agent id', () => {
  // Source-level, like agent-create-no-destructive-rollback.test.ts: the route
  // awaits real CLI calls and writes the live agents dir. The main agent is in
  // PROJECT_ROOT, so existsSync(agentDir(name)) never sees it -- the reserved
  // check has to exist and run before scaffolding.
  const src = readFileSync(join(import.meta.dirname, '..', 'web/routes/agents.ts'), 'utf8')
  it('checks name === MAIN_AGENT_ID before scaffoldAgentDir', () => {
    const guard = src.indexOf("if (name === MAIN_AGENT_ID) { json(res, { error: 'Name is reserved for the main agent' }, 409)")
    const scaffold = src.indexOf('scaffoldAgentDir(name)')
    expect(guard).toBeGreaterThan(-1)
    expect(scaffold).toBeGreaterThan(guard)
    expect(src.lastIndexOf("path === '/api/agents' && method === 'POST'", guard)).toBeGreaterThan(-1)
  })
})
