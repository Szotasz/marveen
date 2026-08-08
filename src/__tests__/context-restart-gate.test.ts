import { describe, it, expect } from 'vitest'
import {
  isInfrastructureChild,
  findClaudePidInTree,
  extractMcpPackageNames,
  isMcpProcess,
  TASKSTATE_FRESH_WINDOW_MS,
} from '../web/context-restart-gate-runner.js'
import {
  decideGate,
  DEFAULT_THRESHOLD_TOKENS,
  DEFAULT_STALE_CUTOFF_MS,
  DEFAULT_PERSISTENT_BLOCK_ALERT_MS,
  normalizeGateConfig,
  DEFAULT_GATE_CONFIG,
  type GateInputs,
  type GateConfig,
} from '../context-restart-gate.js'

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
