import { describe, it, expect } from 'vitest'
import {
  isInfrastructureChild,
  findClaudePidInTree,
  extractMcpPackageNames,
  isMcpProcess,
  isNonWorkHelperProcess,
  parseEtimeSeconds,
  commBasename,
  TASKSTATE_FRESH_WINDOW_MS,
} from '../web/context-restart-gate-runner.js'
import {
  decideGate,
  nextBlockClock,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_STALE_CUTOFF_MS,
  DEFAULT_PERSISTENT_BLOCK_ALERT_MS,
  DEFAULT_TRANSCRIPT_QUIET_MS,
  normalizeGateConfig,
  DEFAULT_GATE_CONFIG,
  type GateInputs,
  type GateConfig,
} from '../context-restart-gate.js'
import { pickGateConfig } from '../web/context-restart-gate-store.js'

// Fully-clear inputs: context at threshold, pane idle, no dispatched work, no
// open question, no task state, hard guard idle, child processes measured false.
// decideGate on these inputs with firstBlockedAt=null MUST return 'allow'.
const NOW = 1_700_000_000_000
const CLEAR_INPUTS: GateInputs = {
  nowMs:                NOW,
  contextTokens:        DEFAULT_THRESHOLD_TOKENS,
  paneState:            'idle',
  paneUsageLimited:     false,
  hardGuardPhase:       'idle',
  pendingOutboundCount: 0,
  hasStaleOutbound:     false,
  hasChildProcesses:    false,
  msSinceTranscriptWrite: 10 * 60 * 1000,   // quiet for 10 min
  hasOpenQuestion:      false,
  hasLiveTaskState:     false,
}
const ENABLED: GateConfig = { ...DEFAULT_GATE_CONFIG, enabled: true }

function decide(inputs: Partial<GateInputs>, firstBlockedAt: number | null = null, cfg = ENABLED) {
  return decideGate({ ...CLEAR_INPUTS, ...inputs }, cfg, firstBlockedAt)
}

describe('normalizeGateConfig', () => {
  it('returns disabled default for empty input', () => {
    expect(normalizeGateConfig({}).enabled).toBe(false)
    expect(normalizeGateConfig({}).thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS)
  })

  it('coerces invalid threshold to default', () => {
    expect(normalizeGateConfig({ enabled: true, thresholdTokens: -1 }).thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS)
    expect(normalizeGateConfig({ enabled: true, thresholdTokens: 'nope' }).thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS)
  })

  it('accepts a custom valid threshold', () => {
    expect(normalizeGateConfig({ thresholdTokens: 300_000 }).thresholdTokens).toBe(300_000)
  })
})

describe('decideGate -- disabled', () => {
  it('returns block when gate is disabled', () => {
    const d = decide({}, null, { ...ENABLED, enabled: false })
    expect(d.action).toBe('block')
    expect(d.reason).toBe('gate-disabled')
  })
})

describe('decideGate -- trigger (threshold)', () => {
  it('blocks when context is below threshold', () => {
    const d = decide({ contextTokens: DEFAULT_THRESHOLD_TOKENS - 1 })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/below-threshold/)
  })

  it('allows at exactly the threshold', () => {
    const d = decide({ contextTokens: DEFAULT_THRESHOLD_TOKENS })
    expect(d.action).toBe('allow')
  })

  it('allows above the threshold', () => {
    const d = decide({ contextTokens: DEFAULT_THRESHOLD_TOKENS + 100_000 })
    expect(d.action).toBe('allow')
  })

  it('blocks when contextTokens is null (fail-closed)', () => {
    const d = decide({ contextTokens: null })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/fail-closed/)
  })

  // The alert tells the owner the agent reached the threshold and the gate will
  // not open. An unmeasured reading cannot support that claim, and every fresh
  // session reads null for about a minute, so this must never escalate.
  it('never escalates an unmeasurable reading to block-alert, however old the clock', () => {
    const d = decideGate(
      { ...CLEAR_INPUTS, contextTokens: null },
      ENABLED,
      NOW - 100 * DEFAULT_PERSISTENT_BLOCK_ALERT_MS,
    )
    expect(d.action).toBe('block')
  })
})

