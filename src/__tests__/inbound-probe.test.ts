import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { backscanStart, shouldTriggerDeafnessRespawn, nextPendingProbe, inboundRecordText, scanIngestion, scanIngestionAcross, countTranscriptWritersSince, decideProbeTick, deafnessRespawnHold, recordDeafnessRespawn, INITIAL_PROBE_TICK_STATE, type ProbeTickState, PROBE_PING_PREFIX, isProbePing, runInboundProbeTick, defaultProbeTickDeps, type ProbeLoopState, type ProbeTickDeps, readLastIngestionTimestamp, readLastIngestionTimestampAcross, mainTranscriptDirs, mainConfigRoots, TRANSCRIPT_DIR } from '../web/inbound-probe.js'
import { projectsDirFor } from '../web/active-model.js'
import { PROJECT_ROOT } from '../config.js'
import type { PaneState } from '../pane-state.js'
import { CHANNEL_INBOUND_PREAMBLE, wrapChannelInbound } from '../prompt-safety.js'
import { buildHandoffContent } from '../channel-coordinator.js'

// A channel message body as the plugin writes it into the transcript: on its
// own line between the opening and closing tag. Transcript fixtures use this
// native shape so that a check run on the raw JSON line (where the newlines
// are escaped) instead of the extracted text cannot pass.
const nativeBody = (body: string): string => `\n${body}\n`
const nativePing = (iso: string): string => nativeBody(`${PROBE_PING_PREFIX} ${iso}`)

// Fixture vocabulary, one name per meaning:
//   OPEN_TAG           the bare opening tag of a plugin channel block
//   channelBlock(body) a complete block around body
//   pingBlock(iso)     a complete block carrying a probe ping, native shape
//   HI_BLOCK           a complete owner block ("hi"), compact shape
const OPEN_TAG = '<channel source="plugin:telegram:telegram" chat_id="1">'
const channelBlock = (body: string): string => `${OPEN_TAG}${body}</channel>`
const pingBlock = (iso: string): string => channelBlock(nativePing(iso))
const HI_BLOCK = channelBlock(' hi')

// A channel message delivered by the channel coordinator's backfill: the
// CHANNEL_INBOUND_PREAMBLE (which quotes its own example block) and then the
// block built by buildHandoffContent, exactly as the hub receives it.
const handoffBlock = (content: string): string => buildHandoffContent({
  kind: 'message', chat_id: 1, user_id: 2, username: 'u', message_id: 5, content, tg_date: Date.parse('2026-10-01T10:00:00.000Z') / 1000,
})
const backfilled = (blockText: string): string => `${CHANNEL_INBOUND_PREAMBLE}\n${wrapChannelInbound(blockText)}`

// The transcript record shapes inbound text arrives in (see inboundRecordText).
const REC = {
  userString: (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: text } }),
  userParts: (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text }] } }),
  userPartsWithImage: (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'image', source: {} }, { type: 'text', text }] } }),
  // Several text parts: the channel text first, then a plain note; or after one.
  userPartsTextFirst: (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text }, { type: 'text', text: 'note' }] } }),
  userPartsTextSecond: (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: 'note' }, { type: 'text', text }] } }),
  enqueue: (ts: string, text: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: text }),
  queuedCommand: (ts: string, text: string) => ({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: text, origin: { kind: 'channel' } } }),
}

// Bookkeeping records Claude Code appends to a transcript without a
// top-level timestamp (see GATEMTIME922 in src/web/active-model.ts). Large
// fixtures interleave them, so the first whole line after a read offset is
// often one of these and must be skipped, not taken as "no time here".
const BOOKKEEPING_LINES = [
  JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false }),
  JSON.stringify({ type: 'custom-title', customTitle: 'hub', sessionId: 's' }),
  JSON.stringify({ type: 'mode', mode: 'default', sessionId: 's' }),
]

const I = 180_000 // probe interval
const GRACE = 15 * 60 * 1000

