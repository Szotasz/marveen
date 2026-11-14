// The start-time writers of a sub-agent's CLAUDE.md: which ones run when an agent starts, and in which
// order (MIOAGENTINSTALL1114, PR-I0).
//
// Every start rewrites the agent's CLAUDE.md: the token sync repoints the helper recipes, each
// ensure*Section appends its generated block or replaces it in place, and the root replacer swaps the
// project-root path wherever it stands. A later change (the agent package installer) needs to run
// exactly this sequence against a file and look at the result, so the sequence is pinned here first,
// on the code as it stands, and the next commit lifts it into one function.
//
// Source-level, the idiom of the other tests of startAgentProcess (it resolves auth, writes the live
// agents directory and spawns tmux; no test runs it). What is asserted holds for the sequence wherever
// in agent-process.ts it lives: the calls, their order, each exactly once.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dirname, '..', 'web')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const PROCESS = stripComments(readFileSync(join(WEB, 'agent-process.ts'), 'utf8'))
const SCAFFOLD = readFileSync(join(WEB, 'agent-scaffold.ts'), 'utf8')

// A call of a start-time writer: the token sync, the root replacer, or a section writer.
const CALL_RX = /\b(syncAgentTokenOnStart|ensureProjectRootInClaudeMd|ensure[A-Za-z]+Section(?:Current)?)\(([^)]*)\)/g
const calls = [...PROCESS.matchAll(CALL_RX)].map((m) => `${m[1]}(${m[2]})`)

// Literal on purpose: the sequence this file was written against. A new writer is added HERE, in its place.
const SEQUENCE = [
  'syncAgentTokenOnStart(name)',
  'ensureFleetRosterSection(name)',
  'ensureProjectRootInClaudeMd(name)',
  'ensureAutonomySection(name)',
  'ensureSkillsPathTrapSection(name)',
  'ensureSkillSectionCurrent(name)',
  'ensureSystemDirectiveAuthSection(name)',
  'ensureAgentIdHeaderSection(name)',
  'ensureThinChiefHandoffSection(name)',
  'ensureMemorySearchLabelSection(name)',
  'ensureFleetAuthSection(name)',
  'ensureEvidenceSection(name)',
  'ensureMcpListChannelSection(name)',
  'ensureMessageCloseSection(name)',
  'ensureStrictApiSection(name)',
  'ensureApiHelperSection(name)',
  'ensureBackgroundCheckpointSection(name)',
  'ensurePaneAtEscapeSection(name)',
]

describe('the start-time writers of an agent CLAUDE.md', () => {
  it('the calls in agent-process.ts are exactly this sequence, in this order, each once', () => {
    expect(calls).toEqual(SEQUENCE)
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('the token sync is best-effort: a failure is logged and the start goes on', () => {
    expect(PROCESS).toMatch(/try \{\s*syncAgentTokenOnStart\(name\)\s*\} catch \(err\) \{\s*logger\.warn\(\{ err, name \}, 'per-agent dashboard token sync failed \(agent keeps the shared token\)'\)\s*\}/)
  })

  it('the THIN CHIEF handoff section is written only for a profile that opts in', () => {
    expect(PROCESS).toContain('if (profileWantsThinChiefHandoff(profile)) ensureThinChiefHandoffSection(name)')
  })

  it('every other writer is unconditional: it stands alone on its line', () => {
    for (const call of SEQUENCE) {
      if (call.startsWith('ensureThinChiefHandoffSection') || call.startsWith('syncAgentTokenOnStart')) continue
      const esc = call.replace(/[()]/g, '\\$&')
      expect([call, new RegExp(`^\\s*${esc}\\s*$`, 'm').test(PROCESS)]).toEqual([call, true])
    }
  })

  it('the sequence lives in rewriteAgentClaudeMdOnStart, and startAgentProcess reaches it through one call', () => {
    const head = 'export function rewriteAgentClaudeMdOnStart(name: string, profile: ProfileTemplate): void {\n'
    const start = PROCESS.indexOf(head)
    expect(start).toBeGreaterThan(-1)
    const end = PROCESS.indexOf('\n}\n', start)
    const body = PROCESS.slice(start + head.length, end)
    const outside = PROCESS.slice(0, start) + PROCESS.slice(end)
    // Every call is inside the function, none is left behind in the start path or anywhere else.
    expect([...body.matchAll(CALL_RX)].map((m) => `${m[1]}(${m[2]})`)).toEqual(SEQUENCE)
    expect([...outside.matchAll(CALL_RX)]).toEqual([])
    // One caller in this file, right after the settings are written from the same profile.
    expect(outside.match(/\brewriteAgentClaudeMdOnStart\(/g)).toHaveLength(1)
    expect(outside).toMatch(/^ {4}writeAgentSettingsFromProfile\(name, profile\)\n {4}rewriteAgentClaudeMdOnStart\(name, profile\)$/m)
  })

  it('closed world: every section writer agent-scaffold.ts exports is in the sequence', () => {
    // A section writer added to the scaffold and not called at start is red here, with its name; so is one
    // called at start under a name this file does not know (the first test).
    const exported = [...SCAFFOLD.matchAll(/^export function (ensure[A-Za-z]+Section(?:Current)?|ensureProjectRootInClaudeMd)\(/gm)].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(10)
    const inSequence = new Set(SEQUENCE.map((c) => c.slice(0, c.indexOf('('))))
    expect(exported.filter((e) => !inSequence.has(e))).toEqual([])
  })
})