describe('decideGate -- hard-guard interlock', () => {
  it('blocks when hard guard is await-handoff', () => {
    const d = decide({ hardGuardPhase: 'await-handoff' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/hard-guard-armed/)
  })

  it('blocks when hard guard is await-ready', () => {
    const d = decide({ hardGuardPhase: 'await-ready' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/hard-guard-armed/)
  })

  it('allows when hard guard is idle', () => {
    const d = decide({ hardGuardPhase: 'idle' })
    expect(d.action).toBe('allow')
  })

  it('allows when hard guard is cooldown', () => {
    const d = decide({ hardGuardPhase: 'cooldown' })
    expect(d.action).toBe('allow')
  })
})

describe('decideGate -- pane guards', () => {
  it('blocks when pane is null (fail-closed)', () => {
    const d = decide({ paneState: null })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/fail-closed/)
  })

  it('blocks when pane is busy', () => {
    const d = decide({ paneState: 'busy' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/pane-busy/)
  })

  it('blocks when pane is typing', () => {
    const d = decide({ paneState: 'typing' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/pane-typing/)
  })

  it('blocks when pane shows usage limit (limited)', () => {
    const d = decide({ paneUsageLimited: true })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/usage-limited/)
  })

  it('blocks when pane state is unknown', () => {
    const d = decide({ paneState: 'unknown' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/fail-closed/)
  })

  it('blocks when pane state is error', () => {
    const d = decide({ paneState: 'error' })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/fail-closed/)
  })
})

// The failure this guard exists for: the gate sent /clear to a main agent
// while the session was mid-turn (the pane read idle between two
// tool calls). The keystrokes queued behind the running turn, the session was
// never cleared, and the gate recorded a restart that had not happened.
describe('decideGate -- transcript quiet window', () => {
  it('blocks while the transcript is still being written', () => {
    const d = decide({ msSinceTranscriptWrite: 4_000 })
    expect(d.action).toBe('block')
    expect(d.reason).toContain('transcript-active')
  })

  it('blocks when the transcript cannot be read (fail-closed)', () => {
    const d = decide({ msSinceTranscriptWrite: null })
    expect(d.action).toBe('block')
    expect(d.reason).toContain('transcript-unreadable')
  })

  it('allows once the transcript has been quiet for the configured window', () => {
    expect(decide({ msSinceTranscriptWrite: DEFAULT_TRANSCRIPT_QUIET_MS }).action).toBe('allow')
  })

  it('blocks one millisecond short of the window', () => {
    expect(decide({ msSinceTranscriptWrite: DEFAULT_TRANSCRIPT_QUIET_MS - 1 }).action).toBe('block')
  })

  it('honours a custom transcriptQuietMs', () => {
    const cfg: GateConfig = { ...ENABLED, transcriptQuietMs: 30_000 }
    expect(decide({ msSinceTranscriptWrite: 45_000 }, null, cfg).action).toBe('allow')
    expect(decide({ msSinceTranscriptWrite: 20_000 }, null, cfg).action).toBe('block')
  })

  it('an idle pane alone is no longer enough to open the gate', () => {
    // Exactly the 14:05 shape: pane idle, nothing dispatched, but the agent
    // wrote to its transcript two seconds ago.
    const d = decide({ paneState: 'idle', msSinceTranscriptWrite: 2_000 })
    expect(d.action).toBe('block')
  })
})

describe('decideGate -- child process guard', () => {
  it('blocks when hasChildProcesses is null (fail-closed)', () => {
    const d = decide({ hasChildProcesses: null })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/fail-closed/)
  })

  it('blocks when live child processes exist (dispatched background work)', () => {
    const d = decide({ hasChildProcesses: true })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/live-child-processes/)
  })

  it('allows when no child processes', () => {
    const d = decide({ hasChildProcesses: false })
    expect(d.action).toBe('allow')
  })
})

describe('decideGate -- dispatched outbound messages', () => {
  it('blocks when pending outbound messages exist', () => {
    const d = decide({ pendingOutboundCount: 2 })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/pending-outbound-messages \(2/)
  })

  it('allows when no pending outbound', () => {
    const d = decide({ pendingOutboundCount: 0 })
    expect(d.action).toBe('allow')
  })

  it('notes stale outbound when present but allows', () => {
    const d = decide({ pendingOutboundCount: 0, hasStaleOutbound: true })
    expect(d.action).toBe('allow')
    expect(d.noteStaleOutbound).toBe(true)
  })
})

