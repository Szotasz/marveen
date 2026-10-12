import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentConfigDirForRead } from '../web/claude-plans.js'
import { resolveClaudeConfigDir } from '../web/agent-config.js'
import { readTranscriptMtimeFromProjectDir, readTranscriptMtimeAcrossConfigDirs, projectsDirFor } from '../web/active-model.js'
import { mainConfigRoots } from '../web/inbound-probe.js'

// The post-fire watchdog's sawTurn probe, and why the config dir it is handed
// decides whether the probe can see anything at all.
//
// THE BUG (measured 2026-09-04). The in-flight entry took its configDir from
// readAgentClaudeConfigDir, which reads ONLY the `claudeConfigDir` field of
// agent-config.json. Since the fleet auth rule (2026-07-01) that field must NOT
// be set: every agent's config dir is AUTO-PROVISIONED at
// <agentDir>/.claude-config. So the read returned null, the entry stored
// `undefined`, and readTranscriptMtimeFromProjectDir fell back to
// ~/.claude/projects/<encoded-workingDir> -- a path that does not exist for
// such an agent. The probe therefore returned null on EVERY sweep, sawTurn
// stayed false, and decideTaskTimeout ruled 'lost' for any task that finished
// between two sweeps. That is every FAST task: the pane is idle before the
// injection, briefly busy, and idle again long before the next sample.
//
// The consequence was a re-fire loop with no backoff. On cortex-voip-insight it
// produced 2069 false-lost re-injections in 24 hours from a */5 task (288
// expected), a 7.5x amplification that had been running unnoticed since
// 2026-08-27 -- while `fired` rows kept the run log looking healthy.
//
// The fix reuses resolveAgentConfigDirForRead, which the context-guard and
// restart-gate runners already used for exactly this reason. These tests pin
// the mechanism (the probe can find a transcript) rather than only the call.

describe('in-flight watchdog: config dir for the sawTurn transcript probe', () => {
  let root: string
  const AGENT = 'fixture-agent'
  let agentPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inflight-config-dir-'))
    agentPath = join(root, 'agents', AGENT)
    mkdirSync(agentPath, { recursive: true })
    // Config file WITHOUT claudeConfigDir -- what the fleet auth rule mandates.
    writeFileSync(join(agentPath, 'agent-config.json'), JSON.stringify({ displayName: 'Fixture', model: 'claude-sonnet-5' }))
    // The auto-provisioned config dir, with the transcript where Claude Code
    // actually writes it: <configDir>/projects/<encoded workingDir>/*.jsonl
    const projects = projectsDirFor(agentPath, join(agentPath, '.claude-config'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, 'session.jsonl'), '{"type":"turn"}\n')
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('resolves the auto-provisioned dir even though the config field is absent', () => {
    expect(resolveAgentConfigDirForRead(AGENT, root)).toBe(join(agentPath, '.claude-config'))
  })

  it('the field-only read returns null here -- that null was the bug', () => {
    // Not a criticism of the field read: null is its correct answer (there IS
    // no override field). It is the wrong QUESTION for a transcript reader,
    // which is the whole point of the fix. resolveClaudeConfigDir is the pure
    // core of readAgentClaudeConfigDir, so this pins the behaviour without
    // reaching into the real agents/ tree.
    const raw = readFileSync(join(agentPath, 'agent-config.json'), 'utf-8')
    expect(resolveClaudeConfigDir(raw, root)).toBeNull()
  })

  it('the probe SEES the transcript with the resolved dir, and is blind without it', () => {
    const resolved = resolveAgentConfigDirForRead(AGENT, root) ?? undefined
    expect(readTranscriptMtimeFromProjectDir(agentPath, resolved)).toBeGreaterThan(0)
    // undefined => ~/.claude/projects/<encoded>, which does not exist for an
    // auto-provisioned agent. A null here is what kept sawTurn false forever.
    expect(readTranscriptMtimeFromProjectDir(agentPath, undefined)).toBeNull()
  })

  it('fix-revert guard: the entry resolves the config dir, it does not read the field', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/\[resolveAgentConfigDirForRead\(agentName\) \?\? undefined\]/)
    // The old call must be gone entirely: leaving it importable invites the
    // revert, and no other site in this file needs it.
    expect(src).not.toMatch(/readAgentClaudeConfigDir\(/)
  })
})

