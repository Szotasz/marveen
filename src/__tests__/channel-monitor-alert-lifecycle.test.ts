import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  stepStuckRestartLadder,
  createStuckLadder,
  mainInputBoxProvenEmpty,
  decideStuckInputRestart,
  carryOutageAcrossRecreate,
  decideMarveenRecoveryReport,
  hardRestartStageAlertText,
  type StuckRestartLadder,
  type StuckRestartObservation,
} from '../web/channel-monitor.js'

// Alert lifecycle of the main-channel recovery paths: every alert that opens
// must be able to close, a counter resets only on evidence, and a message
// reports what happened rather than what was about to be tried.

const __dirname = dirname(fileURLToPath(import.meta.url))

// The source as the compiler sees it: every comment (line, trailing, block)
// removed, and with `blankStrings` every string and template literal emptied.
// A commented-out statement, or one hidden inside a string, cannot satisfy a
// pin. Trailing blanks and blank lines are dropped so pins can be whole lines.
function sourceView(text: string, blankStrings: boolean): string {
  const sf = ts.createSourceFile('channel-monitor.ts', text, ts.ScriptTarget.Latest, true)
  const edits = new Map<number, { end: number; text: string }>()
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) edits.set(r.pos, { end: r.end, text: '' })
    for (const r of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) edits.set(r.pos, { end: r.end, text: '' })
    if (blankStrings) {
      const start = node.getStart(sf)
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        edits.set(start, { end: node.getEnd(), text: "''" })
        return
      }
      if (ts.isTemplateHead(node)) edits.set(start, { end: node.getEnd(), text: '`${' })
      else if (ts.isTemplateMiddle(node)) edits.set(start, { end: node.getEnd(), text: '}${' })
      else if (ts.isTemplateTail(node)) edits.set(start, { end: node.getEnd(), text: '}`' })
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, e] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, pos) + e.text + out.slice(e.end)
  return out.replace(/[ \t]+$/gm, '').replace(/^\n/gm, '')
}

const raw = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
// Comments stripped; whole-line pins that spell out a literal run on this view.
const src = sourceView(raw, false)
// Comments stripped AND literals emptied; counts and ordering run on this view.
const code = sourceView(raw, true)

// Syntax-tree view of one top-level function of the source.
const tree = ts.createSourceFile('channel-monitor.ts', raw, ts.ScriptTarget.Latest, true)
function fnNode(name: string): ts.FunctionDeclaration {
  const node = tree.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name)
  expect(node, name + ' not found').toBeDefined()
  return node!
}
// Walks a function body; with `own`, nested functions are not entered.
function walkBody(fn: ts.FunctionDeclaration, own: boolean, visit: (node: ts.Node) => void): void {
  const go = (node: ts.Node): void => {
    if (own && ts.isFunctionLike(node)) return
    visit(node)
    ts.forEachChild(node, go)
  }
  if (fn.body) ts.forEachChild(fn.body, go)
}
const lineOf = (pos: number): number => tree.getLineAndCharacterOfPosition(pos).line

// Body of the `if (<cond>) {` block that starts at `head`, up to its matching brace.
function sliceBlock(body: string, head: string): string {
  const start = body.indexOf(head)
  expect(start, head + ' not found').toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = start + head.length - 1; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}' && --depth === 0) return body.slice(start, i + 1)
  }
  throw new Error(head + ' block not closed')
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

function sliceFn(name: string, view: string = src): string {
  const start = view.indexOf('function ' + name)
  expect(start, name + ' not found').toBeGreaterThan(0)
  const end = view.indexOf('\n}\n', start)
  expect(end, name + ' closing brace not found').toBeGreaterThan(start)
  return view.slice(start, end)
}

const T0 = 10_000_000
const ladder = (over: Partial<StuckRestartLadder> = {}): StuckRestartLadder => ({
  count: 0, alertOpen: false, claudePid: 100, pidSeenAt: T0, ...over,
})
const obs = (over: Partial<StuckRestartObservation> = {}): StuckRestartObservation => ({
  parked: true, boxProvenEmpty: false, claudePid: 100, now: T0 + 60_000, lastSelfRespawnAt: 0, ...over,
})

