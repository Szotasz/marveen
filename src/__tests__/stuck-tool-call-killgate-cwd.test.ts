// KILLGATECWD1022: the STUCKFREEZE819 kill-boundary gate (and the STUCKATTEMPTS1018 written-since-the-freeze gate after it)
// read the main session's transcript from projectsDirFor(PROJECT_ROOT, ...). The session's transcript lives under its own
// working directory, and that is not always PROJECT_ROOT:
//   - channels.sh restarts the session in a mktemp dir (/tmp/marveen-channels-XXXXXX) when the first start fails with EPERM;
//   - an install can run the dashboard from a different directory (a release dir) than the one the session was started in.
// In both cases, the gate reads either nothing (null) or the stale transcript the session wrote before the move, so it
// can never abort a kill of a live session. The gate now also reads the session's real working directory (tmux pane_current_path).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as watcher from '../web/stuck-tool-call-watcher.js'
import { projectsDirFor } from '../web/active-model.js'

const { killGateTranscriptMtime, verdictStaleByTranscript, transcriptWrittenSinceStagnation } = watcher
// Looked up by name so that the suite loads (and the other cases run) on a tree without the new function: each case that
// needs it fails on its own instead of the whole file failing at import.
type ForSession = (projectRoot: string, paneCwd: string | null, roots?: ReadonlyArray<string | undefined>) => number | null
const forSession: ForSession = (...args) => {
  const fn = (watcher as Record<string, unknown>).killGateTranscriptMtimeForSession
  expect(typeof fn, 'killGateTranscriptMtimeForSession is exported').toBe('function')
  return (fn as ForSession)(...args)
}

const SRC = readFileSync(new URL('../web/stuck-tool-call-watcher.ts', import.meta.url), 'utf-8')
const FALLBACK_LINE = 'no transcript under the main session working directory'

let root: string
/** file mtimes round-trip through a float: compare within 2 ms */
const near = (a: number | null, b: number): void => { expect(a).not.toBeNull(); expect(Math.abs((a as number) - b)).toBeLessThan(2) }
const INSTALL_DIR = '/opt/marveen'                                    // PROJECT_ROOT of the dashboard
const EPERM_CWD = '/private/tmp/marveen-channels-Ab12Cd'              // the channels.sh EPERM fallback start dir (as tmux reports it)
const RELEASE_ROOT = '/srv/marveen-releases/b3ab73f'                   // PROJECT_ROOT when the dashboard runs from a release dir
const SESSION_CWD = '/srv/marveen'                                     // ... while the session keeps its own working directory

