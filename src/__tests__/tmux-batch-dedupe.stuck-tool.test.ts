// Site 2 of the tmux read dedupe: sweepSubAgents() asks deps.isRunning(agent)
// once per agent, and under the live deps (LIVE_SUB_AGENT_DEPS) that is
// isAgentRunning() -- one identical `tmux list-sessions` spawn per agent per
// sweep. The sweep loop now runs inside withTmuxBatch, so the whole sweep
// answers from ONE list-sessions.
//
// sweepSubAgents is dependency-injected by design ("pure apart from the
// injected deps, so the tests drive it with canned panes and a fake clock"),
// so this drives the REAL sweep with the REAL isAgentRunning (the exact live
// seam) and only the tmux spawn is faked. Proves both halves:
//  (a) behaviour is unchanged -- running agents are swept and captured, a
//      stopped agent is skipped before any pane read, no alerts fire on quiet
//      panes, and each sweep re-reads (the memo spans one sweep only);
//  (b) the dedupe happens -- the identical list-sessions query runs ONCE per
//      sweep (and once per agent when the same reads are made outside a batch,
//      which is the control).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import {
  sweepSubAgents,
  resetSubAgentWatchState,
  type SubAgentSweepDeps,
} from '../web/stuck-tool-call-watcher.js'
import { isAgentRunning, withTmuxBatch } from '../web/agent-process.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every execFileSync in the process is recorded; list-sessions answers from a
// canned session list so the real isAgentRunning() -> agentRunState() ->
// captureTmux() path classifies agents (only the spawn itself is faked).
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  sessions: 'agent-dedupe-a\nagent-dedupe-b',
  captures: [] as Array<{ agent: string; session: string }>,
  alerts: [] as Array<{ agent: string; session: string; kind: string }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = (file: string, args?: readonly string[]): string => {
    const a = Array.isArray(args) ? [...args] : []
    h.spawns.push({ file, args: a })
    if (a[0] === 'list-sessions') return `${h.sessions}\n`
    if (a[0] === 'list-panes') return 'agent-dedupe-a\t1\tclaude\nagent-dedupe-b\t1\tclaude\n'
    return ''
  }
  return { ...actual, execFileSync: execFileSync as unknown as typeof actual.execFileSync }
})

const listSessionsSpawns = () => h.spawns.filter((s) => s.args[0] === 'list-sessions')

const NOW = 1_700_000_000_000

function liveStyleDeps(): SubAgentSweepDeps {
  return {
    listAgents: () => ['dedupe-a', 'dedupe-b', 'dedupe-c'],
    // The LIVE seam, exactly as LIVE_SUB_AGENT_DEPS wires it: the real
    // isAgentRunning, whose list-sessions read is what the batch dedupes.
    isRunning: isAgentRunning,
    hasChannel: () => false,
    capture: (agent, session) => {
      h.captures.push({ agent, session })
      return null
    },
    now: () => NOW,
    alertWait: (agent, session, kind) => {
      h.alerts.push({ agent, session, kind })
    },
    readState: () => null,
  }
}

beforeEach(() => {
  h.spawns.length = 0
  h.captures.length = 0
  h.alerts.length = 0
  h.sessions = 'agent-dedupe-a\nagent-dedupe-b'
  resetSubAgentWatchState()
})

describe('mechanism: the reads the sweep makes, through the real withTmuxBatch', () => {
  it('outside a batch every per-agent isAgentRunning() is its own identical list-sessions spawn', () => {
    expect(isAgentRunning('dedupe-a')).toBe(true)
    expect(isAgentRunning('dedupe-b')).toBe(true)
    expect(isAgentRunning('dedupe-c')).toBe(false)
    expect(listSessionsSpawns()).toHaveLength(3)
  })

  it('inside withTmuxBatch the identical query runs once and every answer is unchanged', () => {
    const outside = [isAgentRunning('dedupe-a'), isAgentRunning('dedupe-b'), isAgentRunning('dedupe-c')]
    expect(listSessionsSpawns()).toHaveLength(3)

    h.spawns.length = 0
    const inside = withTmuxBatch(() => [
      isAgentRunning('dedupe-a'),
      isAgentRunning('dedupe-b'),
      isAgentRunning('dedupe-c'),
    ])
    expect(inside).toEqual(outside)
    expect(listSessionsSpawns()).toHaveLength(1)
  })
})

