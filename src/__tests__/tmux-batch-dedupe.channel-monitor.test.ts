// Site 3 of the tmux read dedupe: the channel-monitor's tick (the sweep the
// profiler labelled "stuck-input-watcher") builds its target lists with a
// per-agent isAgentRunning() -- one identical `tmux list-sessions` spawn per
// agent, twice per tick (the channel-target loop and the gate-only menu-target
// loop). Both loops are synchronous islands inside the async check(), and both
// now run inside withTmuxBatch, so each answers from ONE list-sessions.
//
// The stuck-input recovery itself (recoverStuckInputForSession) is deliberately
// NOT wrapped: it is async per-iteration and performs the Enter / clear +
// re-inject keystrokes, which a batch must never hide (R2). These tests prove:
//  (a) behaviour is unchanged -- both wrapped loops are pinned byte-for-byte
//      inside the batch callback, so no statement was added, removed or
//      reordered, and nothing else in the file gained a wrap;
//  (b) the dedupe happens -- the reads the loops make, run through the REAL
//      withTmuxBatch against a recorded spawn seam, run the identical
//      list-sessions query once per wrapped region (and once per agent outside
//      a batch, which is the control).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { isAgentRunning, withTmuxBatch } from '../web/agent-process.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Every execFileSync in the process is recorded; list-sessions answers from a
// canned session list so the real isAgentRunning() -> agentRunState() ->
// captureTmux() path classifies agents (only the spawn itself is faked).
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  sessions: 'agent-dedupe-a\nagent-dedupe-b',
}))

vi.mock('node:child_process', async (importOriginal) => {
  const { execFileFromSync } = await import('./helpers/exec-file-from-sync.js')
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = (file: string, args?: readonly string[]): string => {
    const a = Array.isArray(args) ? [...args] : []
    h.spawns.push({ file, args: a })
    if (a[0] === 'list-sessions') return `${h.sessions}\n`
    if (a[0] === 'list-panes') return 'agent-dedupe-a\t1\tclaude\nagent-dedupe-b\t1\tclaude\n'
    return ''
  }
  return { ...actual, execFile: execFileFromSync(execFileSync), execFileSync: execFileSync as unknown as typeof actual.execFileSync }
})

const listSessionsSpawns = () => h.spawns.filter((s) => s.args[0] === 'list-sessions')

beforeEach(() => {
  h.spawns.length = 0
  h.sessions = 'agent-dedupe-a\nagent-dedupe-b'
})

describe('mechanism: the reads both wrapped loops make, through the real withTmuxBatch', () => {
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

  it('two consecutive wrapped regions each read once (per-region memo, no cross-tick leak)', () => {
    withTmuxBatch(() => {
      isAgentRunning('dedupe-a')
      isAgentRunning('dedupe-b')
    })
    withTmuxBatch(() => {
      isAgentRunning('dedupe-a')
      isAgentRunning('dedupe-c')
    })
    expect(listSessionsSpawns()).toHaveLength(2)
  })
})

// ---- source pins: the wraps are where the reads are, and only that changed ---

const raw = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
const sf = ts.createSourceFile('channel-monitor.ts', raw, ts.ScriptTarget.Latest, true)

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
const FORBIDDEN = ['restartAgentProcess', 'stopAgentProcess', 'startAgentProcess', 'sendPromptToSession', 'resumeMarveenSession', 'recoverStuckInputForSession']
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

// Both loops exactly as they were before the wrap (only re-indented); pinning
// them byte-for-byte inside the callbacks proves no statement was added,
// removed or reordered -- the wraps are the whole change.
const ORIGINAL_TARGETS_LOOP = `
for (const a of listAgentNames()) {
if (isAgentRunning(a) && agentHasChannel(a)) {
targets.push({
session: agentSessionName(a),
isMarveen: false,
agentName: a,
provider: resolveAgentProvider(a),
})
}
}
`.trim()

const ORIGINAL_MENU_TARGETS_LOOP = `
for (const a of listAgentNames()) {
if (agentHasChannel(a) || !readAgentWorksourceChannel(a) || readAgentRemoteHost(a) || !isAgentRunning(a)) continue
menuTargets.push({ session: agentSessionName(a), isMarveen: false, agentName: a, gateOnly: true })
}
`.trim()

describe('source pins: both target-building loops run inside withTmuxBatch', () => {
  const callbacks = batchCallbacksOf(sf)

  it('withTmuxBatch is imported from agent-process.js and used exactly twice', () => {
    expect(raw).toMatch(/import\s+\{[^}]*\bwithTmuxBatch\b[^}]*\}\s+from\s+'\.\/agent-process\.js'/)
    expect(callbacks).toHaveLength(2)
  })

  it('the channel-target loop is wrapped, statements unchanged', () => {
    const cb = callbacks.find((c) =>
      containsNode(c, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'isAgentRunning'),
    )
    expect(cb).toBeDefined()
    const body = cb!.body
    if (!ts.isBlock(body)) throw new Error('expected the wrapped callback body to be a block')
    const loops = body.statements.filter((st) => ts.isForOfStatement(st))
    expect(loops).toHaveLength(1)
    expect(nodeText(loops[0])).toBe(ORIGINAL_TARGETS_LOOP)
  })

  it('the gate-only menu-target loop is wrapped, statements unchanged', () => {
    const cb = callbacks.find((c) =>
      containsNode(c, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'readAgentWorksourceChannel'),
    )
    expect(cb).toBeDefined()
    const body = cb!.body
    if (!ts.isBlock(body)) throw new Error('expected the wrapped callback body to be a block')
    const loops = body.statements.filter((st) => ts.isForOfStatement(st))
    expect(loops).toHaveLength(1)
    expect(nodeText(loops[0])).toBe(ORIGINAL_MENU_TARGETS_LOOP)
    expect(
      containsNode(cb!, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'isAgentRunning'),
    ).toBe(true)
  })

  it('both wrapped regions are synchronous (R1) and mutate no session (R2)', () => {
    for (const cb of callbacks) {
      expect(containsAwait(cb)).toBe(false)
      expect(containsForbiddenCall(cb)).toBe(false)
    }
  })

  it('both wraps sit inside the monitor tick function check()', () => {
    let check: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'check') check = n
    })
    expect(check).toBeDefined()
    for (const cb of callbacks) {
      expect(cb.getStart(sf)).toBeGreaterThan(check!.getStart(sf))
      expect(cb.getEnd()).toBeLessThan(check!.getEnd())
    }
  })

  it('the stuck-input recovery sweep and the pre-start agent filter stay unwrapped', () => {
    // R2: recoverStuckInputForSession performs the Enter / clear + re-inject
    // keystrokes (and is awaited per target), so it must never sit in a batch.
    for (const cb of callbacks) {
      expect(containsNode(cb, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'recoverStuckInputForSession')).toBe(false)
      expect(containsNode(cb, (n) => ts.isCallExpression(n) && n.expression.getText(sf) === 'maybeRestartWedgedMainChannel')).toBe(false)
    }
    // reconcileDesiredAgents' !isAgentRunning(name) filter feeds agent starts,
    // so it must stay outside any batch too -- assert neither wrap touches it.
    let reconcile: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'reconcileDesiredAgents') reconcile = n
    })
    expect(reconcile).toBeDefined()
    for (const cb of callbacks) {
      const disjoint =
        cb.getEnd() <= reconcile!.getStart(sf) || cb.getStart(sf) >= reconcile!.getEnd()
      expect(disjoint).toBe(true)
    }
  })
})
