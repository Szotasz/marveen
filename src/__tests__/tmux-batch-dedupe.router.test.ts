// Site 4 of the tmux read dedupe: every router tick classifies each unique
// receiver with sessionExistsOnHost() -- one identical `tmux list-sessions`
// spawn per receiver, re-issued every 5s tick. The synchronous receiver
// pre-pass in runMessageRouterTick now runs inside withTmuxBatch, so the whole
// pass answers from ONE list-sessions. The pre-pass is deliberately a
// synchronous island: the first await of the tick (deliverFederatedBatch) comes
// AFTER it, and the per-message loop below reuses the agentSessionCache the
// pre-pass filled instead of re-calling sessionExistsOnHost (the one remaining
// direct call there is a never-taken fallback for receivers outside the
// pending set -- pinned outside the batch below).
//
// runMessageRouterTick is "extracted from the setInterval body so it can be
// exercised directly in unit tests", so this drives the REAL tick with only the
// tmux spawn and the db row store faked, across the reconnect-batch scenario
// the pre-pass exists for. Proves both halves:
//  (a) behaviour is unchanged -- an all-absent tick delivers nothing, and a
//      reconnect tick still batches the old backlog (rows closed as done, ONE
//      [BACKLOG-SUMMARY] created) exactly as before, with no pane write;
//  (b) the dedupe happens -- the identical list-sessions query runs ONCE per
//      tick for all receivers (and once per receiver outside a batch, the
//      control), freshly on every tick.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { runMessageRouterTick } from '../web/message-router.js'
import { sessionExistsOnHost, withTmuxBatch } from '../web/agent-process.js'
import type { AgentMessage } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type DbModule = typeof import('../db.js')

// Every execFileSync in the process is recorded; list-sessions answers from a
// canned session list so the real sessionExistsOnHost() -> captureTmux() path
// classifies receivers (only the spawn itself is faked).
const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[] }>,
  sessions: 'agent-dedupe-a\nagent-dedupe-b',
  // The pending rows getPendingMessages() serves, by agent name.
  rows: [] as Array<{ id: number; from: string; to: string; ageSec: number }>,
  done: [] as Array<{ id: number; note: string }>,
  created: [] as Array<{ from: string; to: string; content: string }>,
  failed: [] as Array<{ id: number; reason: string }>,
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

// The router's own unit-test seam: the tick is driven directly, with the row
// store canned and the three write paths the reconnect batch uses recorded.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<DbModule>()
  const msg = (r: { id: number; from: string; to: string; ageSec: number }): AgentMessage =>
    ({
      id: r.id,
      from_agent: r.from,
      to_agent: r.to,
      content: `report ${r.id}`,
      created_at: Math.floor(Date.now() / 1000) - r.ageSec,
      urgent: 0,
    }) as unknown as AgentMessage
  return {
    ...actual,
    getPendingMessages: ((agent?: string) =>
      h.rows.filter((r) => !agent || r.to === agent).map(msg)) as unknown as DbModule['getPendingMessages'],
    markMessageDone: ((id: number, note: string) => {
      h.done.push({ id, note })
      return 1
    }) as unknown as DbModule['markMessageDone'],
    markPendingMessageFailed: ((id: number, reason: string) => {
      h.failed.push({ id, reason })
      return false
    }) as unknown as DbModule['markPendingMessageFailed'],
    createAgentMessage: ((from: string, to: string, content: string) => {
      h.created.push({ from, to, content })
      return 0
    }) as unknown as DbModule['createAgentMessage'],
  }
})

const listSessionsSpawns = () => h.spawns.filter((s) => s.args[0] === 'list-sessions')

beforeEach(() => {
  h.spawns.length = 0
  h.done.length = 0
  h.created.length = 0
  h.failed.length = 0
  h.sessions = 'agent-dedupe-a\nagent-dedupe-b'
  h.rows = []
})