// Temp dirs made by any test, removed after each test.
const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})
function tmpDir(prefix = 'inbound-probe-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

// Shared module-level state is reset before EVERY test, so no test depends on
// the order the runner picks: spies and the probe's own module-level tick
// state (defaultProbeTickDeps store).
beforeEach(() => {
  vi.restoreAllMocks()
  defaultProbeTickDeps.saveState({ tick: INITIAL_PROBE_TICK_STATE, lastInboundRespawn: 0, warnedAmbiguous: false })
})

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

// A transcript record as Claude Code writes an inbound prompt on an idle
// session: a `user` record whose message content is the prompt string.
function userRec(timestamp: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } })
}

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
      userRec(ts1, '<channel source=telegram> hello'),
      JSON.stringify({ timestamp: '2026-06-01T10:03:00.000Z', content: 'no channel here' }),
      userRec(ts2, '<channel source=telegram> world'),
    ].join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts2).getTime())
  })

  it('skips malformed JSON lines without aborting', () => {
    const dir = makeTmpDir()
    const ts = '2026-06-01T11:00:00.000Z'
    const lines = [
      'this is not json <channel source=telegram>',
      userRec(ts, '<channel source=telegram> ok'),
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
    const targetLine = userRec(knownTs, '<channel source=telegram> tail-test')
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
    const earlyLine = userRec(earlyTs, '<channel source=telegram> early-line')
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
      userRec(ts, '<channel source=telegram> hello'),
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

// ---------------------------------------------------------------------------
// Deafness clock from the OLDEST unanswered probe
//
// The prober rewrites its last-sent marker after EVERY successful send, one
// send per interval. Passing that latest marker straight to
// shouldTriggerDeafnessRespawn meant nowMs - markerTs never exceeded about one
// interval while the threshold is two, so a deaf hub was never detected while
// the prober was alive. nextPendingProbe keeps the first unanswered send.
// ---------------------------------------------------------------------------
describe('nextPendingProbe', () => {
  const T0 = 10_000_000
  const TIMEOUT = 2 * I

  it('starts the clock at the first unanswered marker', () => {
    expect(nextPendingProbe(null, T0, null)).toBe(T0)
    expect(nextPendingProbe(null, T0, T0 - 1)).toBe(T0)
  })

  it('returns null when the latest marker is answered', () => {
    expect(nextPendingProbe(null, T0, T0 + 500)).toBe(null)
  })

  it('treats an ingestion at exactly the send time as an answer', () => {
    expect(nextPendingProbe(null, T0, T0)).toBe(null)
    expect(nextPendingProbe(T0, T0 + I, T0)).toBe(T0 + I)
  })

  it('keeps the oldest pending probe while later probes go unanswered', () => {
    let pending = nextPendingProbe(null, T0, null)
    pending = nextPendingProbe(pending, T0 + I, null)
    pending = nextPendingProbe(pending, T0 + 2 * I, T0 - 5_000)
    expect(pending).toBe(T0)
  })

  it('moves to the latest marker once the pending probe is answered but the latest is not', () => {
    expect(nextPendingProbe(T0, T0 + 2 * I, T0 + 1_000)).toBe(T0 + 2 * I)
  })

  it('clears the pending probe once the latest marker is answered too', () => {
    expect(nextPendingProbe(T0, T0 + 2 * I, T0 + 2 * I + 900)).toBe(null)
  })

  it('keeps the pending probe when the marker reads older than it (clock step)', () => {
    expect(nextPendingProbe(T0 + I, T0, null)).toBe(T0 + I)
  })

  // Regression: two consecutive sends, no ingestion. The dashboard ticks once
  // per interval and reads only the latest marker.
  it('two unanswered sends: respawn fires 2 intervals after the FIRST send', () => {
    const lastIngestionTs = T0 - 60_000 // last inbound before the first probe
    // tick 1 (just after send #1)
    let pending = nextPendingProbe(null, T0, lastIngestionTs)
    expect(shouldTriggerDeafnessRespawn({ markerTs: pending as number, lastIngestionTs, probeTimeoutMs: TIMEOUT, nowMs: T0 + 1_000 })).toBe(false)
    // tick 2 (send #2 rewrote the marker)
    pending = nextPendingProbe(pending, T0 + I, lastIngestionTs)
    expect(shouldTriggerDeafnessRespawn({ markerTs: pending as number, lastIngestionTs, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })).toBe(false)
    // tick 3 (send #3 rewrote the marker again), 2 intervals after send #1
    const now = T0 + 2 * I + 1_000
    pending = nextPendingProbe(pending, T0 + 2 * I, lastIngestionTs)
    expect(pending).toBe(T0)
    expect(shouldTriggerDeafnessRespawn({ markerTs: pending as number, lastIngestionTs, probeTimeoutMs: TIMEOUT, nowMs: now })).toBe(true)
    // The unfixed wiring passed the latest marker and never fired:
    expect(shouldTriggerDeafnessRespawn({ markerTs: T0 + 2 * I, lastIngestionTs, probeTimeoutMs: TIMEOUT, nowMs: now })).toBe(false)
  })

  it('a healthy hub that answers every probe never accumulates a pending probe', () => {
    let pending: number | null = null
    for (let k = 0; k < 10; k++) {
      const marker = T0 + k * I
      pending = nextPendingProbe(pending, marker, marker + 2_000)
      expect(pending).toBe(null)
    }
  })

  it('a probe sent just before the tick and not yet ingested does not trigger', () => {
    // send #2 happened 1 s before the tick, its ingestion is not in yet
    const pending = nextPendingProbe(null, T0 + I, T0 + 2_000)
    expect(pending).toBe(T0 + I)
    expect(shouldTriggerDeafnessRespawn({ markerTs: pending as number, lastIngestionTs: T0 + 2_000, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Whole-file read keeps the first line
//
// The "possibly partial first line" was dropped on EVERY read, including a
// read from offset 0 (any transcript under 256 KB). In a fresh session file
// the first record can be the probe itself.
// ---------------------------------------------------------------------------
describe('readLastIngestionTimestamp: first line of a small file', () => {

  // 256 KB = 262 144 bytes, literal: the claim is that a transcript under the
  // tail window is read whole, so its first record counts.
  it('a file of exactly 256 KB is read whole; one byte more drops the cut first line', () => {
    const ts = '2026-10-01T10:00:00.000Z'
    const first = userRec(ts, '<channel source="plugin:telegram:telegram"> hi</channel>') + '\n'
    const build = (size: number): string => {
      const filler = JSON.stringify({ type: 'assistant', pad: '' })
      let body = first
      const line = (n: number) => filler.replace('"pad":""', `"pad":"${'x'.repeat(n)}"`) + '\n'
      while (size - body.length > 2000) body += line(1000)
      body += line(size - body.length - line(0).length)
      expect(Buffer.byteLength(body)).toBe(size)
      return body
    }
    const whole = tmpDir()
    writeFileSync(join(whole, 's.jsonl'), build(262_144), 'utf-8')
    expect(readLastIngestionTimestamp(whole)).toBe(new Date(ts).getTime())
    const over = tmpDir()
    writeFileSync(join(over, 's.jsonl'), build(262_145), 'utf-8')
    expect(readLastIngestionTimestamp(over)).toBe(null)
  })

  it('one-line file with a trailing newline: the only record counts', () => {
    const dir = tmpDir()
    const ts = '2026-10-01T10:00:00.000Z'
    writeFileSync(join(dir, 's.jsonl'), userRec(ts, '<channel source="plugin:telegram:telegram"> hi</channel>') + '\n', 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts).getTime())
  })

  it('one-line file without a trailing newline: the only record counts', () => {
    const dir = tmpDir()
    const ts = '2026-10-01T10:00:00.000Z'
    writeFileSync(join(dir, 's.jsonl'), userRec(ts, '<channel source="plugin:telegram:telegram"> hi</channel>'), 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts).getTime())
  })

  it('two-line file: an ingestion on the first line is found', () => {
    const dir = tmpDir()
    const ts = '2026-10-01T10:00:00.000Z'
    const lines = [
      userRec(ts, '<channel source="plugin:telegram:telegram"> hi</channel>'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts).getTime())
  })

  it('a mid-file read still drops the partial first line', () => {
    const dir = tmpDir()
    // One giant inbound record whose START falls outside the 256 KB tail: the
    // tail begins mid-record, so that fragment must not be parsed as a line.
    // The record after it is complete and is the expected answer.
    const giantTs = '2026-10-01T09:00:00.000Z'
    const giant = userRec(giantTs, '<channel source="plugin:telegram:telegram"> ' + 'z'.repeat(300_000) + '</channel>')
    const ts = '2026-10-01T10:00:00.000Z'
    writeFileSync(join(dir, 's.jsonl'), giant + '\n' + userRec(ts, '<channel source="plugin:telegram:telegram"> hi</channel>') + '\n', 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(ts).getTime())
  })
})

// ---------------------------------------------------------------------------
// Only genuine inbound records count as ingestion
//
// Any line containing `<channel source=` used to count, so assistant text or a
// tool result that merely quotes the tag (reading a transcript, grepping code)
// looked like fresh inbound and could mask deafness.
// ---------------------------------------------------------------------------
describe('inboundRecordText', () => {

  it('accepts a user record with string content', () => {
    expect(inboundRecordText({ type: 'user', message: { content: HI_BLOCK } })).toBe(HI_BLOCK)
  })

  it('accepts a user record with text parts', () => {
    expect(inboundRecordText({ type: 'user', message: { content: [{ type: 'text', text: HI_BLOCK }] } })).toBe(HI_BLOCK)
  })

  it('accepts a mid-turn queued_command attachment', () => {
    expect(inboundRecordText({ type: 'attachment', attachment: { type: 'queued_command', prompt: HI_BLOCK, origin: { kind: 'channel' } } })).toBe(HI_BLOCK)
  })

  it('rejects a user record that carries a tool_result', () => {
    expect(inboundRecordText({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: HI_BLOCK }] } })).toBe(null)
  })

  it('rejects assistant text that quotes the tag', () => {
    expect(inboundRecordText({ type: 'assistant', message: { content: [{ type: 'text', text: HI_BLOCK }] } })).toBe(null)
  })

  it('accepts a queue-operation enqueue (received during a long tool call)', () => {
    expect(inboundRecordText({ type: 'queue-operation', operation: 'enqueue', content: HI_BLOCK })).toBe(HI_BLOCK)
  })

  it('rejects a user record mixing a tool_result part with a text part that carries the tag', () => {
    expect(inboundRecordText({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }, { type: 'text', text: HI_BLOCK }] } })).toBe(null)
  })

  it('rejects other record and attachment types', () => {
    expect(inboundRecordText({ type: 'queue-operation', operation: 'remove', content: HI_BLOCK })).toBe(null)
    expect(inboundRecordText({ type: 'queue-operation', operation: 'dequeue', content: HI_BLOCK })).toBe(null)
    expect(inboundRecordText({ type: 'attachment', attachment: { type: 'mcp_instructions_delta', prompt: HI_BLOCK } })).toBe(null)
    expect(inboundRecordText({ timestamp: 'x', content: HI_BLOCK })).toBe(null)
    expect(inboundRecordText(null)).toBe(null)
    expect(inboundRecordText('<channel source=')).toBe(null)
  })
})

describe('readLastIngestionTimestamp: echoes are not ingestion', () => {
  const realTs = '2026-10-01T10:00:00.000Z'

  it('assistant text and a tool_result quoting the tag after a real inbound do not advance it', () => {
    const dir = tmpDir()
    const lines = [
      userRec(realTs, HI_BLOCK),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'quoted: ' + HI_BLOCK }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:06:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'grep hit: ' + HI_BLOCK }] } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(realTs).getTime())
  })

  it('a transcript with only echoes has no ingestion', () => {
    const dir = tmpDir()
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: realTs, message: { role: 'assistant', content: [{ type: 'text', text: HI_BLOCK }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: realTs, content: HI_BLOCK }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(null)
  })

  it('a mid-turn queued_command is ingestion', () => {
    const dir = tmpDir()
    const qTs = '2026-10-01T10:07:00.000Z'
    const lines = [
      userRec(realTs, HI_BLOCK),
      JSON.stringify({ type: 'attachment', timestamp: qTs, attachment: { type: 'queued_command', prompt: HI_BLOCK, origin: { kind: 'channel' } } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(readLastIngestionTimestamp(dir)).toBe(new Date(qTs).getTime())
  })

  it('scanIngestion reports the newest probe ping separately', () => {
    const dir = tmpDir()
    const probeTs = '2026-10-01T10:01:00.000Z'
    const ownerTs = '2026-10-01T10:02:00.000Z'
    const lines = [
      userRec(probeTs, `<channel source="plugin:telegram:telegram" chat_id="1">${nativePing('2026-10-01T10:00:59.000Z')}</channel>`),
      userRec(ownerTs, HI_BLOCK),
      // an assistant echo of a ping is not a heard probe
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:03:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `<channel source="x">${PROBE_PING_PREFIX}` }] } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(scanIngestion(dir)).toEqual({ lastTs: new Date(ownerTs).getTime(), lastProbeTs: new Date(probeTs).getTime() })
  })

  it('scanIngestionAcross takes the newest of each field across roots', () => {
    const a = tmpDir()
    const b = tmpDir()
    writeFileSync(join(a, 's.jsonl'), userRec('2026-10-01T10:01:00.000Z', `<channel source="t">${nativePing('2026-10-01T10:00:59.500Z')}</channel>`) + '\n', 'utf-8')
    writeFileSync(join(b, 's.jsonl'), userRec('2026-10-01T10:05:00.000Z', HI_BLOCK) + '\n', 'utf-8')
    expect(scanIngestionAcross([a, b])).toEqual({
      lastTs: new Date('2026-10-01T10:05:00.000Z').getTime(),
      lastProbeTs: new Date('2026-10-01T10:01:00.000Z').getTime(),
    })
    expect(scanIngestion('/tmp/nonexistent-inbound-probe-scan-' + Date.now())).toEqual({ lastTs: null, lastProbeTs: null })
  })
})

