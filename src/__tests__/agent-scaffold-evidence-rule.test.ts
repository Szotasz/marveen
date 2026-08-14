// Tests for the evidence-rule block that every agent's CLAUDE.md carries.
//
// Background: on 2026-08-12 the main agent asserted three unverified technical
// claims in a row about the Meta Ads connector (it had "expired", it had
// "stopped working", a sub-agent "could never reach it"). All three were false,
// and a request to an external contractor was already drafted on top of them.
// The owner's instruction was to nail the rule down once and for all, so it
// lives in the scaffold rather than in a memory file: every respawn re-applies
// it to every agent, and a persona rewrite cannot silently drop it.
//
// Source-level assertions, matching the technique of the sibling scaffold tests
// (agent-scaffold-formatting-rules.test.ts): the body is a template built inside
// the generator, so the source is the only surface testable without a model.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const WEB = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
const AGENT_PROCESS = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

const evidenceBody = SCAFFOLD.slice(
  SCAFFOLD.indexOf('function buildEvidenceBody('),
  SCAFFOLD.indexOf('export function ensureEvidenceSection('),
)

describe('evidence-rule scaffold block', () => {
  it('defines BEGIN/END markers matching the generated-block convention', () => {
    expect(SCAFFOLD).toContain("const EVIDENCE_BEGIN = '<!-- BEGIN GENERATED: evidence-rule")
    expect(SCAFFOLD).toContain("const EVIDENCE_END = '<!-- END GENERATED: evidence-rule -->'")
  })

  it('uses a non-greedy block regex so it cannot eat unrelated content', () => {
    const re = SCAFFOLD.slice(SCAFFOLD.indexOf('const EVIDENCE_BLOCK_RE'))
    expect(re.slice(0, 300)).toContain('[\\\\s\\\\S]*?')
  })

  it('ensureEvidenceSection is exported and writes atomically', () => {
    expect(SCAFFOLD).toContain('export function ensureEvidenceSection(')
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureEvidenceSection('))
    expect(fn.slice(0, 1200)).toContain('atomicWriteFileSync')
  })

  it('resolves the main agent CLAUDE.md at PROJECT_ROOT, sub-agents under agentDir', () => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureEvidenceSection('))
    expect(fn.slice(0, 800)).toContain('name === MAIN_AGENT_ID')
    expect(fn.slice(0, 800)).toContain("join(PROJECT_ROOT, 'CLAUDE.md')")
    expect(fn.slice(0, 800)).toContain("join(agentDir(name), 'CLAUDE.md')")
  })

  it('returns without writing when the computed block is unchanged', () => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensureEvidenceSection('))
    expect(fn.slice(0, 1200)).toContain('if (updated === existing) return')
  })

  it('is applied to the main agent on startup and to every sub-agent on respawn', () => {
    expect(WEB).toContain('ensureEvidenceSection(MAIN_AGENT_ID)')
    expect(AGENT_PROCESS).toContain('ensureEvidenceSection(name)')
  })

  it('states the three allowed forms of a claim', () => {
    expect(evidenceBody).toContain('**Tény.**')
    expect(evidenceBody).toContain('**Tipp.**')
    expect(evidenceBody).toContain('**Nem tudom.**')
  })

  it('forbids the specific failures that produced the rule', () => {
    // inventing a cause, declaring something impossible, guessing dates,
    // and building downstream work on an unverified claim
    expect(evidenceBody).toContain('Nem találsz ki magyarázatot')
    expect(evidenceBody).toContain('lejárt vagy leállt, amíg meg nem nézted')
    expect(evidenceBody).toContain('emlékezetből')
    expect(evidenceBody).toContain('RÁÉPÜL')
  })

  // 2026-08-14: the recurring form of the failure is not a long false claim but
  // a short concrete detail written from habit -- support@connectors.hu, which
  // bounced 550 because nobody had ever seen that address.
  it('names the concrete-detail class and forbids the role-address habit', () => {
    expect(evidenceBody).toContain('A konkrétum mindig forrásból jön')
    expect(evidenceBody).toContain('`support@`, `info@`, `hello@` szokásból')
    expect(evidenceBody).toContain('From fejléce')
    // "no source" has to be an allowed answer, or the rule just moves the guess
    expect(evidenceBody).toContain('nem találom sehol')
  })

  it('points at the mechanical half of the rule (the recipient ledger)', () => {
    expect(evidenceBody).toContain('store/verified-recipients.json')
    expect(evidenceBody).toContain('node scripts/recipient-ledger.mjs add')
  })

  it('keeps Hungarian accents and uses no em dash, like its sibling blocks', () => {
    expect(evidenceBody).toContain('ellenőrizz')
    expect(evidenceBody).not.toContain('—')
  })
})