describe('decideGate -- open question', () => {
  it('blocks when there is an unanswered inbound', () => {
    const d = decide({ hasOpenQuestion: true })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/open-question/)
  })
})

describe('decideGate -- live task state', () => {
  it('blocks when task state is live (not consumed, nextAction set)', () => {
    const d = decide({ hasLiveTaskState: true })
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/live-task-state/)
  })
})

describe('decideGate -- persistent block alert', () => {
  const STALE_CFG: GateConfig = {
    ...ENABLED,
    persistentBlockAlertMs: 60_000,  // 1 min for test
  }

  it('returns block (not alert) when blocking is fresh', () => {
    const d = decideGate(
      { ...CLEAR_INPUTS, hasChildProcesses: true },
      STALE_CFG,
      NOW - 30_000,  // blocked for 30s < 1min threshold
    )
    expect(d.action).toBe('block')
  })

  it('returns block-alert when blocking exceeds persistentBlockAlertMs', () => {
    const d = decideGate(
      { ...CLEAR_INPUTS, hasChildProcesses: true },
      STALE_CFG,
      NOW - 90_000,  // blocked for 90s > 1min threshold
    )
    expect(d.action).toBe('block-alert')
    expect(d.reason).toMatch(/live-child-processes/)
  })

  it('returns block (not alert) when firstBlockedAt is null', () => {
    const d = decideGate(
      { ...CLEAR_INPUTS, hasChildProcesses: true },
      STALE_CFG,
      null,
    )
    expect(d.action).toBe('block')
  })
})

// The clock is what turns a block into an alert, so a clock that cannot stop
// turns any later block into a false alarm with a fabricated duration.
describe('nextBlockClock -- the blocking-streak clock', () => {
  const THRESHOLD = DEFAULT_THRESHOLD_TOKENS

  it('starts the clock when at the threshold and not already running', () => {
    expect(nextBlockClock(null, THRESHOLD, THRESHOLD, NOW)).toBe(NOW)
  })

  it('keeps the original start time while the streak continues', () => {
    const started = NOW - 60_000
    expect(nextBlockClock(started, THRESHOLD + 1, THRESHOLD, NOW)).toBe(started)
  })

  it('does not start the clock below the threshold', () => {
    expect(nextBlockClock(null, THRESHOLD - 1, THRESHOLD, NOW)).toBeNull()
  })

  // The 2026-08-12 false alarm: an evening session legitimately started the
  // clock, the host froze, and the fresh two-minute-old session that came back
  // was reported as "blocked for 662 minutes".
  it('CLEARS a running clock once a measured reading is below the threshold', () => {
    expect(nextBlockClock(NOW - 11 * 3600_000, 67_000, THRESHOLD, NOW)).toBeNull()
  })

  it('leaves the clock untouched when the reading is unmeasurable', () => {
    const started = NOW - 60_000
    expect(nextBlockClock(started, null, THRESHOLD, NOW)).toBe(started)
    expect(nextBlockClock(null, null, THRESHOLD, NOW)).toBeNull()
  })
})

describe('decideGate -- full allow scenario (the GATE OPENS)', () => {
  it('allows: context at 400k, pane idle, no children, no outbound, no open question, no task state', () => {
    const d = decideGate(CLEAR_INPUTS, ENABLED, null)
    expect(d.action).toBe('allow')
    expect(d.reason).toMatch(/all gate conditions clear/)
    expect(d.noteStaleOutbound).toBeFalsy()
  })
})

describe('decideGate -- full block scenario (dispatched background work, GATE BLOCKS)', () => {
  it('blocks: context at 400k but agent has pending outbound messages (dispatched to sub-agent)', () => {
    const inputs: GateInputs = {
      ...CLEAR_INPUTS,
      pendingOutboundCount: 1,   // one live agent_messages row from this agent
    }
    const d = decideGate(inputs, ENABLED, null)
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/pending-outbound-messages/)
  })

  it('blocks: context at 400k, pane idle, but live child processes running (Task-tool subagent)', () => {
    const inputs: GateInputs = {
      ...CLEAR_INPUTS,
      hasChildProcesses: true,   // claude PID has live children
    }
    const d = decideGate(inputs, ENABLED, null)
    expect(d.action).toBe('block')
    expect(d.reason).toMatch(/live-child-processes/)
  })
})

