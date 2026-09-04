import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentConfigDirForRead } from '../web/claude-plans.js'
import { resolveClaudeConfigDir } from '../web/agent-config.js'
import { readTranscriptMtimeFromProjectDir, projectsDirFor } from '../web/active-model.js'

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
    expect(src).toMatch(/configDir: agentName === MAIN_AGENT_ID \? undefined : \(resolveAgentConfigDirForRead\(agentName\) \?\? undefined\)/)
    // The old call must be gone entirely: leaving it importable invites the
    // revert, and no other site in this file needs it.
    expect(src).not.toMatch(/readAgentClaudeConfigDir\(/)
  })
})