describe('stepStuckRestartLadder: reset only on evidence (busy / unreadable keep the cap)', () => {
  it('a readable idle pane with an empty box resets the count', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2 }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.next.count).toBe(0)
  })

  it('a busy tick (not parked, box not proven empty) leaves the count alone', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2 }), obs({ parked: false, boxProvenEmpty: false }))
    expect(s.next.count).toBe(2)
  })

  it('an unreadable tick (capture and pid both null) changes nothing', () => {
    const prev = ladder({ count: 3, alertOpen: true })
    const s = stepStuckRestartLadder(prev, obs({ parked: false, boxProvenEmpty: false, claudePid: null }))
    expect(s.next).toEqual(prev)
    expect(s.sendResolved).toBe(false)
  })

  it('a still-parked tick never resets, even if boxProvenEmpty were set', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: true, boxProvenEmpty: true }))
    expect(s.next.count).toBe(1)
  })

  it('regression: a busy tick right after the cap does not re-arm the ladder', () => {
    // Cap reached and alerted (count ticked past the cap). On the unfixed code
    // the busy tick reset the count to 0 and the ladder restarted.
    const capped = ladder({ count: 4, alertOpen: true })
    const s = stepStuckRestartLadder(capped, obs({ parked: false, boxProvenEmpty: false }))
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('skip')
  })
})

const SEP = '─'.repeat(80)
const FOOTER = ['  Opus 5 · ctx 406k/1.0M · 41%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents']
const IDLE_PANE = ['  ⎿  … tool output …', '', SEP, '❯ ', SEP, ...FOOTER].join('\n')
const TYPING_PANE = ['  ⎿  … tool output …', '', SEP, '❯ a draft somebody typed', SEP, ...FOOTER].join('\n')
const BUSY_PANE = ['  ⎿  … tool output …', '', '✳ Forming… (3m 7s · ↓ 6.1k tokens)', '', SEP, '❯ ', SEP, ...FOOTER].join('\n')

describe('mainInputBoxProvenEmpty', () => {
  it('a readable idle pane with an empty box is evidence', () => {
    expect(mainInputBoxProvenEmpty(IDLE_PANE, null)).toBe(true)
  })

  it('an unreadable capture is no evidence', () => {
    expect(mainInputBoxProvenEmpty(null, null)).toBe(false)
    expect(mainInputBoxProvenEmpty(null, IDLE_PANE)).toBe(false)
  })

  it('a busy pane is no evidence', () => {
    expect(mainInputBoxProvenEmpty(BUSY_PANE, null)).toBe(false)
    expect(mainInputBoxProvenEmpty(BUSY_PANE, IDLE_PANE)).toBe(false)
  })

  it('real typed text is no evidence', () => {
    expect(mainInputBoxProvenEmpty(TYPING_PANE, TYPING_PANE)).toBe(false)
    expect(mainInputBoxProvenEmpty(TYPING_PANE, null)).toBe(false)
  })

  it('a dim placeholder in an empty box counts as empty (dim-stripped view is idle)', () => {
    expect(mainInputBoxProvenEmpty(TYPING_PANE, IDLE_PANE)).toBe(true)
  })

  it('a blank capture (unknown state) is no evidence', () => {
    expect(mainInputBoxProvenEmpty('', null)).toBe(false)
  })
})

describe('stepStuckRestartLadder: closing the cap alert', () => {
  it('an open alert is closed once the box is proven empty', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.sendResolved).toBe(true)
    expect(s.next.alertOpen).toBe(false)
  })

  it('the closing message goes out only once', () => {
    const first = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: true }))
    const second = stepStuckRestartLadder(first.next, obs({ parked: false, boxProvenEmpty: true, now: T0 + 120_000 }))
    expect(second.sendResolved).toBe(false)
  })

  it('no closing message when no alert was open', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.sendResolved).toBe(false)
  })

  it('a busy tick does not close an open alert', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: false }))
    expect(s.sendResolved).toBe(false)
    expect(s.next.alertOpen).toBe(true)
  })
})