// ---------------------------------------------------------------------------
// A busy hub inside one long tool call is not deaf
//
// A message that arrives during a single long tool call leaves only a
// queue-operation enqueue line until the call ends; the queued_command line
// is written only at the next tool boundary, which can be minutes later. Not
// counting the enqueue made a busy hub in a long command read as deaf.
// ---------------------------------------------------------------------------
describe('enqueue answers a pending probe', () => {

  it('an enqueue-only tail with no consumption line is ingestion and clears the probe', () => {
    const dir = tmpDir('inbound-probe-enq-')
    const sentAt = '2026-10-01T10:00:00.000Z'
    const enqAt = '2026-10-01T10:00:01.000Z'
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T09:59:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: enqAt, sessionId: 's', content: `<channel source="plugin:telegram:telegram" chat_id="1">${nativePing(sentAt)}</channel>` }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    const scan = scanIngestion(dir)
    expect(scan.lastTs).toBe(new Date(enqAt).getTime())
    expect(nextPendingProbe(null, new Date(sentAt).getTime(), scan.lastTs)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Another session in the same working dir
//
// A second Claude Code session started in the install dir writes into the
// same projects directory. While its file is the newest, a newest-file-only
// read never sees the hub's own ingestions.
// ---------------------------------------------------------------------------
describe('several transcripts in one directory', () => {
  const hubTs = '2026-10-01T10:00:00.000Z'

  function writeAt(path: string, body: string, mtimeMs: number): void {
    writeFileSync(path, body, 'utf-8')
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  }

  function setup(): { dir: string; t: number } {
    const dir = tmpDir()
    const t = Date.now() - 60_000
    writeAt(join(dir, 'hub.jsonl'), userRec(hubTs, HI_BLOCK) + '\n', t)
    // the other session wrote later, with no channel traffic
    writeAt(join(dir, 'other.jsonl'), JSON.stringify({ type: 'assistant', timestamp: hubTs, message: { content: [] } }) + '\n', t + 30_000)
    return { dir, t }
  }

  it('without sinceMs only the newest file is read (unchanged for other callers)', () => {
    const { dir } = setup()
    expect(scanIngestion(dir).lastTs).toBe(null)
    // The entry point the keepalive refresh and the intake monitor call.
    expect(readLastIngestionTimestampAcross([dir])).toBe(null)
  })

  it('with sinceMs every file written since then is read and the newest record wins', () => {
    const { dir, t } = setup()
    expect(scanIngestion(dir, t - 1).lastTs).toBe(new Date(hubTs).getTime())
    expect(scanIngestionAcross([dir], t - 1).lastTs).toBe(new Date(hubTs).getTime())
  })

  it('sinceMs after a file\'s mtime leaves that file out', () => {
    const { dir, t } = setup()
    expect(scanIngestion(dir, t + 1).lastTs).toBe(null)
  })

  it('countTranscriptWritersSince counts distinct files written since the time', () => {
    const { dir, t } = setup()
    expect(countTranscriptWritersSince([dir], t - 1)).toBe(2)
    expect(countTranscriptWritersSince([dir], t + 1)).toBe(1)
    expect(countTranscriptWritersSince([dir], t + 60_000)).toBe(0)
    expect(countTranscriptWritersSince(['/tmp/nonexistent-inbound-probe-writers-' + Date.now()], 0)).toBe(0)
  })

  it('countTranscriptWritersSince counts a file reached through two roots once', () => {
    const { dir, t } = setup()
    const alias = join(tmpDir(), 'alias')
    symlinkSync(dir, alias)
    expect(countTranscriptWritersSince([dir, alias], t - 1)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// decideProbeTick: the per-tick decision the watchdog runs
// ---------------------------------------------------------------------------
describe('decideProbeTick', () => {
  const T0 = 50_000_000
  const TIMEOUT = 2 * I
  const NO_SCAN = { lastTs: null, lastProbeTs: null }
  function st(pendingSince: number | null, probeHeard: boolean, extra: Partial<ProbeTickState> = {}): ProbeTickState {
    return { ...INITIAL_PROBE_TICK_STATE, pendingSince, probeHeard, ...extra }
  }
  const HEARD = st(null, true)
  const base = { disarmedAt: 0, respawnTimes: [], dayRespawnTimes: [], tripped: false, ceilingHeld: false }

  it('two unanswered sends after a heard probe: respawn on the third tick, 2 intervals after the first send', () => {
    const scan = { lastTs: T0 - 60_000, lastProbeTs: T0 - 60_000 }
    let r = decideProbeTick({ state: HEARD, markerTs: T0, scan, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: T0, probeHeard: true, respawn: false })
    r = decideProbeTick({ state: r, markerTs: T0 + I, scan, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })
    expect(r.respawn).toBe(false)
    r = decideProbeTick({ state: r, markerTs: T0 + 2 * I, scan, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + 2 * I + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: T0, probeHeard: true, respawn: true })
  })

  it('never heard a probe: no respawn however long the probes go unanswered', () => {
    let state = st(null, false)
    for (let k = 0; k < 10; k++) {
      const r = decideProbeTick({ state, markerTs: T0 + k * I, scan: NO_SCAN, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + k * I + 1_000 })
      expect(r.respawn).toBe(false)
      expect(r.tripped).toBe(false)
      expect(r.probeHeard).toBe(false)
      state = r
    }
    expect(state.pendingSince).toBe(T0)
  })

  it('an owner message alone does not arm the check (pings dropped by the allowlist)', () => {
    const scan = { lastTs: T0 - 60_000, lastProbeTs: null }
    let state = st(null, false)
    for (let k = 0; k < 6; k++) {
      const r = decideProbeTick({ state, markerTs: T0 + k * I, scan, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + k * I + 1_000 })
      expect(r.respawn).toBe(false)
      expect(r.probeHeard).toBe(false)
      state = r
    }
  })

  it('probeHeard latches on the first seen ping and survives a later scan without one', () => {
    let r = decideProbeTick({ state: st(null, false), markerTs: T0, scan: { lastTs: T0 + 500, lastProbeTs: T0 + 500 }, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: null, probeHeard: true, respawn: false })
    r = decideProbeTick({ state: r, markerTs: T0 + I, scan: NO_SCAN, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })
    expect(r.probeHeard).toBe(true)
    r = decideProbeTick({ state: r, markerTs: T0 + 3 * I, scan: NO_SCAN, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + 3 * I + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: T0 + I, probeHeard: true, respawn: true })
  })

  it('a pending probe in the future (clock stepped back) restarts at now', () => {
    const now = T0
    const r = decideProbeTick({ state: st(T0 + 10 * I, true), markerTs: T0 - I, scan: NO_SCAN, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(r.pendingSince).toBe(now)
    expect(r.respawn).toBe(false)
  })

  it('after a respawn the old pending probe is dropped and the clock restarts with the next probe', () => {
    const respawnAt = T0 + 2 * I + 2_000
    let r = decideProbeTick({ state: st(T0, true), markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: respawnAt, probeTimeoutMs: TIMEOUT, nowMs: respawnAt + 60_000 })
    expect(r).toEqual({ ...base, pendingSince: null, probeHeard: true, respawn: false })
    const next = T0 + 3 * I
    r = decideProbeTick({ state: r, markerTs: next, scan: NO_SCAN, lastRespawnAt: respawnAt, probeTimeoutMs: TIMEOUT, nowMs: next + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: next, probeHeard: true, respawn: false })
  })

  it('a stale pending probe from before the respawn is dropped even when a new marker exists', () => {
    const respawnAt = T0 + 2 * I
    const r = decideProbeTick({ state: st(T0, true), markerTs: T0 + 3 * I, scan: NO_SCAN, lastRespawnAt: respawnAt, probeTimeoutMs: TIMEOUT, nowMs: T0 + 3 * I + 1_000 })
    expect(r).toEqual({ ...base, pendingSince: T0 + 3 * I, probeHeard: true, respawn: false })
  })

  it('an answered probe clears the clock', () => {
    const r = decideProbeTick({ state: st(T0, true), markerTs: T0 + I, scan: { lastTs: T0 + I + 3_000, lastProbeTs: T0 + I + 3_000 }, lastRespawnAt: 0, probeTimeoutMs: TIMEOUT, nowMs: T0 + 3 * I })
    expect(r).toEqual({ ...base, pendingSince: null, probeHeard: true, respawn: false })
  })
})

// ---------------------------------------------------------------------------
// Loop breaker: at most DEAFNESS_RESPAWN_LOOP_MAX respawns without a probe
// ping heard after the latest of them, then disarmed until a NEW ping is
// heard. Counted by events, not by a time window. Structural net for false positives the
// other checks did not foresee (e.g. a prober dropped by the allowlist after
// it armed the check).
// ---------------------------------------------------------------------------
describe('deafness respawn loop breaker', () => {
  const T0 = 80_000_000
  const TIMEOUT = 2 * I
  const NO_SCAN = { lastTs: null, lastProbeTs: null }
  const OLD_PING = { lastTs: T0 - 60_000, lastProbeTs: T0 - 60_000 }

  // Drive ticks every interval with no ingestion; respawn whenever due (and
  // the self grace allows), as the wiring does. Returns respawn times and the
  // tick at which the breaker tripped.
  function run(ticks: number, scanAt: (now: number) => { lastTs: number | null; lastProbeTs: number | null }) {
    let state: ProbeTickState = { ...INITIAL_PROBE_TICK_STATE, probeHeard: true }
    let lastRespawnAt = 0
    const respawns: number[] = []
    let trippedAt: number | null = null
    for (let k = 0; k < ticks; k++) {
      const now = T0 + k * I + 1_000
      const tick = decideProbeTick({ state, markerTs: T0 + k * I, scan: scanAt(now), lastRespawnAt, probeTimeoutMs: TIMEOUT, nowMs: now })
      state = { pendingSince: tick.pendingSince, probeHeard: tick.probeHeard, disarmedAt: tick.disarmedAt, respawnTimes: tick.respawnTimes, dayRespawnTimes: tick.dayRespawnTimes }
      if (tick.tripped) { expect(trippedAt).toBe(null); trippedAt = now }
      if (tick.respawn && (lastRespawnAt === 0 || now - lastRespawnAt >= GRACE)) {
        lastRespawnAt = now
        respawns.push(now)
        state = recordDeafnessRespawn(state, now)
      }
    }
    return { respawns, trippedAt, state }
  }

  it('a permanently unanswered, armed probe causes at most LOOP_MAX respawns, then trips once and stays disarmed', () => {
    const r = run(60, () => OLD_PING) // 3 hours of ticks
    expect(r.respawns.length).toBe(2)
    expect(r.trippedAt).not.toBe(null)
    expect(r.state.probeHeard).toBe(false)
    expect(r.state.disarmedAt).toBe(r.trippedAt)
  })

  it('stays disarmed while no new ping is heard, however long (old pings in the tail do not re-arm)', () => {
    const r = run(120, () => OLD_PING) // 6 hours
    expect(r.respawns.length).toBe(2)
  })

  it('a ping heard after the trip re-arms the check', () => {
    const tripState: ProbeTickState = { pendingSince: null, probeHeard: false, disarmedAt: T0, respawnTimes: [T0 - 2 * GRACE, T0 - GRACE], dayRespawnTimes: [] }
    const before = decideProbeTick({ state: tripState, markerTs: T0 + I, scan: { lastTs: T0 - 1, lastProbeTs: T0 - 1 }, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })
    expect(before.probeHeard).toBe(false)
    const after = decideProbeTick({ state: tripState, markerTs: T0 + I, scan: { lastTs: T0 + 5_000, lastProbeTs: T0 + 5_000 }, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: T0 + I + 1_000 })
    expect(after.probeHeard).toBe(true)
    // The fresh ping came after the latest respawn: the count starts over.
    expect(after.respawnTimes).toEqual([])
  })

  it('a probe ping heard after the latest respawn resets the count', () => {
    const state: ProbeTickState = { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [T0 - 3 * GRACE, T0 - GRACE], dayRespawnTimes: [] }
    const scan = { lastTs: T0 - GRACE + 5_000, lastProbeTs: T0 - GRACE + 5_000 }
    const r = decideProbeTick({ state, markerTs: T0 + 2 * I, scan, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: T0 + 2 * I + 1_000 })
    expect(r.respawn).toBe(true)
    expect(r.tripped).toBe(false)
    expect(r.respawnTimes).toEqual([])
  })

  it('an owner message after the latest respawn is not a probe ping and does not reset it', () => {
    const state: ProbeTickState = { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [T0 - 3 * GRACE, T0 - GRACE], dayRespawnTimes: [] }
    const scan = { lastTs: T0 - GRACE + 5_000, lastProbeTs: T0 - 3 * GRACE - 5_000 }
    const r = decideProbeTick({ state, markerTs: T0 + 2 * I, scan, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: T0 + 2 * I + 1_000 })
    expect(r.tripped).toBe(true)
  })

  it('a probe ping heard at or before the latest respawn does not reset it', () => {
    const state: ProbeTickState = { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [T0 - 3 * GRACE, T0 - GRACE], dayRespawnTimes: [] }
    for (const pingAt of [T0 - GRACE, T0 - GRACE - 1]) {
      const r = decideProbeTick({ state, markerTs: T0 + 2 * I, scan: { lastTs: pingAt, lastProbeTs: pingAt }, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: T0 + 2 * I + 1_000 })
      expect(r.tripped).toBe(true)
    }
  })

  it('LOOP_MAX respawns without a ping in between trip instead of a third respawn', () => {
    const state: ProbeTickState = { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [T0 - 3 * GRACE, T0 - GRACE], dayRespawnTimes: [] }
    const now = T0 + 2 * I + 1_000
    const r = decideProbeTick({ state, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: T0 - GRACE, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(r).toEqual({ pendingSince: null, probeHeard: false, disarmedAt: now, respawnTimes: [T0 - 3 * GRACE, T0 - GRACE], dayRespawnTimes: [], respawn: false, tripped: true, ceilingHeld: false })
  })

  // Literal values, not the exported constant: the "at most 2" claim in the
  // docs must fail a test when the number changes. No time window: respawns a
  // day old still count while no ping has been heard after them.
  it('no time window: two respawns a day ago without a ping since still trip', () => {
    const H = 3_600_000
    const due = (respawnTimes: number[]) => decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes, dayRespawnTimes: [] }, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: T0 - 24 * H, probeTimeoutMs: TIMEOUT, nowMs: T0 + 2 * I + 1_000 })
    expect(due([T0 - 25 * H, T0 - 24 * H]).tripped).toBe(true)
  })

  it('at most 2 respawns: one recent respawn still allows the next, two trip', () => {
    const MIN = 60_000
    const now = T0 + 2 * I + 1_000
    const due = (respawnTimes: number[]) => decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes, dayRespawnTimes: [] }, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: T0 - 20 * MIN, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(due([T0 - 20 * MIN]).respawn).toBe(true)
    expect(due([T0 - 40 * MIN, T0 - 20 * MIN]).tripped).toBe(true)
  })

  // Daily ceiling, literal values: at most 6 respawns in any rolling 24 hours,
  // whatever was heard in between.
  it('daily ceiling: 6 respawns in the last 24 h allow none more; 5 allow the 6th', () => {
    const H = 3_600_000
    const now = T0 + 2 * I + 1_000
    const due = (dayRespawnTimes: number[]) => decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [], dayRespawnTimes }, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: T0 - H, probeTimeoutMs: TIMEOUT, nowMs: now })
    const five = [20, 16, 12, 8, 4].map(h => now - h * H)
    expect(due(five)).toMatchObject({ respawn: true, ceilingHeld: false })
    const held = due([...five, now - 2 * H])
    expect(held).toMatchObject({ respawn: false, ceilingHeld: true, tripped: false, pendingSince: T0, probeHeard: true })
  })

  it('daily ceiling: a respawn exactly 24 h old has left the window; 1 ms younger has not', () => {
    const H = 3_600_000
    const now = T0 + 2 * I + 1_000
    const due = (oldest: number) => decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [], dayRespawnTimes: [oldest, ...[16, 12, 8, 4, 2].map(h => now - h * H)] }, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: T0 - H, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(due(now - 24 * H).respawn).toBe(true)
    expect(due(now - 24 * H + 1).ceilingHeld).toBe(true)
  })

  it('daily ceiling: a heard ping resets the event count but not the daily list', () => {
    const H = 3_600_000
    const now = T0 + 2 * I + 1_000
    const day = [20, 16, 12, 8, 4, 2].map(h => now - h * H)
    const scan = { lastTs: now - H, lastProbeTs: now - H }
    const r = decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [now - 2 * H], dayRespawnTimes: day }, markerTs: T0 + 2 * I, scan, lastRespawnAt: now - 2 * H, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(r.respawnTimes).toEqual([])
    expect(r.dayRespawnTimes).toEqual(day)
    expect(r.ceilingHeld).toBe(true)
  })

  it('both limits reached: the event breaker trips (disarms) rather than the ceiling holding', () => {
    const H = 3_600_000
    const now = T0 + 2 * I + 1_000
    const day = [20, 16, 12, 8, 4, 2].map(h => now - h * H)
    const r = decideProbeTick({ state: { pendingSince: T0, probeHeard: true, disarmedAt: 0, respawnTimes: [now - 4 * H, now - 2 * H], dayRespawnTimes: day }, markerTs: T0 + 2 * I, scan: NO_SCAN, lastRespawnAt: now - 2 * H, probeTimeoutMs: TIMEOUT, nowMs: now })
    expect(r).toMatchObject({ tripped: true, ceilingHeld: false, respawn: false, probeHeard: false })
  })

  it('recordDeafnessRespawn adds to the daily list and drops entries a day old', () => {
    const H = 3_600_000
    const s0: ProbeTickState = { ...INITIAL_PROBE_TICK_STATE, dayRespawnTimes: [T0 - 24 * H, T0 - 24 * H + 1] }
    expect(recordDeafnessRespawn(s0, T0).dayRespawnTimes).toEqual([T0 - 24 * H + 1, T0])
  })

  it('recordDeafnessRespawn appends and keeps every earlier respawn', () => {
    const H = 3_600_000
    const s0: ProbeTickState = { ...INITIAL_PROBE_TICK_STATE, respawnTimes: [T0 - 25 * H, T0 - 1_000] }
    expect(recordDeafnessRespawn(s0, T0).respawnTimes).toEqual([T0 - 25 * H, T0 - 1_000, T0])
    expect(s0.respawnTimes).toEqual([T0 - 25 * H, T0 - 1_000]) // input not mutated
  })
})

// ---------------------------------------------------------------------------
// isProbePing: only the exact body the prober sends
// (scripts/watchdog-inbound-prober.py: "__wd_ping <UTC ISO, ms, Z>")
// ---------------------------------------------------------------------------
describe('isProbePing', () => {
  const wrap = (body: string) => `<channel source="plugin:telegram:telegram" chat_id="1" message_id="7" user="prober" ts="2026-10-01T10:00:01.000Z">${body}</channel>`
  const PING = '__wd_ping 2026-10-01T10:00:00.123Z'

  it('the exact prober body counts', () => {
    expect(isProbePing(wrap(PING))).toBe(true)
  })
  it('surrounding whitespace or newlines inside the block are allowed', () => {
    expect(isProbePing(wrap(`\n${PING}\n`))).toBe(true)
  })
  it('one ping block among several blocks counts', () => {
    expect(isProbePing(wrap('hello') + '\n' + wrap(PING))).toBe(true)
  })
  it('a mid-sentence mention does not count', () => {
    expect(isProbePing(wrap(`did the ${PING} arrive?`))).toBe(false)
    expect(isProbePing(wrap('what is __wd_ping for'))).toBe(false)
  })
  it('a quoted ping does not count', () => {
    expect(isProbePing(wrap(`"${PING}"`))).toBe(false)
    expect(isProbePing(wrap(`> ${PING}`))).toBe(false)
    expect(isProbePing(wrap(`\`${PING}\``))).toBe(false)
  })
  it('a ping with leading or trailing text does not count', () => {
    expect(isProbePing(wrap(`${PING} thanks`))).toBe(false)
    expect(isProbePing(wrap(`${PING}\nsecond line`))).toBe(false)
    expect(isProbePing(wrap(`fwd: ${PING}`))).toBe(false)
  })
  it('the marker alone or with another timestamp shape does not count', () => {
    expect(isProbePing(wrap('__wd_ping'))).toBe(false)
    expect(isProbePing(wrap('__wd_ping 2026-10-01T10:00:00Z'))).toBe(false)
    expect(isProbePing(wrap('__wd_ping 2026-10-01 10:00:00.123'))).toBe(false)
  })
  it('a ping outside any channel block does not count', () => {
    expect(isProbePing(PING)).toBe(false)
    expect(isProbePing(`${wrap('hi')} ${PING}`)).toBe(false)
  })
})

// A coordinator-backfilled message starts with CHANNEL_INBOUND_PREAMBLE, which
// quotes its own <channel source="..."> ... </channel> pair. The backfilled
// ping and owner message themselves are cells of the matrix below.
describe('scanIngestion: coordinator-backfilled channel messages', () => {
  it("the preamble's own example block is not a probe ping", () => {
    expect(CHANNEL_INBOUND_PREAMBLE).toContain('<channel source=')
    expect(isProbePing(CHANNEL_INBOUND_PREAMBLE)).toBe(false)
    const dir = tmpDir()
    writeFileSync(join(dir, 's.jsonl'), userRec('2026-10-01T10:00:05.000Z', CHANNEL_INBOUND_PREAMBLE) + '\n', 'utf-8')
    expect(scanIngestion(dir).lastProbeTs).toBe(null)
  })
})

// Every record shape the parser accepts (and the ones it must reject) x every
// content variant a channel message can take, through the real file scan.
describe('scanIngestion: record shape x content matrix', () => {
  const TS = '2026-10-01T10:00:05.000Z'
  const PING = `${PROBE_PING_PREFIX} 2026-10-01T10:00:00.123Z`
  const block = channelBlock

  const variants: Array<{ name: string; text: string; ping: boolean }> = [
    { name: 'plain ping block', text: block(PING), ping: true },
    { name: 'newline-wrapped ping block', text: block(nativeBody(PING)), ping: true },
    { name: 'preamble-prefixed ping (coordinator backfill)', text: backfilled(handoffBlock(PING)), ping: true },
    { name: 'ping block first, then another block', text: `${block(nativeBody(PING))}\n${block(nativeBody('hello'))}`, ping: true },
    { name: 'another block first, then the ping block', text: `${block(nativeBody('hello'))}\n${block(nativeBody(PING))}`, ping: true },
    { name: 'owner message', text: block(nativeBody('hello')), ping: false },
    { name: 'preamble-prefixed owner message', text: backfilled(handoffBlock('hello')), ping: false },
    { name: 'quoted ping in an owner message', text: block(nativeBody(`"${PING}"`)), ping: false },
    { name: 'ping mentioned mid-sentence', text: block(nativeBody(`did ${PING} arrive?`)), ping: false },
  ]
  const accepted: Array<{ name: string; rec: (text: string) => object }> = [
    { name: 'user, string content', rec: (text) => REC.userString(TS, text) },
    { name: 'user, text parts', rec: (text) => REC.userParts(TS, text) },
    { name: 'user, text part next to an image', rec: (text) => REC.userPartsWithImage(TS, text) },
    { name: 'user, channel text in the first of two text parts', rec: (text) => REC.userPartsTextFirst(TS, text) },
    { name: 'user, channel text in the second of two text parts', rec: (text) => REC.userPartsTextSecond(TS, text) },
    { name: 'queue-operation enqueue', rec: (text) => REC.enqueue(TS, text) },
    { name: 'attachment queued_command', rec: (text) => REC.queuedCommand(TS, text) },
  ]
  const rejected: Array<{ name: string; rec: (text: string) => object }> = [
    { name: 'user with a tool_result part', rec: (text) => ({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', content: text }, { type: 'text', text }] } }) },
    { name: 'assistant text', rec: (text) => ({ type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text }] } }) },
    { name: 'queue-operation remove', rec: (text) => ({ type: 'queue-operation', operation: 'remove', timestamp: TS, content: text }) },
    { name: 'attachment of another type', rec: (text) => ({ type: 'attachment', timestamp: TS, attachment: { type: 'mcp_instructions_delta', prompt: text } }) },
  ]
  const scanOne = (obj: object) => {
    const dir = tmpDir('inbound-probe-matrix-')
    writeFileSync(join(dir, 's.jsonl'), JSON.stringify(obj) + '\n', 'utf-8')
    return scanIngestion(dir)
  }
  const tsMs = new Date(TS).getTime()

  for (const shape of accepted) {
    for (const v of variants) {
      it(`${shape.name} x ${v.name}`, () => {
        expect(scanOne(shape.rec(v.text))).toEqual({ lastTs: tsMs, lastProbeTs: v.ping ? tsMs : null })
      })
    }
  }
  for (const shape of rejected) {
    for (const v of variants) {
      it(`${shape.name} x ${v.name}: not inbound`, () => {
        expect(scanOne(shape.rec(v.text))).toEqual({ lastTs: null, lastProbeTs: null })
      })
    }
  }
})

describe('scanIngestion: only an exact probe ping sets lastProbeTs', () => {

  it('an owner message mentioning the marker is ingestion, not a probe ping', () => {
    const dir = tmpDir('inbound-probe-ping-shape-')
    const ts = '2026-10-01T10:00:00.000Z'
    const tag = '<channel source="plugin:telegram:telegram" chat_id="1">'
    writeFileSync(join(dir, 's.jsonl'), [
      userRec(ts, `${tag}${nativeBody('is the __wd_ping 2026-10-01T09:59:00.000Z working?')}</channel>`),
      userRec(ts, `${tag}${nativeBody('"__wd_ping 2026-10-01T09:59:00.000Z"')}</channel>`),
      userRec(ts, `${tag}${nativeBody('__wd_ping 2026-10-01T09:59:00.000Z please ignore')}</channel>`),
    ].join('\n') + '\n', 'utf-8')
    expect(scanIngestion(dir)).toEqual({ lastTs: new Date(ts).getTime(), lastProbeTs: null })
  })
})

describe('deafnessRespawnHold', () => {
  it('holds when more than one transcript was written', () => {
    expect(deafnessRespawnHold({ transcriptWriters: 2, paneState: 'idle' })).toBe('ambiguous')
  })
  it('holds a busy or typing pane', () => {
    expect(deafnessRespawnHold({ transcriptWriters: 1, paneState: 'busy' })).toBe('busy')
    expect(deafnessRespawnHold({ transcriptWriters: 0, paneState: 'typing' })).toBe('busy')
  })
  it('proceeds on an idle, unknown, error or unreadable pane with at most one writer', () => {
    for (const paneState of ['idle', 'unknown', 'error', null]) {
      expect(deafnessRespawnHold({ transcriptWriters: 1, paneState })).toBe(null)
    }
    expect(deafnessRespawnHold({ transcriptWriters: 0, paneState: 'idle' })).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Out-of-order lines: newest timestamp wins, not the last line
//
// A queued_command line is written at the next tool boundary, minutes after
// its enqueue, stamped back to the enqueue time. A later enqueue (the probe)
// can sit EARLIER in the file than that backdated line.
// ---------------------------------------------------------------------------
describe('readLastIngestionTimestamp: newest timestamp wins over file order', () => {

  it('a backdated queued_command after a newer enqueue does not move lastTs or lastProbeTs back', () => {
    const dir = tmpDir('inbound-probe-order-')
    const t1 = '2026-10-01T10:00:00.000Z' // owner message A
    const t2 = '2026-10-01T10:02:00.000Z' // the probe
    const A = '<channel source="plugin:telegram:telegram" chat_id="1"> A</channel>'
    const P = `<channel source="plugin:telegram:telegram" chat_id="1">${nativePing('2026-10-01T10:01:59.123Z')}</channel>`
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: t1, content: A }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: t2, content: P }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: t2 }),
      JSON.stringify({ type: 'attachment', timestamp: t1, attachment: { type: 'queued_command', prompt: A, origin: { kind: 'channel' } } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(scanIngestion(dir)).toEqual({ lastTs: new Date(t2).getTime(), lastProbeTs: new Date(t2).getTime() })
  })

  it('the same holds for the probe ping itself written late', () => {
    const dir = tmpDir('inbound-probe-order-')
    const t1 = '2026-10-01T10:00:00.000Z'
    const t2 = '2026-10-01T10:02:00.000Z'
    const P = `<channel source="plugin:telegram:telegram" chat_id="1">${nativePing('2026-10-01T10:01:59.123Z')}</channel>`
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: t2, content: P }),
      JSON.stringify({ type: 'attachment', timestamp: t1, attachment: { type: 'queued_command', prompt: P, origin: { kind: 'channel' } } }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, 's.jsonl'), lines, 'utf-8')
    expect(scanIngestion(dir).lastProbeTs).toBe(new Date(t2).getTime())
  })
})

// ---------------------------------------------------------------------------
// runInboundProbeTick: the whole per-tick wiring
//
// The pure decisions above are only as good as the code that feeds and obeys
// them: not carrying the state, a misplaced return, a wrong threshold or the
// wrong arguments to the transcript readers reintroduces the original bug
// with every pure test green. So the tick runs here end to end against a
// simulated prober and a hub that writes real .jsonl transcripts into temp
// dirs. The transcript readers are the production ones
// (defaultProbeTickDeps.scan / countWriters); only the clock, the marker,
// the state store, the pane state and the restart are faked.
// ---------------------------------------------------------------------------
const SIM_T0 = Date.parse('2026-10-01T00:00:00.000Z')

interface SimOpts {
  // Send index k (sent at SIM_T0 + k * interval) -> heard by the hub this
  // many ms later, or null.
  heard: (k: number) => number | null
  // Another Claude Code session writes in the hub's transcript dir.
  sibling?: (now: number) => boolean
  pane?: (now: number) => PaneState | null
  crossPathAt?: () => number
  restartOk?: boolean
  intervalMs?: number
  // An older ping in the shared root (the hub ran there before isolation).
  oldSharedPing?: boolean
  // One ordinary owner message (channel tag, no probe ping) at the first tick.
  ownerMessage?: boolean
  // Body of that owner message (default: a plain greeting).
  ownerBody?: string
  // Every ping arrives through the channel coordinator's backfill.
  backfillOnly?: boolean
  // Bytes of assistant output the hub writes after its inbound each tick.
  outputBytes?: number
}

const setMtime = (path: string, ms: number): void => utimesSync(path, ms / 1000, ms / 1000)

function sim(opts: SimOpts) {
  const interval = opts.intervalMs ?? I
  const base = tmpDir('inbound-probe-sim-')
  // Two roots, the shared one first, as mainTranscriptDirs() orders them.
  const shared = join(base, 'shared')
  const iso = join(base, 'iso')
  mkdirSync(shared)
  mkdirSync(iso)
  const OLD_PING_TS = SIM_T0 - 24 * 3600_000
  if (opts.oldSharedPing !== false) {
    const f = join(shared, 'old-session.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'user', timestamp: new Date(OLD_PING_TS).toISOString(), message: { content: `${pingBlock(new Date(OLD_PING_TS - 1000).toISOString())}` } }) + '\n')
    setMtime(f, OLD_PING_TS)
  }
  // The hub's own session: its transcript plus the per-session subfolder
  // Claude Code keeps next to it (subagents/, tool-results/) and a non-jsonl
  // file. None of these is a second writer.
  const hubFile = join(iso, 'hub-session.jsonl')
  const hubSubdir = join(iso, 'hub-session')
  mkdirSync(join(hubSubdir, 'subagents'), { recursive: true })
  mkdirSync(join(hubSubdir, 'tool-results'), { recursive: true })
  writeFileSync(hubFile, '')
  setMtime(hubFile, SIM_T0 - 3600_000)
  const siblingFile = join(iso, 'sibling-session.jsonl')

  let now = SIM_T0
  let state: ProbeLoopState = { tick: INITIAL_PROBE_TICK_STATE, lastInboundRespawn: 0, warnedAmbiguous: false }
  const restarts: number[] = []
  const saves: ProbeLoopState[] = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const shapes = [
    REC.userString,
    REC.queuedCommand,
    REC.enqueue,
    // Coordinator backfill: the preamble (with its own example block) first.
    (ts: string, text: string) => REC.userString(ts, backfilled(text)),
  ]
  let written = 0 // sends materialised up to this index
  let lastWriteAt = 0
  let prevNow: number | null = null // the previous tick

  // What the hub wrote between the previous tick and now.
  const advanceWorld = (): void => {
    const lines: string[] = []
    for (let k = written; SIM_T0 + k * interval <= now; k++) {
      const d = opts.heard(k)
      const at = SIM_T0 + k * interval + (d ?? 0)
      if (d != null && at > now) break
      if (d != null) lines.push(JSON.stringify(shapes[opts.backfillOnly ? 3 : k % 4](new Date(at).toISOString(), `${pingBlock(new Date(SIM_T0 + k * interval).toISOString())}`)))
      written = k + 1
    }
    if (opts.ownerMessage && lastWriteAt === 0) {
      lines.push(JSON.stringify({ type: 'user', timestamp: new Date(now - 400).toISOString(), message: { content: channelBlock(nativeBody(opts.ownerBody ?? 'hello from the owner')) } }))
    }
    // A locally typed prompt whose own text has no channel tag, while another
    // field of the same line quotes one: not channel ingestion.
    const localAt = now - 300
    lines.push(JSON.stringify({ type: 'user', timestamp: new Date(localAt).toISOString(), message: { content: 'local prompt' }, note: channelBlock('quoted') }))
    // A busy hub's own output after the inbound, written continuously: stamped
    // evenly from 3 s after the previous tick up to just before this one.
    if (opts.outputBytes) {
      const from = (prevNow ?? now - 4000) + 3000
      const text = 'x'.repeat(4000)
      const count = Math.ceil(opts.outputBytes / 4100)
      for (let n = 0; n < count; n++) {
        const ts = from + Math.floor(((now - 250 - from) * n) / count)
        lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { content: [{ type: 'text', text }] } }), ...BOOKKEEPING_LINES)
      }
    }
    prevNow = now
    writeFileSync(hubFile, lines.join('\n') + '\n', { flag: 'a' })
    lastWriteAt = localAt
    setMtime(hubFile, localAt)
    // The hub's subfolder and a sidecar file are touched after its transcript.
    writeFileSync(join(hubSubdir, 'subagents', 'agent.jsonl'), '{}\n', { flag: 'a' })
    writeFileSync(join(hubSubdir, 'tool-results', 'out.txt'), 'x', { flag: 'a' })
    writeFileSync(join(iso, 'custom-title.json'), '{}')
    setMtime(join(hubSubdir, 'subagents', 'agent.jsonl'), now - 100)
    setMtime(join(hubSubdir, 'tool-results', 'out.txt'), now - 100)
    setMtime(hubSubdir, now - 100)
    setMtime(join(iso, 'custom-title.json'), now - 100)
    if (opts.sibling?.(now)) {
      writeFileSync(siblingFile, JSON.stringify({ type: 'assistant', timestamp: new Date(now - 200).toISOString(), message: { content: 'working' } }) + '\n', { flag: 'a' })
      setMtime(siblingFile, now - 200)
    }
  }

  const deps: ProbeTickDeps = {
    now: () => now,
    sessionExists: () => true,
    readMarker: () => SIM_T0 + Math.floor((now - SIM_T0) / interval) * interval,
    transcriptDirs: () => [shared, iso],
    scan: defaultProbeTickDeps.scan,
    countWriters: defaultProbeTickDeps.countWriters,
    loadState: () => state,
    saveState: (x) => { state = x; saves.push(x) },
    respawnSide: async () => ({
      lastCrossPathRespawnAt: () => opts.crossPathAt?.() ?? 0,
      paneState: () => (opts.pane ? opts.pane(now) : 'idle'),
      restart: () => {
        restarts.push(now)
        return opts.restartOk === false ? { ok: false, error: 'boom' } : { ok: true }
      },
    }),
    log,
  }
  return {
    deps, restarts, saves, log,
    state: () => state,
    setState: (x: ProbeLoopState) => { state = x },
    lastWriteAt: () => lastWriteAt,
    async tickAt(t: number) {
      now = t
      advanceWorld()
      await runInboundProbeTick(interval, deps)
    },
    // Ticks just after each send (k * interval + offset, default 1 s) for k
    // in [from, to).
    async run(from: number, to: number, offset = 1000) {
      for (let k = from; k < to; k++) await this.tickAt(SIM_T0 + k * interval + offset)
    },
  }
}

const deafFrom = (k0: number) => (k: number): number | null => (k < k0 ? 2000 : null)
const at = (k: number, interval = I): number => SIM_T0 + k * interval + 1000

describe('runInboundProbeTick', () => {
  it('never restarts a healthy hub, across many grace windows', async () => {
    const s = sim({ heard: () => 2000 })
    await s.run(0, 60)
    expect(s.restarts).toEqual([])
    expect(s.state().tick.probeHeard).toBe(true)
  })

  it('never restarts a healthy hub whose pings all arrive through the coordinator backfill', async () => {
    const s = sim({ heard: () => 2000, backfillOnly: true })
    await s.run(0, 20)
    expect(s.restarts).toEqual([])
    expect(s.state().tick.probeHeard).toBe(true)
  })

  // A busy hub writes more than the 256 KB tail between a ping and the next
  // tick. The deafness check reads back to the pending probe, so the answer
  // is still found.
  it('never restarts a healthy hub that writes 320 KB per interval after each ping', async () => {
    const s = sim({ heard: () => 2000, outputBytes: 320 * 1024 })
    await s.run(0, 20)
    expect(s.restarts).toEqual([])
    expect(s.state().tick.probeHeard).toBe(true)
  })

  it('never restarts a healthy hub that writes 3 MB per interval after each ping', async () => {
    const s = sim({ heard: () => 2000, outputBytes: 3 * 1024 * 1024 })
    await s.run(0, 10)
    expect(s.restarts).toEqual([])
  })

  it('still restarts a deaf hub that writes 320 KB per interval', async () => {
    const s = sim({ heard: deafFrom(5), outputBytes: 320 * 1024 })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
  })

  it('holds when the read limit stopped the scan before the pending probe', async () => {
    const s = sim({ heard: deafFrom(5) })
    const real = s.deps.scan
    s.deps.scan = (dirs, sinceMs) => ({ ...real(dirs, sinceMs), truncated: true })
    await s.run(0, 12)
    expect(s.restarts).toEqual([])
    // Due from tick 7 on, held on every due tick, warned once for this probe.
    const limitWarns = s.log.warn.mock.calls.filter(c => String(c[1]).includes('read limit'))
    expect(limitWarns.length).toBe(1)
  })

  it('the read-limit warning is logged again for the next unanswered probe', async () => {
    // Deaf for sends 5..9, send 10 answered, deaf again from 11 on.
    const s = sim({ heard: (k) => (k < 5 || k === 10 ? 2000 : null) })
    const real = s.deps.scan
    s.deps.scan = (dirs, sinceMs) => ({ ...real(dirs, sinceMs), truncated: true })
    await s.run(0, 20)
    expect(s.restarts).toEqual([])
    const limitWarns = s.log.warn.mock.calls.filter(c => String(c[1]).includes('read limit'))
    expect(limitWarns.map(c => (c[0] as { pendingSince: number }).pendingSince)).toEqual([SIM_T0 + 5 * I, SIM_T0 + 11 * I])
  })

  // With an interval above the 15 min slack, the anchor must be the OLDEST
  // unanswered probe: reading back only to the latest probe stops at the
  // hub's own output written after the earlier answer and misses it.
  it('20 min interval, hub writing continuously: the oldest pending probe anchors the read', async () => {
    const interval = 20 * 60_000
    const s = sim({ heard: () => 2000, intervalMs: interval, outputBytes: 8 * 1024 * 1024 })
    const since: number[] = []
    const real = s.deps.scan
    s.deps.scan = (dirs, sinceMs) => { since.push(sinceMs); return real(dirs, sinceMs) }
    await s.run(0, 4)
    expect(s.restarts).toEqual([])
    // Tick k+1 still sees probe k pending (its answer is written after tick k).
    expect(since.slice(1)).toEqual([0, 1, 2].map(k => SIM_T0 + k * interval))
  })

  it('never restarts a hub that answers slower than one tick, within the threshold', async () => {
    const s = sim({ heard: () => I + 30_000 })
    await s.run(0, 60)
    expect(s.restarts).toEqual([])
  })

  it('restarts a hub that went deaf 2 intervals after the first unanswered probe', async () => {
    const s = sim({ heard: deafFrom(5), oldSharedPing: false })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    expect(s.state().lastInboundRespawn).toBe(at(7))
    expect(s.state().tick.respawnTimes).toEqual([at(7)])
  })

  it('saves the pending probe on ticks that do not respawn (the clock is carried)', async () => {
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 7)
    expect(s.restarts).toEqual([])
    expect(s.state().tick.pendingSince).toBe(SIM_T0 + 5 * I)
    expect(s.saves.length).toBe(7)
  })

  it('after a respawn the clock restarts with the next probe to the new process', async () => {
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 9)
    expect(s.restarts).toEqual([at(7)])
    expect(s.state().tick.pendingSince).toBe(SIM_T0 + 8 * I)
  })

  it('threshold is interval * PROBE_TIMEOUT_MULTIPLIER from the pending probe', async () => {
    for (const interval of [60_000, I]) {
      const P = SIM_T0 + 5 * interval
      const below = sim({ heard: deafFrom(5), intervalMs: interval })
      await below.run(0, 6)
      expect(below.state().tick.pendingSince).toBe(P)
      await below.tickAt(P + 2 * interval - 1)
      expect(below.restarts).toEqual([])
      await below.tickAt(P + 2 * interval)
      expect(below.restarts).toEqual([P + 2 * interval])
    }
  })

  it('does not arm before a probe ping has been heard (prober not allowlisted)', async () => {
    // An ordinary owner message is channel inbound but not a probe ping.
    const s = sim({ heard: () => null, oldSharedPing: false, ownerMessage: true })
    await s.run(0, 60)
    expect(s.restarts).toEqual([])
    expect(s.state().tick.probeHeard).toBe(false)
  })

  it('an owner message that mentions, quotes or extends a ping does not arm the check', async () => {
    const ping = `${PROBE_PING_PREFIX} ${new Date(SIM_T0).toISOString()}`
    for (const ownerBody of [`did the ${ping} arrive?`, `"${ping}"`, `${ping} thanks`]) {
      const s = sim({ heard: () => null, oldSharedPing: false, ownerMessage: true, ownerBody })
      await s.run(0, 20)
      expect(s.restarts).toEqual([])
      expect(s.state().tick.probeHeard).toBe(false)
    }
  })

  it('loop breaker: two respawns, then one error and no more while deaf', async () => {
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 60)
    expect(s.restarts).toEqual([at(7), at(12)])
    expect(s.log.error).toHaveBeenCalledTimes(1)
    expect(s.state().tick.probeHeard).toBe(false)
  })

  // The breaker counts events, so the bound holds at any probe interval.
  for (const minutes of [3, 20, 60]) {
    const interval = minutes * 60_000
    it(`${minutes} min interval: a deaf hub gets exactly 2 respawns, then one error and no more`, async () => {
      const s = sim({ heard: deafFrom(5), intervalMs: interval })
      await s.run(0, 60)
      expect(s.restarts.length).toBe(2)
      expect(s.log.error).toHaveBeenCalledTimes(1)
      expect(s.state().tick.probeHeard).toBe(false)
    })

    it(`${minutes} min interval: a respawn that cures the hub resets the count`, async () => {
      // Deaf for sends 5..7 (cured by the first respawn), deaf again from 20.
      const s = sim({ heard: (k) => (k < 5 || (k >= 8 && k < 20) ? 2000 : null), intervalMs: interval })
      await s.run(0, 60)
      expect(s.restarts.length).toBe(3)
      expect(s.restarts[0]).toBe(at(7, interval))
      expect(s.log.error).toHaveBeenCalledTimes(1)
    })
  }

  // An intermittently deaf hub hears every 10th ping: each heard ping resets
  // the event count, so only the daily ceiling bounds it.
  for (const minutes of [3, 20, 60]) {
    const interval = minutes * 60_000
    it(`${minutes} min interval: an intermittently deaf hub gets at most 6 respawns in any 24 h`, async () => {
      const DAY = 24 * 3_600_000
      const s = sim({ heard: (k) => (k % 10 === 0 ? 2000 : null), intervalMs: interval })
      await s.run(0, Math.ceil((2 * DAY) / interval))
      for (const r of s.restarts) expect(s.restarts.filter(t => t >= r && t < r + DAY).length).toBeLessThanOrEqual(6)
      const ceilingErrors = s.log.error.mock.calls.filter(c => String(c[1]).includes('daily ceiling'))
      // One error per ceiling episode, not one per held tick.
      expect(ceilingErrors.length).toBeLessThanOrEqual(Math.max(0, s.restarts.length - 5))
    })
  }

  it('3 min interval: the intermittent hub actually reaches the daily ceiling and the error is not repeated per tick', async () => {
    const s = sim({ heard: (k) => (k % 10 === 0 ? 2000 : null) })
    await s.run(0, 480) // 24 h
    expect(s.restarts.length).toBe(6)
    const ceilingErrors = s.log.error.mock.calls.filter(c => String(c[1]).includes('daily ceiling'))
    expect(ceilingErrors.length).toBe(1)
  })

  it('3 min interval: a later ceiling episode, after the oldest respawn left the window, logs one more error', async () => {
    const s = sim({ heard: (k) => (k % 10 === 0 ? 2000 : null) })
    await s.run(0, 1000) // a little over 2 days
    const ceilingErrors = s.log.error.mock.calls.filter(c => String(c[1]).includes('daily ceiling'))
    expect(ceilingErrors.length).toBeGreaterThanOrEqual(2)
    // One error per episode: each one names a different oldest respawn.
    const oldest = ceilingErrors.map(c => (c[0] as { oldest: number }).oldest)
    expect(new Set(oldest).size).toBe(oldest.length)
  })

  it('after a trip, re-arms on the fresh ping in the hub root, not on an older ping in the shared root', async () => {
    // Deaf for sends 5..19, hears again from send 20 on.
    const s = sim({ heard: (k) => (k < 5 || k >= 20 ? 2000 : null) })
    await s.run(0, 20)
    expect(s.restarts).toEqual([at(7), at(12)])
    expect(s.state().tick.probeHeard).toBe(false)
    await s.run(20, 22)
    expect(s.state().tick.probeHeard).toBe(true)
  })

  it('holds while another session writes in the same dir, on every due tick, and warns once', async () => {
    let siblingOn = true
    const s = sim({ heard: deafFrom(5), sibling: () => siblingOn })
    await s.run(0, 20)
    expect(s.restarts).toEqual([])
    expect(s.log.warn).toHaveBeenCalledTimes(1)
    expect(s.state().warnedAmbiguous).toBe(true)
    // It was written after the pending probe, so it still counts once it stops.
    siblingOn = false
    await s.run(20, 25)
    expect(s.restarts).toEqual([])
  })

  it('a session that last wrote before the pending probe does not hold', async () => {
    const s = sim({ heard: deafFrom(5), sibling: (now) => now < SIM_T0 + 4 * I })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    expect(s.state().warnedAmbiguous).toBe(false)
  })

  it('a due tick that passes the ambiguity check clears the warned flag', async () => {
    const s = sim({ heard: deafFrom(5) })
    s.setState({ ...s.state(), warnedAmbiguous: true })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    expect(s.state().warnedAmbiguous).toBe(false)
  })

  it('the hub session subfolder and sidecar files are not a second writer', async () => {
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    expect(s.log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('several transcripts'))
  })

  it('a local prompt that only quotes the channel tag outside its text does not answer a probe', async () => {
    // advanceWorld writes such a line on every tick; a deaf hub must still be
    // detected.
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 8)
    expect(s.lastWriteAt()).toBeGreaterThan(SIM_T0 + 7 * I)
    expect(s.restarts).toEqual([at(7)])
  })

  it('holds a busy or typing pane on every due tick, then respawns when idle', async () => {
    for (const held of ['busy', 'typing'] as const) {
      let pane: PaneState | null = held
      const s = sim({ heard: deafFrom(5), pane: () => pane })
      await s.run(0, 20)
      expect(s.restarts).toEqual([])
      pane = 'idle'
      await s.run(20, 21)
      expect(s.restarts).toEqual([at(20)])
    }
  })

  it('an unreadable or unknown pane does not hold (fail-open)', async () => {
    for (const pane of [null, 'unknown'] as const) {
      const s = sim({ heard: deafFrom(5), pane: () => pane })
      await s.run(0, 8)
      expect(s.restarts).toEqual([at(7)])
    }
  })

  it('skips within the cross-path grace of a keepalive respawn', async () => {
    const s = sim({ heard: deafFrom(5), crossPathAt: () => SIM_T0 + 7 * I })
    await s.run(0, 8)
    expect(s.restarts).toEqual([])
    await s.run(8, 13)
    expect(s.restarts).toEqual([at(12)])
    expect(at(12) - (SIM_T0 + 7 * I)).toBeGreaterThanOrEqual(GRACE)
  })

  // Literal minutes, not the module constant: the docs claim a 15 minute
  // respawn grace on both paths.
  it('self grace is 15 minutes: no second respawn 1 ms before, a respawn exactly at it', async () => {
    const s = sim({ heard: deafFrom(5) })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    // Probes to the new process stay unanswered; due again from 10 intervals.
    await s.run(8, 12)
    expect(s.restarts).toEqual([at(7)])
    await s.tickAt(at(7) + 15 * 60_000 - 1)
    expect(s.restarts).toEqual([at(7)])
    await s.tickAt(at(7) + 15 * 60_000)
    expect(s.restarts).toEqual([at(7), at(7) + 15 * 60_000])
  })

  it('cross-path grace is 15 minutes: no respawn 1 ms before, a respawn exactly at it', async () => {
    const X = SIM_T0 + 7 * I
    const s = sim({ heard: deafFrom(5), crossPathAt: () => X })
    await s.run(0, 8)
    await s.tickAt(X + 15 * 60_000 - 1)
    expect(s.restarts).toEqual([])
    await s.tickAt(X + 15 * 60_000)
    expect(s.restarts).toEqual([X + 15 * 60_000])
  })

  it('a respawn comes at least 2 and at most about 3 intervals after the first unanswered probe', async () => {
    // Ticks just after each send: 2 intervals (plus the 1 s tick offset).
    const early = sim({ heard: deafFrom(5) })
    await early.run(0, 10)
    expect(early.restarts[0] - (SIM_T0 + 5 * 180_000)).toBe(2 * 180_000 + 1000)
    // Ticks just before each send: the first unanswered probe is first seen
    // almost one interval late, so the respawn comes just under 3 intervals.
    const late = sim({ heard: deafFrom(5) })
    await late.run(1, 10, -1000)
    expect(late.restarts[0] - (SIM_T0 + 5 * 180_000)).toBe(3 * 180_000 - 1000)
  })

  it('a failed restart records neither the respawn stamp nor a breaker entry', async () => {
    const s = sim({ heard: deafFrom(5), restartOk: false })
    await s.run(0, 8)
    expect(s.restarts).toEqual([at(7)])
    expect(s.state().lastInboundRespawn).toBe(0)
    expect(s.state().tick.respawnTimes).toEqual([])
    expect(s.log.error).toHaveBeenCalledTimes(1)
  })

  it('a failed lazy import is logged, not thrown', async () => {
    const s = sim({ heard: deafFrom(5) })
    s.deps.respawnSide = async () => { throw new Error('import failed') }
    await expect(s.run(0, 8)).resolves.toBeUndefined()
    expect(s.restarts).toEqual([])
    expect(s.log.error).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a session file or a marker', async () => {
    for (const patch of [{ sessionExists: () => false }, { readMarker: () => null }]) {
      const s = sim({ heard: deafFrom(5) })
      Object.assign(s.deps, patch)
      const scan = vi.spyOn(s.deps, 'scan')
      await s.run(0, 20)
      expect(s.restarts).toEqual([])
      expect(s.saves).toEqual([])
      expect(scan).not.toHaveBeenCalled()
    }
  })

  it('the default deps keep the state across ticks (module-level store)', () => {
    const before = defaultProbeTickDeps.loadState()
    const marked: ProbeLoopState = { ...before, lastInboundRespawn: 12345 }
    defaultProbeTickDeps.saveState(marked)
    expect(defaultProbeTickDeps.loadState()).toBe(marked)
    defaultProbeTickDeps.saveState(before)
  })
})

