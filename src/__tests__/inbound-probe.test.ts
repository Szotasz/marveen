import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { shouldTriggerDeafnessRespawn, readLastIngestionTimestamp, readLastIngestionTimestampAcross, mainTranscriptDirs, mainConfigRoots, TRANSCRIPT_DIR } from '../web/inbound-probe.js'
import { projectsDirFor } from '../web/active-model.js'
import { PROJECT_ROOT } from '../config.js'

// ---------------------------------------------------------------------------
// AC coverage map (channel-watchdog-prompt.md D3 + wolf-swarm-trial.md #3)
//
//   AC-D3-1: shouldTriggerDeafnessRespawn — exact probeTimeoutMs boundary
//   AC-D3-2: readLastIngestionTimestamp — large file (>256KB) tail-read finds
//            a <channel source= line near the END of the file
//   AC-D3-3: readLastIngestionTimestamp — large file (>256KB) tail-read MISSES
//            a <channel source= line that lives ONLY in the first 10KB
//            (documents the known limitation of the 256KB tail window)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// shouldTriggerDeafnessRespawn
// ---------------------------------------------------------------------------
describe('shouldTriggerDeafnessRespawn', () => {
  const NOW = 1_000_000
  const TIMEOUT = 60_000
  const MARKER = NOW - TIMEOUT // exactly at boundary

  it('returns false when timeout has not elapsed yet', () => {
    expect(shouldTriggerDeafnessRespawn({
      markerTs: NOW - TIMEOUT + 1,
      lastIngestionTs: null,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(false)
  })

  // AC-D3-1: exact boundary — at nowMs - markerTs === probeTimeoutMs the timeout
  // IS considered elapsed (the condition is `< probeTimeoutMs`, not `<=`). This
  // pins the off-by-one: 1 ms before the boundary → false; at boundary → true.
  it('returns true at EXACTLY the probeTimeoutMs boundary with no ingestion', () => {
    // nowMs - markerTs === TIMEOUT: the < guard is not triggered
    expect(shouldTriggerDeafnessRespawn({
      markerTs: MARKER,  // MARKER = NOW - TIMEOUT, so nowMs - markerTs = TIMEOUT exactly
      lastIngestionTs: null,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(true)
  })

  it('returns false 1ms BEFORE the probeTimeoutMs boundary', () => {
    // nowMs - markerTs = TIMEOUT - 1: the < guard IS triggered
    expect(shouldTriggerDeafnessRespawn({
      markerTs: NOW - TIMEOUT + 1,
      lastIngestionTs: null,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(false)
  })

  it('returns true when timeout elapsed and no ingestion ever', () => {
    expect(shouldTriggerDeafnessRespawn({
      markerTs: MARKER,
      lastIngestionTs: null,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(true)
  })

  it('returns true when timeout elapsed and last ingestion predates the marker', () => {
    expect(shouldTriggerDeafnessRespawn({
      markerTs: MARKER,
      lastIngestionTs: MARKER - 1,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(true)
  })

  it('returns false when timeout elapsed but ingestion is AFTER the marker (healthy)', () => {
    expect(shouldTriggerDeafnessRespawn({
      markerTs: MARKER,
      lastIngestionTs: MARKER + 1,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(false)
  })

  it('returns false when timeout elapsed and ingestion equals the marker timestamp', () => {
    // Equal means the ping itself was the ingestion — treat as healthy.
    expect(shouldTriggerDeafnessRespawn({
      markerTs: MARKER,
      lastIngestionTs: MARKER,
      probeTimeoutMs: TIMEOUT,
      nowMs: NOW,
    })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readLastIngestionTimestamp
// ---------------------------------------------------------------------------
describe('readLastIngestionTimestamp', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tmpDirs.length = 0
  })

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'inbound-probe-test-'))
    tmpDirs.push(d)
    return d
  }

  it('returns null for an empty directory (no JSONL files)', () => {
    const dir = makeTmpDir()
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })

  it('returns null when no lines contain <channel source=', () => {
    const dir = makeTmpDir()
    const lines = [
      JSON.stringify({ timestamp: '2026-06-01T10:00:00.000Z', content: 'some message' }),
      JSON.stringify({ timestamp: '2026-06-01T10:01:00.000Z', content: 'another message' }),
    ].join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })

  it('returns the timestamp of the last <channel source= line', () => {
    const dir = makeTmpDir()
    const ts1 = '2026-06-01T10:00:00.000Z'
    const ts2 = '2026-06-01T10:05:00.000Z'
    const lines = [
      JSON.stringify({ timestamp: ts1, content: '<channel source=telegram> hello' }),
      JSON.stringify({ timestamp: '2026-06-01T10:03:00.000Z', content: 'no channel here' }),
      JSON.stringify({ timestamp: ts2, content: '<channel source=telegram> world' }),
    ].join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts2).getTime())
  })

  it('skips malformed JSON lines without aborting', () => {
    const dir = makeTmpDir()
    const ts = '2026-06-01T11:00:00.000Z'
    const lines = [
      'this is not json <channel source=telegram>',
      JSON.stringify({ timestamp: ts, content: '<channel source=telegram> ok' }),
    ].join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts).getTime())
  })

  it('returns null when the directory does not exist', () => {
    expect(readLastIngestionTimestamp('/tmp/nonexistent-inbound-probe-dir-' + Date.now())).toBe(null)
  })

  // AC-D3-2: tail-read finds a <channel source= line near the END of a >256KB file.
  //
  // The implementation reads only the last 256 KB (TAIL_BYTES = 262144) to avoid
  // blocking on large transcripts. A channel ingestion line near the end of a
  // large file MUST be found.
  //
  // Construction:
  //   - Write >256 KB of filler lines (no <channel source=) before the target line.
  //   - Append the known <channel source= line with a known timestamp at the very end.
  //   - The function must return that timestamp.
  it('tail-read: finds <channel source= line near the END of a >256KB file (AC-D3-2)', () => {
    const dir = makeTmpDir()
    const knownTs = '2026-06-01T15:00:00.000Z'
    // Build filler: each line is a JSON object without <channel source= (~100 bytes each).
    // 262144 / 100 = ~2621 lines. Use 3000 lines to ensure we exceed 256 KB.
    const fillerLine = JSON.stringify({ timestamp: '2026-06-01T09:00:00.000Z', content: 'x'.repeat(80) })
    const filler = Array.from({ length: 3000 }, () => fillerLine).join('\n')
    const targetLine = JSON.stringify({ timestamp: knownTs, content: '<channel source=telegram> tail-test' })
    writeFileSync(join(dir, 'session.jsonl'), filler + '\n' + targetLine, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(knownTs).getTime())
  })

  // AC-D3-3: tail-read MISSES a <channel source= line that exists ONLY in the
  // first 10 KB of a >256 KB file.
  //
  // The 256 KB tail window is a deliberate trade-off (avoid blocking I/O on
  // large transcripts). When the only matching line is far before the tail
  // window, the function returns null — this is the documented limitation.
  // The test locks the behavior so any future change to the tail strategy is
  // intentional and visible in the diff.
  it('tail-read: returns null when the only <channel source= line is in the first 10KB of a >256KB file (AC-D3-3, known limitation)', () => {
    const dir = makeTmpDir()
    // Put the target line first (within the first 10 KB).
    const earlyTs = '2026-06-01T08:00:00.000Z'
    const earlyLine = JSON.stringify({ timestamp: earlyTs, content: '<channel source=telegram> early-line' })
    // Filler: >256 KB of lines without <channel source= to push the target line
    // far beyond the 256 KB tail window. Each filler line is ~100 bytes.
    // 262144 / 100 = ~2621 lines minimum; use 3000.
    const fillerLine = JSON.stringify({ timestamp: '2026-06-01T09:00:00.000Z', content: 'y'.repeat(80) })
    const filler = Array.from({ length: 3000 }, () => fillerLine).join('\n')
    writeFileSync(join(dir, 'session.jsonl'), earlyLine + '\n' + filler, 'utf-8')
    // The tail window starts at the last 256 KB — the earlyLine is NOT in it.
    // The function must return null (the line is beyond the tail window).
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// CONFIG-DIR BLIND SPOT regression (2026-09-11)
//
// The main channels agent can run with an isolated CLAUDE_CONFIG_DIR
// (MAIN_AGENT_ISOLATED_CONFIG=1 -> <PROJECT_ROOT>/.channels-config), which puts
// its transcript under THAT root instead of the shared ~/.claude. Reading only
// the shared root reported "no inbound ever" while the owner was actively
// chatting: the keepalive file was never warmed from live traffic, aged past the
// 18-minute staleness threshold, and the watchdog respawn-paned the running
// conversation away (twice in 30 minutes, "124 perce nem frissult").
//
//   AC-CFG-1: mainTranscriptDirs() offers BOTH the shared and the isolated root
//   AC-CFG-2: readLastIngestionTimestampAcross() takes the NEWEST across roots,
//             so the isolated root wins when the shared one is stale
//   AC-CFG-3: a non-existent candidate root is ignored, not fatal
// ---------------------------------------------------------------------------
describe('transcript roots across config dirs', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tmpDirs.length = 0
  })

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'inbound-probe-roots-'))
    tmpDirs.push(d)
    return d
  }

  function writeIngestion(dir: string, ts: string): void {
    writeFileSync(
      join(dir, 'session.jsonl'),
      JSON.stringify({ timestamp: ts, content: '<channel source=telegram> hello' }),
      'utf-8',
    )
  }

  // AC-CFG-1
  it('mainTranscriptDirs offers both the shared and the isolated config root', () => {
    const dirs = mainTranscriptDirs()
    expect(dirs.length).toBeGreaterThanOrEqual(2)
    expect(dirs.some(d => d.includes(join('.claude', 'projects')))).toBe(true)
    expect(dirs.some(d => d.includes(join('.channels-config', 'projects')))).toBe(true)
    // no duplicates — the candidates are de-duplicated
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  // AC-CFG-2: this is the actual bug. The shared root holds an old transcript
  // (from before isolation was turned on) and the isolated root holds the live
  // one. Reading the shared root alone returns the STALE timestamp and the
  // keepalive never gets warmed.
  it('takes the newest ingestion across roots when the live one is isolated', () => {
    const shared = makeTmpDir()
    const isolated = makeTmpDir()
    const stale = '2026-09-11T18:36:00.000Z'
    const live = '2026-09-11T20:41:00.000Z'
    writeIngestion(shared, stale)
    writeIngestion(isolated, live)

    expect(readLastIngestionTimestamp(shared)).toBe(new Date(stale).getTime())
    expect(readLastIngestionTimestampAcross([shared, isolated])).toBe(new Date(live).getTime())
  })

  it('never moves backward: an older isolated root does not beat a live shared one', () => {
    const shared = makeTmpDir()
    const isolated = makeTmpDir()
    const live = '2026-09-11T20:41:00.000Z'
    writeIngestion(shared, live)
    writeIngestion(isolated, '2026-09-11T18:36:00.000Z')
    expect(readLastIngestionTimestampAcross([shared, isolated])).toBe(new Date(live).getTime())
  })

  // AC-CFG-3
  it('ignores candidate roots that do not exist', () => {
    const real = makeTmpDir()
    const ts = '2026-09-11T20:41:00.000Z'
    writeIngestion(real, ts)
    const missing = '/tmp/nonexistent-inbound-probe-root-' + Date.now()
    expect(readLastIngestionTimestampAcross([missing, real])).toBe(new Date(ts).getTime())
  })

  it('returns null when no candidate root has an ingestion', () => {
    expect(readLastIngestionTimestampAcross([makeTmpDir(), makeTmpDir()])).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// PROJECT-DIR ENCODING regression (866da985, 2026-09-20)
//
// Claude Code encodes a project working-dir by replacing EVERY character
// that is not alphanumeric with '-' (see projectsDirFor in active-model.ts,
// already relied on by schedule-runner and the context-guard/restart-gate
// watchdogs) -- not just '/'. TRANSCRIPT_DIR and mainTranscriptDirs() used to
// hand-roll their own PROJECT_ROOT.replace(/\//g, '-'), which only strips
// slashes. On any host whose PROJECT_ROOT contains another separator
// character that Claude Code also encodes (e.g. a dot in the username, as in
// /Users/a.kobza/marveen), the two encoders disagree: the hand-rolled one
// computes a directory Claude Code never creates, so
// readLastIngestionTimestampAcross() always returns null -- real inbound
// traffic never refreshes the keepalive file, and the channel-monitor
// watchdog respawns the session on a ~15 minute metronome forever (measured
// live: 63 respawns in one day, see kanban 866da985).
//
//   AC-ENC-1: TRANSCRIPT_DIR must match projectsDirFor's encoding exactly
//   AC-ENC-2: every mainTranscriptDirs() candidate must match projectsDirFor
//             for its corresponding config root
// ---------------------------------------------------------------------------
describe('project-dir encoding matches Claude Code (866da985)', () => {
  // AC-ENC-1
  it('TRANSCRIPT_DIR encodes PROJECT_ROOT the same way projectsDirFor does', () => {
    const expected = projectsDirFor(PROJECT_ROOT, join(process.env.HOME ?? homedir(), '.claude'))
    expect(TRANSCRIPT_DIR).toBe(expected)
  })

  // AC-ENC-2
  it('every mainTranscriptDirs() candidate matches projectsDirFor for its config root', () => {
    const dirs = mainTranscriptDirs()
    const roots = mainConfigRoots()
    for (const root of roots) {
      expect(dirs).toContain(projectsDirFor(PROJECT_ROOT, root))
    }
  })
})