describe('stepStuckRestartLadder: manual claude replacement gets a fresh ladder', () => {
  it('a new pid with no monitor respawn since the old pid was seen resets the count', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 200, lastSelfRespawnAt: T0 - 1 }))
    expect(s.manualReplacement).toBe(true)
    expect(s.next.count).toBe(0)
    expect(s.next.claudePid).toBe(200)
    // A fresh ladder may restart again once the rate limit allows it.
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('restart')
  })

  it('the alert stays open across a manual replacement until the box is proven empty', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 200 }))
    expect(s.next.alertOpen).toBe(true)
    expect(s.sendResolved).toBe(false)
  })

  it('a new pid produced by the monitor itself keeps the cap', () => {
    const s = stepStuckRestartLadder(ladder({ count: 3 }), obs({ claudePid: 200, lastSelfRespawnAt: T0 + 30_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(3)
    expect(s.next.claudePid).toBe(200)
  })

  it('a --continue resume the monitor has only started (stamp not yet written) keeps the cap', () => {
    // The monitor marks a resume right before its respawn-pane; the shared
    // stamp follows seconds later. A tick in between sees the new pid with
    // only the mark moved, and the swap is still ours.
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }),
      obs({ parked: false, claudePid: 200, lastSelfRespawnAt: T0 + 10_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(4)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('skip')
  })

  it('the first readable pid is only recorded, never treated as a replacement', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2, claudePid: null, pidSeenAt: 0 }), obs({ claudePid: 300 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(2)
    expect(s.next.claudePid).toBe(300)
    expect(s.next.pidSeenAt).toBe(T0 + 60_000)
  })

  it('an unreadable pid keeps the last known one, so a later swap is still detected', () => {
    const blind = stepStuckRestartLadder(ladder({ count: 4 }), obs({ claudePid: null }))
    expect(blind.next.claudePid).toBe(100)
    expect(blind.next.pidSeenAt).toBe(T0)
    const swapped = stepStuckRestartLadder(blind.next, obs({ claudePid: 200, now: T0 + 120_000 }))
    expect(swapped.manualReplacement).toBe(true)
    expect(swapped.next.count).toBe(0)
  })

  it('the step result carries no fragment-record verdict', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: true, claudePid: 200 }))
    expect(Object.keys(s).sort()).toEqual(['manualReplacement', 'next', 'sendResolved'])
  })

  it('a same-pid tick refreshes pidSeenAt, so a self-respawn that changed nothing is not "own" forever', () => {
    // A --continue resume whose respawn threw: the mark moved, the pid did not.
    const markOnly = T0 + 5_000
    const same = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 100, lastSelfRespawnAt: markOnly }))
    expect(same.manualReplacement).toBe(false)
    expect(same.next.pidSeenAt).toBe(T0 + 60_000)
    // A later swap with no newer self-respawn is a manual one.
    const swapped = stepStuckRestartLadder(same.next, obs({ claudePid: 200, now: T0 + 120_000, lastSelfRespawnAt: markOnly }))
    expect(swapped.manualReplacement).toBe(true)
    expect(swapped.next.count).toBe(0)
  })

  it('the same pid is no replacement', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4 }), obs())
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(4)
  })
})