describe('sweepSubAgents(): one sweep reads one list-sessions', () => {
  it('sweeps every running sub-agent from a single memoized list-sessions', () => {
    sweepSubAgents(liveStyleDeps())
    // dedupe-a and dedupe-b are running, dedupe-c is not: three deps.isRunning() reads,
    // ONE list-sessions spawn for the wrapped sweep.
    expect(listSessionsSpawns()).toHaveLength(1)

    // Behaviour unchanged: the running agents were swept and captured (one
    // pane read each), the stopped one skipped before any pane read, and no
    // wait alert fires on quiet panes.
    expect(h.captures).toEqual([
      { agent: 'dedupe-a', session: 'agent-dedupe-a' },
      { agent: 'dedupe-b', session: 'agent-dedupe-b' },
    ])
    expect(h.alerts).toEqual([])
  })

  it('a later sweep re-reads: the memo spans one sweep, not the watcher lifetime', () => {
    sweepSubAgents(liveStyleDeps())
    expect(listSessionsSpawns()).toHaveLength(1)

    h.sessions = 'agent-dedupe-a\nagent-dedupe-b\nagent-dedupe-c' // dedupe-c came up
    h.captures.length = 0
    sweepSubAgents(liveStyleDeps())
    expect(listSessionsSpawns()).toHaveLength(2) // one per sweep
    expect(h.captures.map((c) => c.agent)).toEqual(['dedupe-a', 'dedupe-b', 'dedupe-c'])
  })

  it('injected test deps keep working: a fake isRunning is honoured as before', () => {
    // The wrap must be transparent for callers that inject their own seam (the
    // established test style this watcher was built for): the fake's answers,
    // not the tmux list, decide.
    h.spawns.length = 0
    sweepSubAgents({
      ...liveStyleDeps(),
      isRunning: (agent) => agent === 'dedupe-c',
    })
    expect(listSessionsSpawns()).toHaveLength(0)
    expect(h.captures.map((c) => c.agent)).toEqual(['dedupe-c'])
  })
})

// ---- source pins: the wrap is where the reads are, and only that changed ------

const raw = readFileSync(join(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')
const sf = ts.createSourceFile('stuck-tool-call-watcher.ts', raw, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function batchCallbacksOf(source: ts.SourceFile): ts.ArrowFunction[] {
  const out: ts.ArrowFunction[] = []
  walk(source, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'withTmuxBatch' &&
      n.arguments.length > 0 &&
      ts.isArrowFunction(n.arguments[0])
    ) {
      out.push(n.arguments[0])
    }
  })
  return out
}

function containsNode(root: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  let found = false
  walk(root, (n) => {
    if (pred(n)) found = true
  })
  return found
}

function nodeText(node: ts.Node): string {
  return raw
    .slice(node.getStart(sf), node.getEnd())
    .split('\n')
    .map((line) => line.replace(/^\s+/, ''))
    .join('\n')
}

function containsAwait(root: ts.Node): boolean {
  return containsNode(
    root,
    (n) => ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier !== undefined),
  )
}

// R2: no agent start/stop/restart or prompt/keystroke send inside the region.
const FORBIDDEN = ['restartAgentProcess', 'stopAgentProcess', 'startAgentProcess', 'sendPromptToSession', 'resumeMarveenSession']
function containsForbiddenCall(root: ts.Node): boolean {
  return containsNode(root, (n) => {
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(sf)
      if (FORBIDDEN.some((f) => name === f || name.endsWith(`.${f}`))) return true
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      return /^(send-keys|kill-session|respawn-pane|new-session)$/.test(n.text)
    }
    return false
  })
}