// ---------------------------------------------------------------------------
// Reading back to the pending probe
//
// The 256 KB tail alone loses the ingestion that answered a probe whenever the
// hub writes more than that before the next tick. With a sinceMs the read goes
// back in 1 MB chunks until a record stamped more than 15 minutes before
// sinceMs, the file start, or 32 MB. Literal sizes and times on purpose.
// ---------------------------------------------------------------------------
describe('backscanStart', () => {
  const MB = 1024 * 1024
  const MIN = 60_000
  const S = Date.parse('2026-10-01T10:00:00.000Z')
  // A file whose records are stamped by offset: one minute per MB, ending at S.
  const byOffset = (size: number) => (offset: number) => S - Math.round(((size - offset) / MB) * MIN)

  it('without sinceMs: the last 262 144 bytes', () => {
    expect(backscanStart(10 * MB, undefined, () => 0)).toEqual({ start: 10 * MB - 262_144, truncated: false })
    expect(backscanStart(100_000, undefined, () => 0)).toEqual({ start: 0, truncated: false })
  })

  it('stops at the tail when its first record is already older than sinceMs - 15 min', () => {
    expect(backscanStart(10 * MB, S - 10 * MIN, () => S - 26 * MIN)).toEqual({ start: 10 * MB - 262_144, truncated: false })
  })

  it('goes back in 1 MB steps until a record more than 15 min before sinceMs', () => {
    const size = 40 * MB
    // sinceMs = S - 2 min: needs a record older than S - 17 min. Offsets
    // probed: size - 256 KB - n MB, stamped S - (n + 0.25) min; the first
    // older than S - 17 min is n = 17 (a 4 MB step would land on 20 MB).
    expect(backscanStart(size, S - 2 * MIN, byOffset(size))).toEqual({ start: size - 262_144 - 17 * MB, truncated: false })
  })

  it('a record exactly 15 min before sinceMs does not stop the read; 1 ms older does', () => {
    const size = 10 * MB
    expect(backscanStart(size, S, () => S - 15 * MIN).start).toBe(0)
    expect(backscanStart(size, S, () => S - 15 * MIN - 1).start).toBe(size - 262_144)
  })

  it('an unreadable record time does not stop the read', () => {
    expect(backscanStart(5 * MB, S, () => null)).toEqual({ start: 0, truncated: false })
  })

  it('reads the whole file when it reaches the start first', () => {
    expect(backscanStart(3 * MB, S, () => S)).toEqual({ start: 0, truncated: false })
  })

  it('stops at 32 MB and reports truncated', () => {
    expect(backscanStart(100 * MB, S, () => S)).toEqual({ start: 100 * MB - 32 * MB, truncated: true })
  })

  it('an old enough record found exactly at the 32 MB limit stops the read there, not truncated', () => {
    expect(backscanStart(100 * MB, S, (off) => (off <= 68 * MB ? S - 16 * MIN : S))).toEqual({ start: 68 * MB, truncated: false })
  })

  it('a file of exactly 32 MB whose records are all recent is read whole, not truncated', () => {
    expect(backscanStart(32 * MB, S, () => S)).toEqual({ start: 0, truncated: false })
  })
})