describe('mechanism: the read the pre-pass makes, through the real withTmuxBatch', () => {
  it('outside a batch every per-receiver sessionExistsOnHost() is its own identical list-sessions spawn', () => {
    expect(sessionExistsOnHost(null, 'agent-dedupe-a')).toBe(true)
    expect(sessionExistsOnHost(null, 'agent-dedupe-b')).toBe(true)
    expect(sessionExistsOnHost(null, 'agent-dedupe-c')).toBe(false)
    expect(listSessionsSpawns()).toHaveLength(3)
  })

  it('inside withTmuxBatch the identical query runs once and every answer is unchanged', () => {
    const outside = [
      sessionExistsOnHost(null, 'agent-dedupe-a'),
      sessionExistsOnHost(null, 'agent-dedupe-b'),
      sessionExistsOnHost(null, 'agent-dedupe-c'),
    ]
    expect(listSessionsSpawns()).toHaveLength(3)

    h.spawns.length = 0
    const inside = withTmuxBatch(() => [
      sessionExistsOnHost(null, 'agent-dedupe-a'),
      sessionExistsOnHost(null, 'agent-dedupe-b'),
      sessionExistsOnHost(null, 'agent-dedupe-c'),
    ])
    expect(inside).toEqual(outside)
    expect(listSessionsSpawns()).toHaveLength(1)
  })
})

describe('runMessageRouterTick(): one list-sessions per tick, reconnect batch intact', () => {
  it('an all-absent tick classifies every receiver from one memoized list-sessions and delivers nothing', async () => {
    h.sessions = '' // nobody is up
    h.rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: 101 + i, from: 'prisma', to: 'dedupe-a', ageSec: 2 * 3600 })),
      { id: 201, from: 'prisma', to: 'dedupe-b', ageSec: 2 * 3600 },
      { id: 202, from: 'prisma', to: 'dedupe-c', ageSec: 2 * 3600 },
    ]

    await runMessageRouterTick()

    // Three receivers in the tick, ONE list-sessions spawn for the wrapped pre-pass.
    expect(listSessionsSpawns()).toHaveLength(1)
    // Behaviour unchanged: nobody is present, so nothing is closed, delivered,
    // summarized or failed -- the rows simply wait for the next tick.
    expect(h.done).toEqual([])
    expect(h.created).toEqual([])
    expect(h.failed).toEqual([])
    expect(h.spawns.filter((s) => s.args[0] !== 'list-sessions')).toEqual([])
  })

  it('the reconnect tick still batches the backlog, still from one list-sessions', async () => {
    h.sessions = '' // tick 1: dedupe-a away, so its return is a reconnect
    h.rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: 101 + i, from: 'prisma', to: 'dedupe-a', ageSec: 2 * 3600 })),
      { id: 201, from: 'prisma', to: 'dedupe-b', ageSec: 2 * 3600 },
      { id: 202, from: 'prisma', to: 'dedupe-c', ageSec: 2 * 3600 },
    ]
    await runMessageRouterTick()
    expect(listSessionsSpawns()).toHaveLength(1)

    h.spawns.length = 0
    h.sessions = 'agent-dedupe-a' // dedupe-a came back
    await runMessageRouterTick() // tick 2: the pre-pass sees it present

    // Fresh batch per tick: still exactly one list-sessions for three receivers.
    expect(listSessionsSpawns()).toHaveLength(1)

    // Behaviour unchanged: the 8 old rows are closed as done and ONE summary
    // message is created for dedupe-a -- the pre-wrap reconnect batch, fed by
    // the memoized (but per-agent identical) presence answer.
    expect(h.done.map((d) => d.id)).toEqual([101, 102, 103, 104, 105, 106, 107, 108])
    expect(h.done.every((d) => d.note === 'batched into backlog summary for dedupe-a')).toBe(true)
    expect(h.created).toEqual([
      { from: 'system', to: 'dedupe-a', content: expect.stringContaining('[BACKLOG-SUMMARY] 8 inter-agent message(s)') },
    ])
    // The still-absent receivers' rows were neither failed nor delivered...
    expect(h.failed).toEqual([])
    // ...and no pane was touched: the batched rows never reach the send path.
    expect(h.spawns.filter((s) => s.args[0] !== 'list-sessions')).toEqual([])

    // Tick 3: no reconnect any more, so nothing new is batched -- and the memo
    // spans one tick, not the router's lifetime (one more fresh read).
    h.spawns.length = 0
    await runMessageRouterTick()
    expect(listSessionsSpawns()).toHaveLength(1)
    expect(h.done).toHaveLength(8)
    expect(h.created).toHaveLength(1)
  })
})