// The loop exactly as it was before the wrap (only re-indented); pinning it
// byte-for-byte inside the callback proves no statement was added, removed or
// reordered -- the wrap is the whole change.
const ORIGINAL_LOOP = `
for (const agent of agents) {
try {
if (!deps.isRunning(agent)) continue
seen.add(agent)
const session = agentSessionName(agent)
const pane = deps.capture(agent, session)
const now = deps.now()

// Waiting on a person (permission prompt / held peer message). A
// permission prompt on a channel-owning agent is the channel-monitor's
// (one owner per state, #1596 review point 1).
let kind = classifyAgentWait(pane)
// The state file only adds a wait the pane did not show (STATEOBS1012).
const reading = kind == null && deps.readState ? deps.readState(agent) : null
if (kind == null && stateFileSaysWaiting(reading, pane, now)) kind = 'permission'
if (kind === 'permission' && deps.hasChannel(agent)) kind = null
const prevWait = agentWaitState.get(agent) ?? { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
const wait = decidePaneErrorAlert(kind != null, prevWait, now, waitThresholds)
if (wait.next.firstSeenAt === null) agentWaitState.delete(agent)
else agentWaitState.set(agent, wait.next)
if (wait.alert && kind != null) {
// What it asks: the card on the pane, else the tool the state file names.
const ask = kind !== 'permission'
? null
: (pane != null ? permissionPromptSummary(pane) : null)
?? (reading ? { title: reading.tool ?? 'ismeretlen eszköz', reason: 'az állapotfigyelő szerint jóváhagyásra vár' } : null)
logger.warn({ agent, session, kind, waitingMs: now - (wait.next.firstSeenAt ?? now) }, 'stuck-tool-call-watcher: sub-agent is waiting on a person (no keystrokes sent) -- alerting')
deps.alertWait(agent, session, kind, now - (wait.next.firstSeenAt ?? now), ask)
}
} catch (err) {
logger.debug({ err, agent }, 'stuck-tool-call-watcher: sub-agent check error')
}
}
`.trim()

describe('source pins: the sub-agent sweep runs inside withTmuxBatch', () => {
  const callbacks = batchCallbacksOf(sf)

  it('withTmuxBatch is imported from agent-process.js and used exactly once', () => {
    expect(raw).toMatch(/import\s+\{[^}]*\bwithTmuxBatch\b[^}]*\}\s+from\s+'\.\/agent-process\.js'/)
    expect(callbacks).toHaveLength(1)
  })

  it('the wrapped region is the per-agent loop of sweepSubAgents(), statements unchanged', () => {
    const cb = callbacks[0]
    const body = cb.body
    if (!ts.isBlock(body)) throw new Error('expected the wrapped callback body to be a block')
    const loops = body.statements.filter((st) => ts.isForOfStatement(st))
    expect(loops).toHaveLength(1)
    expect(nodeText(loops[0])).toBe(ORIGINAL_LOOP)
    // The dedupable read is inside: deps.isRunning called once per iteration.
    expect(
      containsNode(cb, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'deps.isRunning'),
    ).toBe(true)
  })

  it('the wrapped region is synchronous (R1) and mutates no session (R2)', () => {
    const cb = callbacks[0]
    expect(containsAwait(cb)).toBe(false)
    expect(containsForbiddenCall(cb)).toBe(false)
  })

  it('the wrap sits inside sweepSubAgents; the stop-state cleanup stays outside', () => {
    const cb = callbacks[0]
    let sweep: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'sweepSubAgents') sweep = n
    })
    expect(sweep).toBeDefined()
    expect(cb.getStart(sf)).toBeGreaterThan(sweep!.getStart(sf))
    expect(cb.getEnd()).toBeLessThan(sweep!.getEnd())
    // The cleanup loop (forgetting stopped agents) is NOT inside the batch.
    expect(containsNode(cb, (n) => ts.isForOfStatement(n) && n.expression.getText(sf) === '[...agentWaitState.keys()]')).toBe(false)
  })
})
