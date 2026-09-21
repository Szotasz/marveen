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
    // RECOVERYPATH920: the command has to be runnable from the cwd of the agent
    // it is written FOR. Sub-agents run in agents/<name>/, which has no
    // scripts/ directory, so the relative `node scripts/recipient-ledger.mjs`
    // died with "Cannot find module" in exactly the place the gate points at.
    // Source-level like its siblings: the absolute path is built from
    // PROJECT_ROOT, and the relative spelling must not come back.
    expect(evidenceBody).toContain("join(PROJECT_ROOT, 'scripts', 'recipient-ledger.mjs')")
    expect(evidenceBody).not.toContain('node scripts/recipient-ledger.mjs')
  })

  // GATESCOPE921: the block used to say the hook measures "minden címet" and
  // lets nothing unknown through, not even a draft. Measured on a live install
  // 2026-09-21: the hook only sees a call that CARRIES to/cc/bcc. An address
  // assembled inside a script the agent then runs (`python3 kuldes.py`) is
  // invisible to it -- the gate's own header says so, because static analysis
  // of arbitrary interpreter code is undecidable. The old sentence therefore
  // told every agent it stood under machine protection on a path where it did
  // not, and the gap is SILENT: nothing fires, the draft is simply written.
  // The narrowed wording must not drift back on a later edit.
  it('does not overclaim the recipient gate -- names what it cannot see', () => {
    expect(evidenceBody).toContain('szkriptbe zárt címet')
    expect(evidenceBody).toContain('ne olvasd védelemnek ott, ahol nincs')
    expect(evidenceBody).not.toContain('ismeretlen címre még piszkozatot sem enged')
  })

  // Same measurement, second consequence: while the ledger file does not exist
  // the gate is fail-closed, so every address-carrying send is denied. That is
  // the right direction, but an approved recurring task does not disappear --
  // the agent looks for the path the gate cannot see. Observed once already.
  // Naming the correct recovery (add the address WITH a source) is what keeps
  // fail-closed from teaching the workaround.
  it('names the recovery path so the empty ledger does not teach evasion', () => {
    expect(evidenceBody).toContain('fail-closed')
    expect(evidenceBody).toContain('nem a kapu megkerülése')
  })

  it('keeps Hungarian accents and uses no em dash, like its sibling blocks', () => {
    expect(evidenceBody).toContain('ellenőrizz')
    expect(evidenceBody).not.toContain('—')
  })
})
