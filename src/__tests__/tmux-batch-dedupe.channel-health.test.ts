// Site 1 of the tmux read dedupe (measured 2026-11: 82% of main-thread time was
// synchronous child spawn, and the channel-health check asked isAgentRunning()
// per agent -- one identical `tmux list-sessions` spawn each). The per-agent
// pass in startChannelHealthMonitor's check() now runs inside withTmuxBatch, so
// the whole pass answers from ONE list-sessions.
//
// Proves both halves of the change:
//  (a) behaviour is unchanged -- the main agent is still checked first, every
//      running agent still gets its own capture-pane, a stopped agent is still
//      skipped before any pane read, and no reconnect bookkeeping appears;
//  (b) the dedupe happens -- the identical list-sessions query runs ONCE for
//      the whole wrapped region (and three times when the same reads are made
//      outside a batch, which is the control).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { startChannelHealthMonitor, getChannelHealth } from '../web/channel-health-monitor.js'
import { isAgentRunning, withTmuxBatch } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every execFileSync in the process is recorded; list-sessions answers from a
// canned session list so isAgentRunning() classifies real agents through the
// real agentRunState() -> captureTmux() path (only the spawn itself is faked).
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  sessions: 'agent-dedupe-a\nagent-dedupe-b',
  agents: ['dedupe-a', 'dedupe-b', 'dedupe-c'],
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

// The sweep walks the configured agents; the store has none in a test checkout.
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, listAgentNames: () => [...h.agents] }
})

// Deterministic session for the fake agents (the real resolver is config-driven).
vi.mock('../web/channel-mcp-reconnect.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, resolveAgentSession: (name: string) => `agent-${name}` }
})

const listSessionsSpawns = () => h.spawns.filter((s) => s.args[0] === 'list-sessions')
const capturePaneTargets = () =>
  h.spawns
    .filter((s) => s.args[0] === 'capture-pane')
    .map((s) => s.args[s.args.indexOf('-t') + 1] ?? '')

beforeEach(() => {
  h.spawns.length = 0
  h.sessions = 'agent-dedupe-a\nagent-dedupe-b'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mechanism: the reads the loop makes, through the real withTmuxBatch', () => {
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

describe('channel-health check(): the per-agent pass reads one list-sessions', () => {
  it('sweeps every running agent from a single memoized list-sessions', () => {
    vi.useFakeTimers()
    const timer = startChannelHealthMonitor()
    try {
      vi.advanceTimersByTime(45_000) // the initial setTimeout delay
      // dedupe-a and dedupe-b are running, dedupe-c is not: three isAgentRunning() reads,
      // ONE list-sessions spawn for the wrapped pass.
      expect(listSessionsSpawns()).toHaveLength(1)

      // Behaviour unchanged: the main agent's own check still ran first, every
      // RUNNING agent still got its own pane read, and the stopped agent was
      // skipped before any pane read.
      const captured = capturePaneTargets()
      expect(captured.filter((t) => t.includes('agent-dedupe-a'))).toHaveLength(1)
      expect(captured.filter((t) => t.includes('agent-dedupe-b'))).toHaveLength(1)
      expect(captured.filter((t) => t.includes('agent-dedupe-c'))).toHaveLength(0)
      expect(captured.filter((t) => t.includes(MAIN_CHANNELS_SESSION))).toHaveLength(1)

      // An empty pane leaves the health state untouched, exactly as before.
      expect(getChannelHealth('dedupe-a')).toEqual({ healthy: true, reconnectAttempts: 0, lastAttemptAt: null })
    } finally {
      clearInterval(timer)
    }
  })

  it('a later tick re-reads: the memo spans one pass, not the monitor lifetime', () => {
    vi.useFakeTimers()
    const timer = startChannelHealthMonitor()
    try {
      vi.advanceTimersByTime(45_000)
      expect(listSessionsSpawns()).toHaveLength(1)
      h.spawns.length = 0
      h.sessions = 'agent-dedupe-a\nagent-dedupe-b\nagent-dedupe-c' // dedupe-c came up
      vi.advanceTimersByTime(60_000) // the interval
      expect(listSessionsSpawns()).toHaveLength(1)
      expect(capturePaneTargets().filter((t) => t.includes('agent-dedupe-c'))).toHaveLength(1)
    } finally {
      clearInterval(timer)
    }
  })
})

// ---- source pins: the wrap is where the reads are, and only that changed ------

const raw = readFileSync(join(__dirname, '..', 'web', 'channel-health-monitor.ts'), 'utf-8')
const sf = ts.createSourceFile('channel-health-monitor.ts', raw, ts.ScriptTarget.Latest, true)

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

// withTmuxBatch is sync-only (agent-process.ts throws a TypeError on a promise
// return), so the pinned region must contain no await of any kind.
function containsAwait(root: ts.Node): boolean {
  return containsNode(
    root,
    (n) => ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier !== undefined),
  )
}

// R2: a batch must not hide a session state change behind the memo, so none of
// the mutating entry points may sit inside the wrapped region. (checkAgent's
// detached reconnect child is a separate PROCESS spawned fire-and-forget; it is
// not an in-process tmux mutation and stays outside this pin's scope by design.)
const FORBIDDEN = ['restartAgentProcess', 'stopAgentProcess', 'startAgentProcess', 'sendPromptToSession']
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
for (const name of listAgentNames()) {
if (!isAgentRunning(name)) continue
try {
checkAgent(name, resolveAgentSession(name))
} catch (err) {
logger.debug({ err, agent: name }, 'channel-health-monitor: agent check error')
}
}
`.trim()

describe('source pins: the per-agent pass runs inside withTmuxBatch', () => {
  const callbacks = batchCallbacksOf(sf)

  it('withTmuxBatch is imported from agent-process.js and used exactly once', () => {
    expect(raw).toMatch(/import\s+\{[^}]*\bwithTmuxBatch\b[^}]*\}\s+from\s+'\.\/agent-process\.js'/)
    expect(callbacks).toHaveLength(1)
  })

  it('the wrapped region is the per-agent loop of check(), statements unchanged', () => {
    const cb = callbacks[0]
    const body = cb.body
    if (!ts.isBlock(body)) throw new Error('expected the wrapped callback body to be a block')
    const loops = body.statements.filter((st) => ts.isForOfStatement(st))
    expect(loops).toHaveLength(1)
    expect(nodeText(loops[0])).toBe(ORIGINAL_LOOP)
    // The dedupable read is inside: isAgentRunning called once per iteration.
    expect(containsNode(cb, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'isAgentRunning')).toBe(true)
  })

  it('the wrapped region is synchronous (R1) and mutates no session (R2)', () => {
    const cb = callbacks[0]
    expect(containsAwait(cb)).toBe(false)
    expect(containsForbiddenCall(cb)).toBe(false)
  })

  it('the wrap sits inside startChannelHealthMonitor, after the main agent check', () => {
    const cb = callbacks[0]
    let monitor: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'startChannelHealthMonitor') monitor = n
    })
    expect(monitor).toBeDefined()
    expect(cb.getStart(sf)).toBeGreaterThan(monitor!.getStart(sf))
    expect(cb.getEnd()).toBeLessThan(monitor!.getEnd())
    // The main agent's own checkAgent call stays OUTSIDE the batch (it reads no
    // session list): exactly one checkAgent call inside, two in the function.
    const checkAgentInside = containsNode(cb, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'checkAgent')
    expect(checkAgentInside).toBe(true)
    let checkAgentTotal = 0
    walk(monitor!, (n) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'checkAgent') checkAgentTotal++
    })
    expect(checkAgentTotal).toBe(2)
  })
})
