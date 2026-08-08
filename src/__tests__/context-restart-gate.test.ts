import { describe, it, expect } from 'vitest'
import {
  isInfrastructureChild,
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
// (measured in review #938 round 1 by bigme)
//
// bigme-channels: pane_pid=2612 (claude), children: npm exec gmail (6294s),
//   bun telegram plugin (6294s). Both are as old as claude itself.
// agent-slarti:   pane_pid=3448 (claude), children: npm exec gmail (6287s).
//
// All MCP servers start at session boot and have etimes ≈ claude's etimes.
// Task-tool subagents are spawned during the session (much younger).
// ---------------------------------------------------------------------------
describe('isInfrastructureChild -- age-based infrastructure detection', () => {
  const CLAUDE_AGE = 6294  // seconds (from bigme's live measurement)

  it('treats transient exec (<3s) as infrastructure', () => {
    expect(isInfrastructureChild(1, CLAUDE_AGE)).toBe(true)
    expect(isInfrastructureChild(2, CLAUDE_AGE)).toBe(true)
  })

  it('treats MCP server as infrastructure (age ≈ claude age)', () => {
    // npm exec gmail-... and bun plugin both at 6294s = same age as claude
    expect(isInfrastructureChild(6294, CLAUDE_AGE)).toBe(true)
    // Slightly younger MCP server (startup delay)
    expect(isInfrastructureChild(6200, CLAUDE_AGE)).toBe(true)  // 6200 >= 6294*0.85=5350
  })

  it('treats recently-spawned child as possibly-work (Task-tool subagent)', () => {
    // Task spawned 2 min ago in a 6294s-old session
    expect(isInfrastructureChild(120, CLAUDE_AGE)).toBe(false)
    // Task running for 10 min in the same session
    expect(isInfrastructureChild(600, CLAUDE_AGE)).toBe(false)  // 600 < 6294*0.85=5350
  })

  it('transient exec (1-2s) is always infra regardless of claude age', () => {
    expect(isInfrastructureChild(1, 10)).toBe(true)
    expect(isInfrastructureChild(2, 30)).toBe(true)
  })

  it('(regression) MCP servers must NOT cause the gate to always block', () => {
    // This was the B1 blocker from review #938 round 1:
    // Before the fix, age >= CHILD_MIN_AGE_S(3) was the only filter.
    // A MCP server at 6294s would have passed that filter and returned true.
    // Now it is correctly classified as infrastructure → gate can open.
    const mcpAge = 6294
    expect(isInfrastructureChild(mcpAge, CLAUDE_AGE)).toBe(true)
    // Verify: a session with ONLY MCP-age children (no work children) returns
    // hasChildProcesses=false, which means the gate condition is NOT blocked.
    // We verify this at the pure-logic level: hasChildProcesses=false → allow.
    const d = decideGate(
      { ...CLEAR_INPUTS, hasChildProcesses: false },
      ENABLED,
      null,
    )
    expect(d.action).toBe('allow')
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