/** A transcript for `workingDir` under the config root, last written `ageMs` ago. Returns its mtime in ms. */
function transcript(workingDir: string, ageMs: number, name = 's.jsonl'): number {
  const dir = projectsDirFor(workingDir, root)
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, '{}\n')
  const t = (Date.now() - ageMs) / 1000
  utimesSync(f, t, t)
  return Math.round(t * 1000)
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'killgate-cwd-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('KILLGATECWD1022: the kill gate reads the main session\'s real working directory, not only PROJECT_ROOT', () => {
  it('EPERM fallback: the install dir holds only the stale pre-fallback transcript and the live one is under the mktemp cwd, so the gate sees it and aborts', () => {
    const stagnantSince = Date.now() - 5 * 60_000
    transcript(INSTALL_DIR, 2 * 24 * 3600_000, 'before-fallback.jsonl')      // written two days ago, before the EPERM restart
    transcript(EPERM_CWD, 8_000, 'live.jsonl')                                // the live session wrote 8 seconds ago
    // the old read: a stale mtime, so neither gate fires and the live session is killed
    const old = killGateTranscriptMtime(INSTALL_DIR, [root])
    expect(old).not.toBeNull()
    expect(verdictStaleByTranscript(old, Date.now())).toBe(false)
    expect(transcriptWrittenSinceStagnation(old, stagnantSince)).toBe(false)
    // the new read: fresh, so both gates hold the kill
    const m = forSession(INSTALL_DIR, EPERM_CWD, [root])
    expect(verdictStaleByTranscript(m, Date.now())).toBe(true)
    expect(transcriptWrittenSinceStagnation(m, stagnantSince)).toBe(true)
  })

  it('release layout: nothing under PROJECT_ROOT and the transcript sits under the session cwd, so the old read is blind (null) and the new one sees it', () => {
    transcript(SESSION_CWD, 8_000)
    expect(killGateTranscriptMtime(RELEASE_ROOT, [root])).toBeNull()
    const m = forSession(RELEASE_ROOT, SESSION_CWD, [root])
    expect(m).not.toBeNull()
    expect(verdictStaleByTranscript(m, Date.now())).toBe(true)
  })

  it('a stale transcript under the session cwd does not abort (a real wedge is still recovered)', () => {
    const stagnantSince = Date.now() - 5 * 60_000
    transcript(SESSION_CWD, 60 * 60_000)
    const m = forSession(RELEASE_ROOT, SESSION_CWD, [root])
    expect(m).not.toBeNull()
    expect(verdictStaleByTranscript(m, Date.now())).toBe(false)
    expect(transcriptWrittenSinceStagnation(m, stagnantSince)).toBe(false)
  })

  it('both directories have a transcript: the newest wins, in either direction', () => {
    const older = transcript(RELEASE_ROOT, 120_000, 'a.jsonl')
    const newer = transcript(SESSION_CWD, 5_000, 'b.jsonl')
    expect(newer).toBeGreaterThan(older)
    near(forSession(RELEASE_ROOT, SESSION_CWD, [root]), newer)
    const newest = transcript(RELEASE_ROOT, 1_000, 'c.jsonl')
    near(forSession(RELEASE_ROOT, SESSION_CWD, [root]), newest)
  })

  it('no pane cwd (tmux failed), an empty one, or the same directory: exactly the old read of PROJECT_ROOT', () => {
    const own = transcript(RELEASE_ROOT, 3_000)
    // an empty working dir would encode to '' and point the read at the projects/ root itself: a fresh file there must not count
    mkdirSync(join(root, 'projects'), { recursive: true })
    writeFileSync(join(root, 'projects', 'stray.jsonl'), '{}\n')
    for (const pane of [null, '', RELEASE_ROOT]) {
      expect(forSession(RELEASE_ROOT, pane, [root]), String(pane)).toBe(killGateTranscriptMtime(RELEASE_ROOT, [root]))
      near(forSession(RELEASE_ROOT, pane, [root]), own)
    }
  })

  it('neither directory has a transcript: null (fail-open, the stagnation signal stands on its own)', () => {
    expect(forSession(RELEASE_ROOT, SESSION_CWD, [root])).toBeNull()
    expect(forSession(RELEASE_ROOT, null, [root])).toBeNull()
  })

  it('the session cwd has no transcript but PROJECT_ROOT has: the PROJECT_ROOT read stands', () => {
    const own = transcript(RELEASE_ROOT, 3_000)
    near(forSession(RELEASE_ROOT, SESSION_CWD, [root]), own)
  })

  it('the pane cwd does not widen the read to other directories (a sibling project is not read)', () => {
    transcript('/srv/marveen-other', 1_000)
    transcript('/srv/marveen/agents/worker', 1_000)
    expect(forSession(RELEASE_ROOT, SESSION_CWD, [root])).toBeNull()
  })

  it('every candidate root is read for the session cwd too (STUCKROOT923 holds on the new path)', () => {
    const other = mkdtempSync(join(tmpdir(), 'killgate-cwd-other-'))
    try {
      const dir = projectsDirFor(SESSION_CWD, other)
      mkdirSync(dir, { recursive: true })
      const f = join(dir, 'live.jsonl'); writeFileSync(f, '{}\n')
      const m = forSession(RELEASE_ROOT, SESSION_CWD, [root, other])
      expect(verdictStaleByTranscript(m, Date.now())).toBe(true)
      expect(forSession(RELEASE_ROOT, SESSION_CWD, [root])).toBeNull()
    } finally { rmSync(other, { recursive: true, force: true }) }
  })

  it('STUCKROOT923 pin: both killGate functions default their roots to mainConfigRoots(), each on its own slice of the source', () => {
    const slice = (name: string): string => {
      const i = SRC.indexOf('export function ' + name + '(')
      expect(i, name).toBeGreaterThan(0)
      return SRC.slice(i, SRC.indexOf('\n}\n', i))
    }
    for (const name of ['killGateTranscriptMtime', 'killGateTranscriptMtimeForSession']) {
      const fn = slice(name)
      expect(fn, name).toContain('roots: ReadonlyArray<string | undefined> = mainConfigRoots(),')
      expect(fn, name).not.toMatch(/mainConfigRoots\(\)\[0\]/)
    }
  })

  it('one info line when the session cwd has no transcript but PROJECT_ROOT has (layout fallback), with no path in it', async () => {
    vi.resetModules()
    const { logger } = await import('../logger.js')
    const spy = vi.spyOn(logger, 'info')
    try {
      const w = await import('../web/stuck-tool-call-watcher.js') as Record<string, unknown>
      const fn = w.killGateTranscriptMtimeForSession as ForSession
      expect(typeof fn).toBe('function')
      const notice = () => spy.mock.calls.filter(c => String(c[1] ?? '').includes(FALLBACK_LINE))
      fn(RELEASE_ROOT, SESSION_CWD, [root])                        // both missing: nothing to say
      expect(notice()).toHaveLength(0)
      transcript(RELEASE_ROOT, 3_000)
      fn(RELEASE_ROOT, SESSION_CWD, [root])
      fn(RELEASE_ROOT, SESSION_CWD, [root])
      expect(notice()).toHaveLength(1)                             // once per process, however often the gate runs
      expect(JSON.stringify(notice()[0])).not.toContain(SESSION_CWD)
      expect(JSON.stringify(notice()[0])).not.toContain(RELEASE_ROOT)
      expect(notice()[0][0]).toEqual({ paneCwdDiffersFromProjectRoot: true, paneCwdLength: SESSION_CWD.length })
    } finally {
      spy.mockRestore()
    }
  })

  it('no fallback line when the session cwd has its own transcript, or when there is no pane cwd', async () => {
    vi.resetModules()
    const { logger } = await import('../logger.js')
    const spy = vi.spyOn(logger, 'info')
    try {
      const w = await import('../web/stuck-tool-call-watcher.js') as Record<string, unknown>
      const fn = w.killGateTranscriptMtimeForSession as ForSession
      expect(typeof fn).toBe('function')
      transcript(RELEASE_ROOT, 3_000)
      transcript(SESSION_CWD, 3_000)
      fn(RELEASE_ROOT, SESSION_CWD, [root])
      fn(RELEASE_ROOT, null, [root])
      expect(spy.mock.calls.filter(c => String(c[1] ?? '').includes(FALLBACK_LINE))).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('wiring: checkSession reads the transcript once, through the session-aware read, and both abort gates use that value before the kill', () => {
    const start = SRC.indexOf('async function checkSession')
    const code = SRC.slice(start, SRC.indexOf('\n}', start)).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const read = 'const transcriptMtime = killGateTranscriptMtimeForSession(PROJECT_ROOT, mainPaneCwd(session))'
    expect(code).toContain(read)
    expect(code).not.toContain('killGateTranscriptMtime()')
    const readIdx = code.indexOf(read)
    const staleIdx = code.indexOf('verdictStaleByTranscript(transcriptMtime, Date.now())')
    const sinceIdx = code.indexOf('transcriptWrittenSinceStagnation(transcriptMtime, next.stagnantSince)')
    const killIdx = code.indexOf('await resumeMarveenSession()')
    expect(staleIdx).toBeGreaterThan(readIdx)
    expect(sinceIdx).toBeGreaterThan(readIdx)
    expect(killIdx).toBeGreaterThan(staleIdx)
    expect(killIdx).toBeGreaterThan(sinceIdx)
  })

  it('the pane cwd comes from tmux pane_current_path of the exact session target, fail-open to null', () => {
    const i = SRC.indexOf('function mainPaneCwd(session: string): string | null')
    expect(i).toBeGreaterThan(0)
    const fn = SRC.slice(i, SRC.indexOf('\n}\n', i))
    expect(fn).toContain("'-F', '#{pane_current_path}'")
    expect(fn).toContain("'list-panes', '-s', '-t'")                 // every window of the session, not only the current one
    expect(fn).toContain('exactTmuxTarget(session)')
    expect(fn).toMatch(/catch[\s\S]*return null/)
  })
})