describe('scanIngestion with sinceMs: more than 256 KB written after the ping', () => {
  const T = Date.parse('2026-10-01T10:00:00.000Z')
  const MIN = 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  // Stamped 4 KB assistant records, each followed by the timestamp-less
  // bookkeeping lines.
  const filler = (ms: number, bytes: number): string => {
    const line = JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } })
    const group = [line, ...BOOKKEEPING_LINES].join('\n')
    return Array.from({ length: Math.ceil(bytes / (group.length + 1)) }, () => group).join('\n') + '\n'
  }
  const pingLine = (ms: number) => JSON.stringify(REC.enqueue(iso(ms), pingBlock(iso(ms - 1000)))) + '\n'
  const write = (body: string): string => {
    const dir = tmpDir()
    writeFileSync(join(dir, 's.jsonl'), body, 'utf-8')
    return dir
  }

  it('finds a ping followed by 320 KB of output; the plain tail read does not', () => {
    const dir = write(filler(T - 30 * MIN, 64 * 1024) + pingLine(T) + filler(T + 1000, 320 * 1024))
    expect(scanIngestion(dir, T - 1000)).toEqual({ lastTs: T, lastProbeTs: T })
    expect(scanIngestion(dir)).toEqual({ lastTs: null, lastProbeTs: null })
    expect(readLastIngestionTimestampAcross([dir])).toBe(null)
  })

  it('finds a ping followed by 5 MB of output', () => {
    const dir = write(filler(T - 30 * MIN, 64 * 1024) + pingLine(T) + filler(T + 1000, 5 * 1024 * 1024))
    expect(scanIngestion(dir, T - 1000)).toEqual({ lastTs: T, lastProbeTs: T })
  })

  it('a ping stamped exactly at sinceMs is found behind 400 KB', () => {
    const dir = write(filler(T - 30 * MIN, 64 * 1024) + pingLine(T) + filler(T + 1000, 400 * 1024))
    expect(scanIngestion(dir, T).lastTs).toBe(T)
  })

  it('stops once it reaches records more than 15 min before sinceMs', () => {
    // An old ping, then 2 MB stamped 20 min before sinceMs, then 400 KB after.
    const dir = write(pingLine(T - 30 * MIN) + filler(T - 20 * MIN, 2 * 1024 * 1024) + filler(T, 400 * 1024))
    expect(scanIngestion(dir, T)).toEqual({ lastTs: null, lastProbeTs: null })
  })

  it('reads past records less than 15 min before sinceMs', () => {
    // The ping, then 2 MB stamped 10 min before sinceMs, then 400 KB after.
    const dir = write(filler(T - 30 * MIN, 64 * 1024) + pingLine(T - 12 * MIN) + filler(T - 10 * MIN, 2 * 1024 * 1024) + filler(T, 400 * 1024))
    expect(scanIngestion(dir, T).lastTs).toBe(T - 12 * MIN)
  })

  it('finds a ping after more than one step of old records, followed by 1.5 MB of output', () => {
    // The read stops mid-file, inside the old prefix, before the ping.
    const dir = write(filler(T - 60 * MIN, 3 * 1024 * 1024) + pingLine(T) + filler(T + 1000, 1536 * 1024))
    expect(scanIngestion(dir, T - 1000)).toEqual({ lastTs: T, lastProbeTs: T })
  })

  it('records longer than the 256 KB time-probe window do not make the read run to the cap', () => {
    const big = (ms: number, n: number): string => {
      const line = JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'text', text: 'y'.repeat(300 * 1024) }] } })
      return Array.from({ length: n }, () => line).join('\n') + '\n'
    }
    // 2.1 MB of 300 KB records stamped 30 min back, the ping, two more 300 KB records.
    const dir = write(big(T - 30 * MIN, 7) + pingLine(T) + big(T + 1000, 2))
    expect(scanIngestion(dir, T - 1000, 1536 * 1024)).toEqual({ lastTs: T, lastProbeTs: T })
  })

  it('uses the top-level record time, not an older nested "timestamp" field', () => {
    const nested = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(4000) }] }, toolUseResult: { timestamp: iso(T - 60 * MIN) }, timestamp: iso(T + 1000) })
    const body = Array.from({ length: Math.ceil((2 * 1024 * 1024) / (nested.length + 1)) }, () => nested).join('\n') + '\n'
    const dir = write(filler(T - 30 * MIN, 64 * 1024) + pingLine(T) + body)
    expect(scanIngestion(dir, T - 1000)).toEqual({ lastTs: T, lastProbeTs: T })
  })

  it('timestamp-less bookkeeping records at the read offsets do not keep the read going to the limit', () => {
    // 8 KB stamped records each followed by a file-history-snapshot line: at
    // most probed offsets the first whole line has no timestamp.
    const rec = (ms: number) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'text', text: 'z'.repeat(8000) }] } }) + '\n' + BOOKKEEPING_LINES[0] + '\n'
    const region = (ms: number, bytes: number) => rec(ms).repeat(Math.ceil(bytes / rec(ms).length))
    const dir = write(region(T - 60 * MIN, 3 * 1024 * 1024) + region(T + 1000, 400 * 1024))
    expect(scanIngestion(dir, T, 1024 * 1024)).toEqual({ lastTs: null, lastProbeTs: null })
  })

  it('a deaf transcript larger than the passed limit stops at the old records, not truncated', () => {
    // The probed offsets lie beyond 1 MB from the file start; the limit counts
    // from each offset, not from the start of the file.
    const dir = write(filler(T - 30 * MIN, 3 * 1024 * 1024) + filler(T + 1000, 400 * 1024))
    expect(scanIngestion(dir, T, 1024 * 1024)).toEqual({ lastTs: null, lastProbeTs: null })
  })

  it('marks the result truncated when the read limit is hit first', () => {
    const dir = write(pingLine(T) + filler(T + 1000, 3 * 1024 * 1024))
    expect(scanIngestion(dir, T - 1000, 1024 * 1024)).toEqual({ lastTs: null, lastProbeTs: null, truncated: true })
    expect(scanIngestionAcross([dir], T - 1000, 1024 * 1024).truncated).toBe(true)
    expect(scanIngestion(dir, T - 1000)).toEqual({ lastTs: T, lastProbeTs: T })
  })
})