// ---- source pins: the wrap is where the reads are, and only that changed ------

const raw = readFileSync(join(__dirname, '..', 'web', 'message-router.ts'), 'utf-8')
const sf = ts.createSourceFile('message-router.ts', raw, ts.ScriptTarget.Latest, true)

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

// R2: a batch must not hide a session state change behind the memo, so none of
// the mutating entry points may sit inside the wrapped region.
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

function callsNamed(root: ts.Node, name: string): number {
  let n = 0
  walk(root, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === name) n++
  })
  return n
}

// The pre-pass loop exactly as it was before the wrap (only re-indented);
// pinning it byte-for-byte inside the callback proves no statement was added,
// removed or reordered -- the wrap is the whole change.
const ORIGINAL_LOOP = `
for (const agent of receiversInTick) {
const host = readAgentRemoteHost(agent)
const session = agentSessionName(agent)
const exists = sessionExistsOnHost(host, session)
// Read once per receiver per tick, not once per message: the flag decides
// the whole delivery path below and a per-message read would re-open the
// same config file for every queued item.
agentSessionCache.set(agent, { host, session, exists, worksource: readAgentWorksourceChannel(agent) })
if (exists) {
presentNow.add(agent)
} else {
absentNow.add(agent)
}
}
`.trim()

describe('source pins: the receiver pre-pass runs inside withTmuxBatch', () => {
  const callbacks = batchCallbacksOf(sf)

  it('withTmuxBatch is imported from agent-process.js and used exactly once', () => {
    expect(raw).toMatch(/import\s+\{[^}]*\bwithTmuxBatch\b[^}]*\}\s+from\s+'\.\/agent-process\.js'/)
    expect(callbacks).toHaveLength(1)
  })

  it('the wrapped region is the receiver pre-pass of runMessageRouterTick(), statements unchanged', () => {
    const cb = callbacks[0]
    let tick: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'runMessageRouterTick') tick = n
    })
    expect(tick).toBeDefined()
    expect(cb.getStart(sf)).toBeGreaterThan(tick!.getStart(sf))
    expect(cb.getEnd()).toBeLessThan(tick!.getEnd())

    const body = cb.body
    if (!ts.isBlock(body)) throw new Error('expected the wrapped callback body to be a block')
    const loops = body.statements.filter((st) => ts.isForOfStatement(st))
    expect(loops).toHaveLength(1)
    expect(nodeText(loops[0])).toBe(ORIGINAL_LOOP)
    // The dedupable read is inside, once per receiver.
    expect(callsNamed(cb, 'sessionExistsOnHost')).toBe(1)
  })

  it('the wrapped region is synchronous (R1) and mutates no session (R2)', () => {
    const cb = callbacks[0]
    expect(containsAwait(cb)).toBe(false)
    expect(containsForbiddenCall(cb)).toBe(false)
  })

  it('the per-message fallback read stays outside the batch', () => {
    // The main loop reuses the pre-pass cache and keeps one direct
    // sessionExistsOnHost as a fallback for receivers outside the pending set;
    // that call must not be dragged into the memoized region.
    const cb = callbacks[0]
    let tick: ts.FunctionDeclaration | undefined
    walk(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'runMessageRouterTick') tick = n
    })
    expect(callsNamed(tick!, 'sessionExistsOnHost')).toBe(2)
    expect(callsNamed(cb, 'sessionExistsOnHost')).toBe(1)
  })
})