describe('createStuckLadder: the only way to change the ladder state', () => {
  const idle = (now: number, over: Partial<StuckRestartObservation> = {}): StuckRestartObservation =>
    obs({ parked: false, boxProvenEmpty: true, now, ...over })
  const busy = (now: number, over: Partial<StuckRestartObservation> = {}): StuckRestartObservation =>
    obs({ parked: false, boxProvenEmpty: false, now, ...over })

  it('exposes only its transitions, no writable state', () => {
    expect(Object.keys(createStuckLadder()).sort()).toEqual(['count', 'noteCapAlert', 'noteRestart', 'observe'])
  })

  it('starts empty: count 0 and no open alert, so the first idle tick sends nothing', () => {
    const l = createStuckLadder()
    expect(l.count()).toBe(0)
    const s = l.observe(idle(T0))
    expect(s.sendResolved).toBe(false)
    expect(s.prev).toEqual({ count: 0, alertOpen: false, claudePid: null, pidSeenAt: 0 })
  })

  it('a successful restart counts, a busy tick keeps it, proven-empty evidence resets it', () => {
    const l = createStuckLadder()
    l.noteRestart()
    l.noteRestart()
    expect(l.count()).toBe(2)
    l.observe(busy(T0))
    expect(l.count()).toBe(2)
    l.observe(idle(T0 + 60_000))
    expect(l.count()).toBe(0)
  })

  it('the cap alert ticks past the cap, stays open through busy ticks and closes once on evidence', () => {
    const l = createStuckLadder()
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    expect(l.count()).toBe(4)
    expect(l.observe(busy(T0)).sendResolved).toBe(false)
    expect(l.count()).toBe(4)
    expect(l.observe(idle(T0 + 60_000)).sendResolved).toBe(true)
    expect(l.observe(idle(T0 + 120_000)).sendResolved).toBe(false)
  })

  it('a restart after a manual re-arm keeps the open alert until the box is proven empty', () => {
    const l = createStuckLadder()
    l.observe(busy(T0, { claudePid: 100 }))
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    // Replaced by hand: a fresh ladder, but the alert stays open.
    l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(l.count()).toBe(0)
    l.noteRestart()
    expect(l.count()).toBe(1)
    expect(l.observe(idle(T0 + 120_000, { claudePid: 300, lastSelfRespawnAt: T0 + 90_000 })).sendResolved).toBe(true)
  })

  it('cap, manual replacement on a non-idle tick, then an idle tick closes the alert at count 0', () => {
    // The operator restarts by hand, as the cap alert asks: the booting pane is
    // not idle yet, so the count drops to 0 with the alert still open, and the
    // first idle empty-box tick must still send the closing message.
    const l = createStuckLadder()
    l.observe(obs({ parked: true, claudePid: 100, now: T0 }))
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    const swap = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(swap.manualReplacement).toBe(true)
    expect(l.count()).toBe(0)
    expect(swap.sendResolved).toBe(false)
    expect(l.observe(idle(T0 + 120_000, { claudePid: 200, lastSelfRespawnAt: 0 })).sendResolved).toBe(true)
  })

  // The cap is reached; the monitor's mark is from its last own restart, before
  // the pid was last seen. Then the main claude is replaced.
  const capped = (): ReturnType<typeof createStuckLadder> => {
    const l = createStuckLadder()
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    l.observe(obs({ parked: true, claudePid: 100, now: T0, lastSelfRespawnAt: T0 - 300_000 }))
    return l
  }

  it('a restart from a dashboard route after the cap gives a fresh ladder (the mark did not move)', () => {
    const l = capped()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: T0 - 300_000 }))
    expect(s.manualReplacement).toBe(true)
    expect(l.count()).toBe(0)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, l.count(), 5 * 60_000, 3)).toBe('restart')
  })

  it("the monitor's own restart after the cap keeps the cap (the mark moved)", () => {
    const l = capped()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: T0 + 30_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(l.count()).toBe(4)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, l.count(), 5 * 60_000, 3)).toBe('skip')
  })

  it('observe reports the state before the tick and keeps the step result', () => {
    const l = createStuckLadder()
    l.observe(busy(T0, { claudePid: 100 }))
    l.noteRestart()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(s.manualReplacement).toBe(true)
    expect(s.prev).toEqual({ count: 1, alertOpen: false, claudePid: 100, pidSeenAt: T0 })
    expect(l.count()).toBe(0)
    expect(l.observe(busy(T0 + 120_000, { claudePid: 200 })).prev.claudePid).toBe(200)
  })

  it('two ladders do not share state', () => {
    const a = createStuckLadder()
    const b = createStuckLadder()
    a.noteCapAlert()
    expect(b.count()).toBe(0)
    expect(b.observe(idle(T0)).sendResolved).toBe(false)
  })
})