// After a dashboard restart the arming latch starts empty. A deaf, silent hub
// last wrote its transcript before the current probes, so with a sinceMs the
// file would not count as "written since"; it is still the newest file and is
// read, and the ping it last heard re-arms the check.
describe('re-arming after a dashboard restart', () => {
  const pingAt = SIM_T0 + 2000
  const setup = (): string => {
    const dir = tmpDir()
    const f = join(dir, 'hub.jsonl')
    writeFileSync(f, JSON.stringify(REC.userString(new Date(pingAt).toISOString(), pingBlock(new Date(SIM_T0).toISOString()))) + '\n')
    setMtime(f, SIM_T0 + 3000)
    return dir
  }

  it('the newest file is read even when it was written before sinceMs', () => {
    expect(scanIngestion(setup(), SIM_T0 + I).lastProbeTs).toBe(pingAt)
  })

  it('a deaf, silent hub re-arms from the ping in its newest file and is respawned once', async () => {
    const dir = setup()
    let now = 0
    let state: ProbeLoopState = { tick: INITIAL_PROBE_TICK_STATE, lastInboundRespawn: 0, warnedAmbiguous: false }
    const restarts: number[] = []
    const deps: ProbeTickDeps = {
      now: () => now,
      sessionExists: () => true,
      readMarker: () => SIM_T0 + Math.floor((now - SIM_T0) / I) * I,
      transcriptDirs: () => [dir],
      scan: defaultProbeTickDeps.scan,
      countWriters: defaultProbeTickDeps.countWriters,
      loadState: () => state,
      saveState: (x) => { state = x },
      respawnSide: async () => ({ lastCrossPathRespawnAt: () => 0, paneState: () => 'idle', restart: () => { restarts.push(now); return { ok: true } } }),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    for (let k = 1; k <= 5; k++) {
      now = SIM_T0 + k * I + 1000
      await runInboundProbeTick(I, deps)
    }
    expect(restarts).toEqual([SIM_T0 + 3 * I + 1000])
  })
})

describe('defaultProbeTickDeps transcript readers', () => {
  it('scan reads an older file written since sinceMs, not only the newest one', () => {
    const dir = tmpDir('inbound-probe-deps-')
    const hub = join(dir, 'hub.jsonl')
    const sib = join(dir, 'sibling.jsonl')
    const pingAt = SIM_T0 + 10_000
    writeFileSync(hub, JSON.stringify({ type: 'user', timestamp: new Date(pingAt).toISOString(), message: { content: `${pingBlock(new Date(pingAt - 1000).toISOString())}` } }) + '\n')
    writeFileSync(sib, JSON.stringify({ type: 'assistant', timestamp: new Date(SIM_T0 + 20_000).toISOString(), message: { content: 'x' } }) + '\n')
    setMtime(hub, SIM_T0 + 10_000)
    setMtime(sib, SIM_T0 + 20_000)
    expect(defaultProbeTickDeps.scan([dir], SIM_T0)).toEqual({ lastTs: pingAt, lastProbeTs: pingAt })
  })

  it('countWriters counts top-level transcripts written since sinceMs, nothing else', () => {
    const dir = tmpDir('inbound-probe-deps-')
    for (const [name, ms] of [['a.jsonl', SIM_T0 + 5], ['b.jsonl', SIM_T0 - 5]] as const) {
      writeFileSync(join(dir, name), '{}\n')
      setMtime(join(dir, name), ms)
    }
    mkdirSync(join(dir, 'a', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'custom-title.json'), '{}')
    expect(defaultProbeTickDeps.countWriters([dir], SIM_T0)).toBe(1)
  })
})