// ---------------------------------------------------------------------------
// isInfrastructureChild -- models the REAL process tree shape on this host
// (measured in review #938 rounds 1+2 by bigme)
//
// bigme-channels: pane_pid=2612 (claude), children: npm exec gmail (6294s),
//   bun telegram plugin (6294s). Both are as old as claude itself.
// agent-slarti:   pane_pid=3448 (claude), children: npm exec gmail (6287s).
// bigme-worker:   pane_pid=2797 (BASH), child claude (age 6889).
//
// Measured MCP startup deltas: 1, 1, 2, 2, 3, 3 seconds (ratio 0.9996-0.9999).
// INFRA_AGE_DELTA_S=60 is generous and ABSOLUTE -- does not loosen over time.
// ---------------------------------------------------------------------------
describe('isInfrastructureChild -- absolute delta infrastructure detection', () => {
  const CLAUDE_AGE = 6294  // seconds (from bigme's live measurement)

  it('treats transient exec (<3s) as infrastructure', () => {
    expect(isInfrastructureChild(1, CLAUDE_AGE)).toBe(true)
    expect(isInfrastructureChild(2, CLAUDE_AGE)).toBe(true)
  })

  it('treats MCP server as infrastructure (started within 60s of claude)', () => {
    // Measured deltas: 1-3s. 60s cap is generous.
    expect(isInfrastructureChild(6294, CLAUDE_AGE)).toBe(true)   // delta=0
    expect(isInfrastructureChild(6293, CLAUDE_AGE)).toBe(true)   // delta=1 (measured)
    expect(isInfrastructureChild(6291, CLAUDE_AGE)).toBe(true)   // delta=3 (measured max)
    expect(isInfrastructureChild(6234, CLAUDE_AGE)).toBe(true)   // delta=60 (boundary)
  })

  it('treats child with delta > 60s as possibly-work', () => {
    expect(isInfrastructureChild(6233, CLAUDE_AGE)).toBe(false)  // delta=61 (just over)
    expect(isInfrastructureChild(120, CLAUDE_AGE)).toBe(false)   // spawned 2min into session
    expect(isInfrastructureChild(600, CLAUDE_AGE)).toBe(false)   // running 10min
  })

  it('(B1b regression) 5857s child in 6294s session must NOT be classified as infra', () => {
    // Old ratio (0.85): 5857 >= 6294*0.85=5350 → infra (WRONG -- would allow /clear
    //   while a 90-min Task-tool subagent is still running in a 1.75h session).
    // New delta (60): 5857 >= 6294-60=6234? No → work (CORRECT).
    expect(isInfrastructureChild(5857, CLAUDE_AGE)).toBe(false)
  })

  it('(B1b regression) absolute delta stays tight as session grows', () => {
    // 7h session: old ratio would classify anything > 6h as infra; delta stays 60s.
    const LONG_SESSION = 7 * 3600  // 25200s
    expect(isInfrastructureChild(25200 - 3, LONG_SESSION)).toBe(true)   // MCP, delta=3
    expect(isInfrastructureChild(25200 - 60, LONG_SESSION)).toBe(true)  // delta=60
    expect(isInfrastructureChild(25200 - 61, LONG_SESSION)).toBe(false) // work, delta=61
    expect(isInfrastructureChild(25200 - 3600, LONG_SESSION)).toBe(false) // 1h subagent
  })

  it('(regression) MCP servers must NOT cause the gate to always block', () => {
    const d = decideGate(
      { ...CLEAR_INPUTS, hasChildProcesses: false },
      ENABLED,
      null,
    )
    expect(d.action).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// findClaudePidInTree -- locate claude in pane process tree
// (measured in review #938 round 2 by bigme)
//
// Direct shape (most sessions): pane comm=claude → pane IS claude.
// Wrapper shape (worker sessions): pane comm=BASH, claude is a child.
//   Without comm check, the wrapper shape causes a false-allow: the shell's
//   children list shows claude (age ≈ shell age → infra) but claude's own
//   work children (Task-tool subagents) are invisible.
// ---------------------------------------------------------------------------
describe('findClaudePidInTree -- locate claude in pane process tree', () => {
  it('direct shape: pane_pid IS claude (bigme-channels, agent-slarti, etc.)', () => {
    expect(findClaudePidInTree(1000, 'claude', [])).toBe(1000)
    expect(findClaudePidInTree(1000, 'claude', [{ pid: 2000, comm: 'node' }])).toBe(1000)
  })

  it('wrapper shape: pane is bash, claude is a child (bigme-worker)', () => {
    // bigme-worker measured: pane=2797 comm=BASH, child=2900 comm=claude
    expect(findClaudePidInTree(2797, 'BASH', [
      { pid: 2900, comm: 'claude' },
    ])).toBe(2900)
  })

  it('wrapper shape: handles multiple children, picks the claude one', () => {
    expect(findClaudePidInTree(2797, 'bash', [
      { pid: 2800, comm: 'node' },
      { pid: 2900, comm: 'claude' },
      { pid: 2901, comm: 'python3' },
    ])).toBe(2900)
  })

  it('fail-closed: pane comm is null (ps failed)', () => {
    expect(findClaudePidInTree(1000, null, [])).toBeNull()
  })

  it('fail-closed: pane is shell but no claude child found', () => {
    expect(findClaudePidInTree(1000, 'bash', [
      { pid: 2000, comm: 'node' },
    ])).toBeNull()
  })

  it('fail-closed: pane is unknown process with no claude child', () => {
    expect(findClaudePidInTree(1000, 'sh', [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractMcpPackageNames + isMcpProcess -- reconnected MCP server detection
// (review #938 round 3: channel-mcp-reconnect.ts restarts MCP plugin mid-session)
//
// A reconnected server has a fresh (young) age, so the age-based filter would
// misclassify it as work. Pattern-based check catches it.
//
// Real examples on this host:
//   .mcp.json: gmail -> "npx -y gmail-mcp-server@1.0.30"
//     → process: "npm exec gmail-mcp-server@1.0.30" (args contain "gmail-mcp-server")
//   channel plugin (telegram):
//     → process: "bun run --cwd /home/janos/.claude/plugins/cache/... --shell=bun --silent start"
//     → args contain "/plugins/cache/" (the global plugin cache path)
// ---------------------------------------------------------------------------
describe('extractMcpPackageNames -- extract package names from .mcp.json config', () => {
  it('extracts package name from npx command', () => {
    const names = extractMcpPackageNames({
      gmail: { command: 'npx', args: ['-y', 'gmail-mcp-server@1.0.30'] },
    })
    expect(names).toContain('gmail-mcp-server')
  })

  it('strips version suffix from package name', () => {
    const names = extractMcpPackageNames({
      foo: { command: 'npx', args: ['-y', 'my-mcp-server@2.3.4'] },
    })
    expect(names).toContain('my-mcp-server')
    expect(names).not.toContain('my-mcp-server@2.3.4')
  })

  it('skips launcher tokens (npx, npm, bun, node, -y, etc.)', () => {
    const names = extractMcpPackageNames({
      x: { command: 'npm', args: ['exec', 'some-mcp-tool@1.0'] },
    })
    expect(names).not.toContain('npm')
    expect(names).not.toContain('exec')
    expect(names).toContain('some-mcp-tool')
  })

  it('handles multiple servers', () => {
    const names = extractMcpPackageNames({
      a: { command: 'npx', args: ['-y', 'alpha-mcp@1.0'] },
      b: { command: 'npx', args: ['-y', 'beta-mcp@2.0'] },
    })
    expect(names).toContain('alpha-mcp')
    expect(names).toContain('beta-mcp')
  })

  it('returns empty array for empty config', () => {
    expect(extractMcpPackageNames({})).toEqual([])
  })
})

describe('isMcpProcess -- pattern-based MCP server identification', () => {
  it('identifies telegram channel plugin by plugin cache path', () => {
    // bigme-channels measured: bun run --cwd /home/janos/.claude/plugins/cache/... --shell=bun --silent start
    const args = 'bun run --cwd /home/janos/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start'
    expect(isMcpProcess(args, [])).toBe(true)
  })

  it('identifies gmail MCP server by package name', () => {
    // bigme-channels measured: npm exec gmail-mcp-server@1.0.30
    const args = 'npm exec gmail-mcp-server@1.0.30'
    expect(isMcpProcess(args, ['gmail-mcp-server'])).toBe(true)
  })

  it('identifies reconnected (fresh-age) gmail MCP server', () => {
    // After a /mcp reconnect, the gmail server is young but still identifiable
    // by package name in args -- this is the B3 scenario.
    const args = '/usr/bin/node /home/janos/.npm/_npx/.../gmail-mcp-server/dist/index.js --non-interactive'
    expect(isMcpProcess(args, ['gmail-mcp-server'])).toBe(true)
  })

  it('does NOT classify a Task-tool subagent as MCP', () => {
    const args = '/home/janos/.local/bin/claude --dangerously-skip-permissions --model claude-sonnet-5'
    expect(isMcpProcess(args, ['gmail-mcp-server'])).toBe(false)
  })

  it('does NOT classify a bash process as MCP', () => {
    expect(isMcpProcess('bash', [])).toBe(false)
    expect(isMcpProcess('/bin/bash -c echo hello', ['gmail-mcp-server'])).toBe(false)
  })

  // Config-independent shape rule. Regression: a sub-agent's gate stayed
  // blocked on a live woocommerce MCP child that no longer appeared in its
  // .mcp.json, so no pattern matched and the age filter could never absolve it.
  it('identifies an MCP server whose package is NOT in the pattern list', () => {
    expect(isMcpProcess('npm exec @amitgurbani/mcp-server-woocommerce', [])).toBe(true)
    expect(isMcpProcess(
      'node /Users/x/.npm/_npx/5da803678de24a4e/node_modules/.bin/mcp-server-woocommerce', []
    )).toBe(true)
  })

  it('identifies a scoped @org/*-mcp package with an empty pattern list', () => {
    expect(isMcpProcess('npx -y @notionhq/notion-mcp-server', [])).toBe(true)
    expect(isMcpProcess('npx -y @aaronsb/google-workspace-mcp', [])).toBe(true)
  })

  it('treats a direct npx-cache child as infrastructure', () => {
    // The Bash tool always goes through a shell, so a user-run npx is a
    // grandchild; a direct npx-cache child of claude is an MCP server.
    expect(isMcpProcess('node /Users/x/.npm/_npx/abc123/node_modules/.bin/something', [])).toBe(true)
  })

  it('still does NOT classify real work as MCP under the shape rule', () => {
    expect(isMcpProcess('/opt/homebrew/bin/claude --dangerously-skip-permissions', [])).toBe(false)
    expect(isMcpProcess('/bin/zsh -c npm run build', [])).toBe(false)
    expect(isMcpProcess('python3 scripts/usage-collect.py', [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pickGateConfig -- an agent with no entry of its own must still get a gate.
// Regression: an agent created without a config entry inherited
// `enabled: false` and grew to 545k tokens with nothing watching.
// ---------------------------------------------------------------------------

describe('pickGateConfig -- _default inheritance', () => {
  it('prefers the agent own entry over _default', () => {
    const cfg = pickGateConfig(
      { _default: { enabled: true, thresholdTokens: 120_000 }, 'agent-a': { enabled: false } },
      'agent-a',
    )
    expect(cfg.enabled).toBe(false)
  })

  it('falls back to _default for an agent with no entry', () => {
    const cfg = pickGateConfig({ _default: { enabled: true, thresholdTokens: 120_000 } }, 'brand-new')
    expect(cfg.enabled).toBe(true)
    expect(cfg.thresholdTokens).toBe(120_000)
  })

  it('falls back to the built-in default when there is no _default either', () => {
    const cfg = pickGateConfig({ 'agent-a': { enabled: true } }, 'brand-new')
    expect(cfg.enabled).toBe(false)
    expect(cfg.thresholdTokens).toBe(DEFAULT_THRESHOLD_TOKENS)
  })
})

describe('hasLiveTaskState freshness window', () => {
  it('TASKSTATE_FRESH_WINDOW_MS is 10 minutes', () => {
    expect(TASKSTATE_FRESH_WINDOW_MS).toBe(600_000)
  })

  it('(integration comment) stale taskstate must NOT block the gate', () => {
    // A taskstate record written hours ago (consumed=false, nextAction set) was
    // blocking the gate permanently in the B2 design error. The runner now only
    // sets hasLiveTaskState=true when the record ts is within TASKSTATE_FRESH_WINDOW_MS.
    // At the pure-logic level: hasLiveTaskState=false → the gate can open.
    const d = decideGate(
      { ...CLEAR_INPUTS, hasLiveTaskState: false },
      ENABLED,
      null,
    )
    expect(d.action).toBe('allow')
  })
})

// The gate reads process ages through `ps -o etime=`. It used to ask for
// `etimes`, which only GNU procps understands; BSD ps (macOS) answered
// "keyword not found", every age came back null, and null age is fail-closed --
// so the gate could never open on macOS. These tests pin the portable parser.
describe('parseEtimeSeconds -- ps etime parsing (portability)', () => {
  it('parses mm:ss', () => {
    expect(parseEtimeSeconds('00:38')).toBe(38)
    expect(parseEtimeSeconds('12:05')).toBe(725)
  })

  it('parses hh:mm:ss', () => {
    expect(parseEtimeSeconds('02:37:20')).toBe(9440)
  })

  it('parses dd-hh:mm:ss', () => {
    expect(parseEtimeSeconds('1-02:37:20')).toBe(95840)
  })

  it('tolerates surrounding whitespace, as ps emits it', () => {
    expect(parseEtimeSeconds('  02:37:20\n')).toBe(9440)
  })

  it('returns null on unparseable input rather than a wrong number', () => {
    expect(parseEtimeSeconds('')).toBeNull()
    expect(parseEtimeSeconds('ps: etimes: keyword not found')).toBeNull()
    expect(parseEtimeSeconds('38')).toBeNull()
  })
})

describe('isNonWorkHelperProcess', () => {
  it('treats caffeinate as a helper, not in-flight work', () => {
    expect(isNonWorkHelperProcess('caffeinate -i -t 300')).toBe(true)
    expect(isNonWorkHelperProcess('/usr/bin/caffeinate -i -t 300')).toBe(true)
  })

  it('does not swallow real work children', () => {
    expect(isNonWorkHelperProcess('node /some/script.js')).toBe(false)
    expect(isNonWorkHelperProcess('/bin/zsh -lc npm test')).toBe(false)
    expect(isNonWorkHelperProcess('')).toBe(false)
  })

  it('matches on the command, not on a substring of an argument', () => {
    expect(isNonWorkHelperProcess('node /opt/caffeinate/index.js')).toBe(false)
  })
})

// `ps -o comm=` prints a bare name on Linux but a full path on macOS. The exact
// string compare against 'claude' never matched there, so the claude process
// could not be located and the whole child check went fail-closed.
describe('commBasename / findClaudePidInTree -- ps comm portability', () => {
  it('reduces a macOS full-path comm to the command name', () => {
    expect(commBasename('/opt/homebrew/bin/claude')).toBe('claude')
    expect(commBasename('/usr/local/bin/claude')).toBe('claude')
  })

  it('leaves a Linux bare comm unchanged', () => {
    expect(commBasename('claude')).toBe('claude')
  })

  it('returns null for null/blank', () => {
    expect(commBasename(null)).toBeNull()
    expect(commBasename('   ')).toBeNull()
  })

  it('finds claude when the pane comm is a full path (macOS direct shape)', () => {
    expect(findClaudePidInTree(51262, '/opt/homebrew/bin/claude', [])).toBe(51262)
  })

  it('finds claude as a child when the pane is a shell (wrapper shape)', () => {
    expect(findClaudePidInTree(100, '/bin/bash', [
      { pid: 101, comm: '/opt/homebrew/bin/claude' },
    ])).toBe(101)
  })

  it('still returns null when claude is genuinely absent', () => {
    expect(findClaudePidInTree(100, '/bin/bash', [
      { pid: 101, comm: '/usr/bin/node' },
    ])).toBeNull()
  })

  it('does not match a command that merely ends with claude-something', () => {
    expect(findClaudePidInTree(100, '/usr/bin/claude-wrapper', [])).toBeNull()
  })
})