describe('maybeRestartWedgedMainChannel wiring', () => {
  const fn = sliceFn('maybeRestartWedgedMainChannel')
  const fnCode = sliceFn('maybeRestartWedgedMainChannel', code)

  it('the monitor holds one ladder and touches it only through its transitions', () => {
    expect(src).toMatch(/^const stuckLadder = createStuckLadder\(\)$/m)
    expect(count(code, 'createStuckLadder(')).toBe(2) // definition + this one
    const uses = [...code.matchAll(/\bstuckLadder\b(\.\w+)?/g)].map((m) => m[1] ?? '')
    expect(uses.sort()).toEqual(['', '.count', '.count', '.noteCapAlert', '.noteRestart', '.observe'])
  })

  it('no longer resets the counter on a bare "not parked"', () => {
    expect(fn).not.toMatch(/if \(!parked\) \{\s*(stuckRestartCount|stuckLadder\.count) = 0/)
  })

  it('feeds the ladder exactly the evidence helper, the main pid and the self-respawn time', () => {
    // The capture and the tick as one unbroken sequence of whole lines:
    // evidence is read only on non-parked ticks, and the pid is not read when
    // that capture failed (no session: nothing to prove, and an unpiped tmux error).
    expect(fn).toMatch(new RegExp([
      '',
      '  const plain = parked \\? null : capturePane\\(MAIN_CHANNELS_SESSION\\)',
      "  const dimStripped = plain != null && detectPaneState\\(plain\\) === 'typing' \\? captureParkedInputView\\(MAIN_CHANNELS_SESSION\\) : null",
      '  const step = stuckLadder\\.observe\\(\\{',
      '    parked,',
      '    boxProvenEmpty: mainInputBoxProvenEmpty\\(plain, dimStripped\\),',
      '    claudePid: parked \\|\\| plain != null \\? getClaudePidForSession\\(MAIN_CHANNELS_SESSION\\) : null,',
      '    now: Date\\.now\\(\\),',
      '    lastSelfRespawnAt: monitorMainRespawnAt,',
      '  \\}\\)',
      '',
    ].join('\n')))
    expect(count(fnCode, 'getClaudePidForSession(')).toBe(1)
    expect(count(fnCode, 'mainInputBoxProvenEmpty(')).toBe(1)
  })

  it('the restart decision reads the ladder count, and a successful restart is counted', () => {
    expect(fn).toMatch(/^    Date\.now\(\), lastStuckRestartAt, stuckLadder\.count\(\),$/m)
    expect(fn).toMatch(/\n  if \(r\.ok\) \{\n    stuckLadder\.noteRestart\(\)\n/)
  })

  it('the monitor marks exactly its own respawns; the shared restart paths do not', () => {
    expect(src).toMatch(/^let monitorMainRespawnAt = 0$/m)
    // Declaration, five marks, one read (the ladder).
    expect(count(code, 'monitorMainRespawnAt')).toBe(7)
    expect(count(code, 'monitorMainRespawnAt =')).toBe(6)
    // The ladder's restart, the keep-alive respawn.
    expect(fn).toMatch(/\n  const r = hardRestartMarveenChannels\(\)\n  lastStuckRestartAt = Date\.now\(\)\n  monitorMainRespawnAt = lastStuckRestartAt\n/)
    expect(src).toMatch(/\n    marveenLastKeepaliveRespawn = now\n    monitorMainRespawnAt = Date\.now\(\)\n/)
    // What dashboard routes, plan rotation and onboarding call never marks.
    for (const name of ['hardRestartMarveenChannels', 'respawnMarveenSessionFresh', 'createMainChannelsSession', 'restartMainForRotationContinue']) {
      expect(sliceFn(name, code), name).not.toContain('monitorMainRespawnAt')
    }
    // The external-respawn detector keeps its own signal.
    expect(src).toMatch(/^    lastSelfRespawnMs: Math\.max\(marveenLastHardRestart, marveenLastKeepaliveRespawn, marveenLastSessionCreate, lastSelfStampWriteMs\),$/m)
  })

  it('a resume marks only when the monitor asked for it, immediately before its only respawn', () => {
    const resume = sliceFn('resumeMarveenSession')
    expect(src).toMatch(/^export async function resumeMarveenSession\(opts: \{ byMonitor\?: boolean \} = \{\}\): Promise<boolean> \{$/m)
    expect(resume).toMatch(new RegExp([
      '',
      '    if \\(opts\\.byMonitor\\) monitorMainRespawnAt = Date\\.now\\(\\)',
      "    execFileSync\\(tmuxBin\\(\\), \\['respawn-pane', '-k', '-t', exactTmuxTarget\\(MAIN_CHANNELS_SESSION\\), claudeCmd\\], \\{ timeout: 15000 \\}\\)",
      '',
    ].join('\n')))
    expect(count(resume, "'respawn-pane'")).toBe(1)
    // The only monitor caller is the stage-3 resume. The plan rotation passes
    // the function as is (no options); the watcher and the co-listen check call it bare.
    expect(sliceFn('handleMarveenDown')).toMatch(/^    await resumeMarveenSession\(\{ byMonitor: true \}\)$/m)
    expect(sliceFn('checkMainColistenChannels')).toMatch(/^    restart: \(\) => resumeMarveenSession\(\),$/m)
    expect(count(code, 'byMonitor: true')).toBe(1)
    expect(sliceFn('restartMainForRotationContinue')).toMatch(/^    resume: resumeMarveenSession,$/m)
    const watcher = readFileSync(join(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')
    expect(watcher).toContain('await resumeMarveenSession()')
    expect(watcher).not.toContain('byMonitor')
  })

  it('sends the closing alert before the early return', () => {
    expect(fn).toMatch(new RegExp([
      '',
      '  if \\(step\\.sendResolved\\) \\{',
      "    logger\\.info\\(\\{ session: MAIN_CHANNELS_SESSION \\}, '[^'\\n]*'\\)",
      '    sendAlert\\(`✅ A \\$\\{MAIN_CHANNELS_SESSION\\} bemenete felszabadult: [^`\\n]*`\\)',
      '  \\}',
      '  if \\(!parked\\) return',
      '',
    ].join('\n')))
    expect(count(fnCode, 'if (!parked) return')).toBe(1)
    expect(count(sliceBlock(fnCode, 'if (step.sendResolved) {'), 'sendAlert(')).toBe(1)
  })

  it('the STUCKFRAGMENT915 record lifecycle is the develop one', () => {
    // Exactly the develop call: forgotten on every tick without a parked
    // signature, as the first thing the function does. Nothing else in the
    // ladder touches the record.
    expect(count(fnCode, 'onParkedState(')).toBe(1)
    expect(fn).toMatch(/\{\n  const parked = state\.parkedSig !== null\n  onParkedState\(MAIN_CHANNELS_SESSION, parked\)\n/)
    expect(fnCode.indexOf('onParkedState(')).toBeLessThan(fnCode.indexOf('if ('))
    expect(count(fnCode, 'MachineFragmentLeft(')).toBe(1) // hasMachineFragmentLeft read only
    expect(fn).toMatch(/^    hasMachineFragmentLeft\(MAIN_CHANNELS_SESSION\),$/m)
    expect(sliceFn('stepStuckRestartLadder', code)).not.toMatch(/fragment|onParkedState/i)
    expect(sliceFn('onParkedState')).toMatch(/\{\n  if \(!parked\) clearMachineFragmentLeft\(session\)$/)
    expect(sliceFn('onClearResult')).toMatch(/\{\n  if \(result === 'left-fragment'\) noteMachineFragmentLeft\(session\)$/)
  })

  it('the cap alert opens the alert state', () => {
    expect(fn).toMatch(new RegExp([
      '',
      "  if \\(action === 'alert'\\) \\{",
      '    logger\\.error\\([^\\n]*\\)',
      '    sendAlert\\(`⛔ A \\$\\{MAIN_CHANNELS_SESSION\\} bemenete beragadt [^`\\n]*`\\)',
      '    stuckLadder\\.noteCapAlert\\(\\)',
      '    return',
      '  \\}',
      '',
    ].join('\n')))
  })
})

describe('control flow of the touched functions', () => {
  // A pinned line can be neutralised without touching it: by a brace-less
  // guard on the line above (the pinned statement becomes its body), or by an
  // early return inserted before it.
  it('no brace-less if has its body on a later line (nested callbacks included)', () => {
    for (const name of ['maybeRestartWedgedMainChannel', 'handleMarveenUp', 'handleMarveenDown', 'resumeMarveenSession', 'startChannelPluginMonitor']) {
      const offenders: number[] = []
      walkBody(fnNode(name), false, (node) => {
        if (ts.isIfStatement(node) && !ts.isBlock(node.thenStatement)
          && lineOf(node.thenStatement.getStart(tree)) > lineOf(node.getStart(tree))) offenders.push(lineOf(node.getStart(tree)) + 1)
      })
      expect(offenders, name).toEqual([])
    }
  })

  it('handleMarveenUp has no return and maybeRestartWedgedMainChannel exactly three', () => {
    const returns = (name: string): number => {
      let n = 0
      walkBody(fnNode(name), true, (node) => { if (ts.isReturnStatement(node)) n++ })
      return n
    }
    expect(returns('handleMarveenUp')).toBe(0)
    expect(returns('maybeRestartWedgedMainChannel')).toBe(3)
  })
})

describe('carryOutageAcrossRecreate', () => {
  it('nothing open and nothing carried stays null', () => {
    expect(carryOutageAcrossRecreate(null, null)).toBeNull()
  })

  it('an open state is carried with its start and stage', () => {
    expect(carryOutageAcrossRecreate({ downSince: T0, stage: 'gave_up' }, null)).toEqual({ downSince: T0, stage: 'gave_up' })
  })

  it('a second recreate keeps the earliest start', () => {
    const carried = { downSince: T0, stage: 'resume' as const }
    expect(carryOutageAcrossRecreate({ downSince: T0 + 500_000, stage: 'soft' }, carried)).toEqual({ downSince: T0, stage: 'soft' })
  })

  it('a recreate with no open state keeps what was already carried', () => {
    const carried = { downSince: T0, stage: 'hard' as const }
    expect(carryOutageAcrossRecreate(null, carried)).toBe(carried)
  })
})

describe('decideMarveenRecoveryReport', () => {
  it('nothing open -> no report', () => {
    expect(decideMarveenRecoveryReport(null, null, T0)).toBeNull()
  })

  it('regression: an outage carried across a recreate is reported with its full duration', () => {
    const r = decideMarveenRecoveryReport(null, { downSince: T0, stage: 'gave_up' }, T0 + 900_000)
    expect(r).toEqual({ downedForSec: 900, stage: 'recreated', notify: true })
  })

  it('a carried outage plus a fresh cascade state counts from the earliest start', () => {
    const r = decideMarveenRecoveryReport({ downSince: T0 + 600_000, stage: 'soft' }, { downSince: T0, stage: 'resume' }, T0 + 660_000)
    expect(r?.downedForSec).toBe(660)
    expect(r?.stage).toBe('recreated')
    expect(r?.notify).toBe(true)
  })

  it('a disruptive fresh stage after the recreate is named as such', () => {
    const r = decideMarveenRecoveryReport({ downSince: T0 + 600_000, stage: 'hard' }, { downSince: T0, stage: 'soft' }, T0 + 700_000)
    expect(r?.stage).toBe('hard')
  })

  it('without a recreate the existing rule holds: short soft blips stay quiet', () => {
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'soft' }, null, T0 + 60_000)?.notify).toBe(false)
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'save' }, null, T0 + 60_000)?.notify).toBe(false)
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'save' }, null, T0 + 180_000)?.notify).toBe(true)
    // A long blip is reported under its own stage, not as a recreate.
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'soft' }, null, T0 + 600_000))
      .toEqual({ downedForSec: 600, stage: 'soft', notify: true })
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'resume' }, null, T0 + 10_000)?.notify).toBe(true)
  })

  it('regression: a recreate-closed outage under 180s is still reported', () => {
    // A recreate needs only ~120s of confirmed suspicion, so this is reachable.
    expect(decideMarveenRecoveryReport(null, { downSince: T0, stage: 'soft' }, T0 + 30_000))
      .toEqual({ downedForSec: 30, stage: 'recreated', notify: true })
    expect(decideMarveenRecoveryReport({ downSince: T0 + 10_000, stage: 'soft' }, { downSince: T0, stage: 'soft' }, T0 + 40_000)?.notify).toBe(true)
  })

  it('handleMarveenUp sends exactly when the report says so', () => {
    const up = sliceFn('handleMarveenUp')
    expect(up).toMatch(/^  const report = decideMarveenRecoveryReport\(marveenDownState, marveenRecreatedOutage, Date\.now\(\)\)$/m)
    expect(up).toMatch(/^  if \(report\) \{$/m)
    expect(up).toMatch(/^    const downedFor = report\.downedForSec$/m)
    expect(up).toMatch(/^    const stage = report\.stage$/m)
    expect(up).toMatch(/\n    if \(report\.notify\) \{\n      sendAlert\(\n/)
    const block = sliceBlock(up, 'if (report.notify) {')
    expect(count(sliceBlock(sliceFn('handleMarveenUp', code), 'if (report.notify) {'), 'sendAlert(')).toBe(1)
    expect(count(sliceFn('handleMarveenUp', code), 'sendAlert(')).toBe(1)
    expect(block).toContain('${stage} szint')
    // Both states are cleared at the end of the report branch.
    expect(up).toMatch(/\n    \}\n    marveenDownState = null\n    marveenRecreatedOutage = null\n  \}$/)
  })

  it('the monitor loop carries the open state into the recreate and handleMarveenUp clears it', () => {
    expect(src).toMatch(new RegExp([
      '',
      " {12}if \\(shouldEscalateMarveenDown\\(\\) && createMainChannelsSession\\(\\) === 'started'\\) \\{",
      ' {14}monitorMainRespawnAt = Date\\.now\\(\\)',
      ' {14}marveenRecreatedOutage = carryOutageAcrossRecreate\\(marveenDownState, marveenRecreatedOutage\\)',
      ' {14}marveenDownState = null',
      ' {14}marveenSuspectFirstSeen = null',
      ' {12}\\}',
      '',
    ].join('\n')))
    // The definition and this one call.
    expect(count(code, 'carryOutageAcrossRecreate(')).toBe(2)
    expect(count(code, 'marveenRecreatedOutage = null')).toBe(1)
  })
})