// THE SAME BUG ON THE OTHER SIDE OF THE TERNARY (measured 2026-09-14).
//
// The sub-agent half above was fixed on 2026-09-04; the main-agent half kept
// hardcoding `undefined`, i.e. "the main session always writes under the shared
// ~/.claude". Main-agent config isolation made that false: the session runs
// with CLAUDE_CONFIG_DIR=<PROJECT_ROOT>/.channels-config and its transcript
// lands there instead. The probe then read a directory that had been frozen for
// days, returned null on every sweep, and sawTurn could only ever be set by a
// pane sample that happened to catch 'busy' -- which a task finishing between
// two sweeps never is.
//
// Measured on a live host over 24h: ledger-live-drain fired 2509 times against
// 720 scheduled (*/2), memoria-heartbeat 259 against ~48, running since
// 2026-09-11 with a `fired` row making every round look healthy.
//
// PR #1312 fixed this family for the channel watchdogs (probe every candidate
// root, newest wins) but did not touch the schedule runner. Its own notes
// flagged the main-agent half as latent on that host because there
// .channels-config/projects is a symlink to the shared root; where it is a real
// directory the gap is live. So the fix here is not a new rule, it is the
// existing rule applied to the caller that was left out.
describe('in-flight watchdog: the MAIN agent transcript may live under an isolated root', () => {
  let root: string
  let workingDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inflight-main-config-'))
    workingDir = join(root, 'marveen')
    mkdirSync(workingDir, { recursive: true })
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('finds the transcript under the isolated root while the shared root is empty', () => {
    const isolated = join(workingDir, '.channels-config')
    const shared = join(root, 'home', '.claude')
    mkdirSync(projectsDirFor(workingDir, isolated), { recursive: true })
    writeFileSync(join(projectsDirFor(workingDir, isolated), 'live.jsonl'), '{"type":"turn"}\n')

    // The old single-root call, with the assumption the fix removes.
    expect(readTranscriptMtimeFromProjectDir(workingDir, shared)).toBeNull()
    // The list form asks the question the watchdog actually has.
    expect(readTranscriptMtimeAcrossConfigDirs(workingDir, [shared, isolated])).toBeGreaterThan(0)
  })

  it('still finds it under the shared root when isolation is NOT in use', () => {
    const isolated = join(workingDir, '.channels-config')
    const shared = join(root, 'home', '.claude')
    mkdirSync(projectsDirFor(workingDir, shared), { recursive: true })
    writeFileSync(join(projectsDirFor(workingDir, shared), 'live.jsonl'), '{"type":"turn"}\n')

    expect(readTranscriptMtimeAcrossConfigDirs(workingDir, [shared, isolated])).toBeGreaterThan(0)
  })

  it('newest wins when BOTH roots carry a transcript', () => {
    const isolated = join(workingDir, '.channels-config')
    const shared = join(root, 'home', '.claude')
    for (const cd of [shared, isolated]) mkdirSync(projectsDirFor(workingDir, cd), { recursive: true })
    const oldFile = join(projectsDirFor(workingDir, shared), 'old.jsonl')
    const newFile = join(projectsDirFor(workingDir, isolated), 'new.jsonl')
    writeFileSync(oldFile, '{"type":"turn"}\n')
    writeFileSync(newFile, '{"type":"turn"}\n')
    const past = new Date(Date.now() - 86_400_000)
    utimesSync(oldFile, past, past)

    const across = readTranscriptMtimeAcrossConfigDirs(workingDir, [shared, isolated])
    expect(across).toBe(readTranscriptMtimeFromProjectDir(workingDir, isolated))
    expect(across).toBeGreaterThan(readTranscriptMtimeFromProjectDir(workingDir, shared)!)
  })

  it('null only when NO candidate has a transcript', () => {
    expect(readTranscriptMtimeAcrossConfigDirs(workingDir, [join(root, 'a'), join(root, 'b')])).toBeNull()
    expect(readTranscriptMtimeAcrossConfigDirs(workingDir, [])).toBeNull()
  })

  it('the isolated root is one of the candidates the main agent is given', () => {
    // mainConfigRoots is the single place the isolation candidates live; the
    // schedule runner must consume it rather than keep a second copy, which is
    // exactly how this blind spot survived the #1312 fix.
    const roots = mainConfigRoots()
    expect(roots.some(r => r.endsWith(join('.channels-config')))).toBe(true)
    expect(roots.some(r => r.endsWith(join('.claude')))).toBe(true)
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('fix-revert guard: the main agent gets the candidate list, not a hardcoded undefined', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/configDirs: agentName === MAIN_AGENT_ID\s*\n\s*\? mainConfigRoots\(\)/)
    // The single-root probe call must be gone from the sweep: it is what made
    // the wrong root unrecoverable once chosen.
    expect(src).not.toMatch(/readTranscriptMtimeFromProjectDir\(entry\./)
    expect(src).toMatch(/readTranscriptMtimeAcrossConfigDirs\(entry\.workingDir, entry\.configDirs\)/)
  })
})
