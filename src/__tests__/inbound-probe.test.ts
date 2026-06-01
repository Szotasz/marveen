import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldTriggerDeafnessRespawn, readLastIngestionTimestamp } from '../web/inbound-probe.js'

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