describe('stage-4 hard restart message reflects the result', () => {
  it('success says the restart was started', () => {
    const t = hardRestartStageAlertText('launchctl', 'main-session', { ok: true })
    expect(t).toContain('elinditva')
    expect(t).toContain('main-session')
    expect(t).not.toContain('nem sikerult')
  })

  it('failure carries the error', () => {
    const t = hardRestartStageAlertText('systemctl', 'main-session', { ok: false, error: 'tmux respawn-pane failed' })
    expect(t).toContain('sem sikerult')
    expect(t).toContain('tmux respawn-pane failed')
  })

  it('failure without an error text still reads as a failure', () => {
    expect(hardRestartStageAlertText('systemctl', 's', { ok: false })).toContain('ismeretlen hiba')
  })

  it('the stage-4 branch sends one alert, after the call, using its result', () => {
    const stage = sliceBlock(sliceFn('handleMarveenDown'), "if (marveenDownState.stage === 'resume') {")
    expect(stage).toMatch(new RegExp([
      '',
      "    const svcName = process\\.platform === 'linux' \\? 'systemctl' : 'launchctl'",
      '    const r = hardRestartMarveenChannels\\(\\)',
      '    monitorMainRespawnAt = Date\\.now\\(\\)',
      "    if \\(!r\\.ok\\) logger\\.error\\(\\{ provider: providerLabel, err: r\\.error \\}, 'Stage-4 hard restart failed'\\)",
      '    sendAlert\\(hardRestartStageAlertText\\(svcName, MAIN_CHANNELS_SESSION, r\\)\\)',
      '    return',
      '  \\}$',
    ].join('\n')))
    // Same block in the literal-free view: literals are emptied there, so find
    // it as the same occurrence of the stage test.
    const down = sliceFn('handleMarveenDown')
    const downCode = sliceFn('handleMarveenDown', code)
    const nth = count(down.slice(0, down.indexOf("if (marveenDownState.stage === 'resume') {")), 'if (marveenDownState.stage === ')
    const at = downCode.split("if (marveenDownState.stage === '') {").slice(0, nth + 1).join("if (marveenDownState.stage === '') {").length
    const stageCode = sliceBlock(downCode.slice(at), "if (marveenDownState.stage === '') {")
    expect(count(stageCode, 'sendAlert(')).toBe(1)
    expect(count(stageCode, 'hardRestartMarveenChannels()')).toBe(1)
    expect(stage).not.toContain('Hard restart (${svcName}) most')
  })
})
