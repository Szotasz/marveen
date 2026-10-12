import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyRespawnStampAdvance } from '../channel-coordinator/liveness.js'

// SOAKRESPAWN819: a main-session respawn performed by anyone but the dashboard
// (service-manager relaunch of channels.sh after a watchdog exit, the
// systemd-timer channel-watchdog, a manual launch) used to be structurally
// silent in dashboard.log -- the respawn stamp is a suppression contract, so
// the evidence of the respawn quieted the watchers instead of surfacing.
// Measured live on the hermes soak box 2026-08-19: 210 service-manager
// restarts at a ~40min cadence, zero dashboard.log lines.
//
// Two halves close the gap:
//   consumer -- channel-monitor logs every stamp advance it cannot attribute
//               to a dashboard-initiated respawn (THAT it happened);
//   producer -- channels.sh mirrors its watchdog-exit WARNs into
//               store/channels-respawn.log (WHY it happened).

const GRACE = 360_000

describe('classifyRespawnStampAdvance (pure)', () => {
  const base = { lastSeenStampMs: 1_000_000, graceMs: GRACE }

  it('no advance -> none', () => {
    expect(classifyRespawnStampAdvance({ ...base, stampMs: 1_000_000, lastSelfRespawnMs: 0 })).toBe('none')
    expect(classifyRespawnStampAdvance({ ...base, stampMs: 999_000, lastSelfRespawnMs: 0 })).toBe('none')
  })

  it('missing/garbage stamp (0) -> none, never external', () => {
    expect(classifyRespawnStampAdvance({ ...base, stampMs: 0, lastSelfRespawnMs: 0 })).toBe('none')
  })

  it('advance within grace of a dashboard-initiated respawn -> self (channels.sh writes the stamp on OUR launches too)', () => {
    const selfAt = 2_000_000
    // channels.sh stamps ~35-90s after the dashboard's own write during a
    // dashboard-initiated hard restart; both sides of the window fold to self.
    expect(classifyRespawnStampAdvance({ ...base, stampMs: selfAt + 90_000, lastSelfRespawnMs: selfAt })).toBe('self')
    expect(classifyRespawnStampAdvance({ ...base, stampMs: selfAt - 5_000, lastSelfRespawnMs: selfAt })).toBe('self')
    expect(classifyRespawnStampAdvance({ ...base, stampMs: selfAt + GRACE, lastSelfRespawnMs: selfAt })).toBe('self')
  })

  it('advance with no dashboard respawn nearby -> external', () => {
    expect(classifyRespawnStampAdvance({ ...base, stampMs: 2_000_000, lastSelfRespawnMs: 0 })).toBe('external')
    expect(classifyRespawnStampAdvance({ ...base, stampMs: 2_000_000, lastSelfRespawnMs: 2_000_000 - GRACE - 1 })).toBe('external')
  })

  it('the 40-min churn cadence classifies external on every cycle (regression shape of the live finding)', () => {
    // Steady state on a never-starting-plugin host: a fresh stamp every
    // ~2415s with the dashboard never initiating any of them.
    let lastSeen = 1_000_000
    const selfRespawn = 0
    for (let i = 1; i <= 3; i++) {
      const stampMs = 1_000_000 + i * 2_415_000
      expect(classifyRespawnStampAdvance({ stampMs, lastSeenStampMs: lastSeen, lastSelfRespawnMs: selfRespawn, graceMs: GRACE })).toBe('external')
      lastSeen = stampMs
    }
  })
})

// --- wiring contract (static): the halves must stay connected ---

const ROOT = join(__dirname, '..', '..')
const MONITOR = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')

describe('external-respawn wiring contract', () => {
  it('channel-monitor runs the detector every sweep and records self stamp writes', () => {
    expect(MONITOR).toMatch(/checkExternalMainRespawn\(\)/)
    // The self-write MUST be recorded inside writeRespawnStamp, or every
    // dashboard-initiated respawn would be misreported as external.
    // Slice to the FUNCTION's own closing brace (same idiom as sliceShellFn
    // below) -- an earlier version sliced to the first brace AFTER the sought
    // string, an ever-growing window that could not fail (Marveen's mutation
    // probe on 331b7d2d: assignment moved out of the function, test stayed
    // green). Verified red against that same mutation after this fix.
    const start = MONITOR.indexOf('function writeRespawnStamp')
    expect(start).toBeGreaterThanOrEqual(0)
    const writeFn = MONITOR.slice(start, MONITOR.indexOf('\n}', start))
    expect(writeFn).toMatch(/lastSelfStampWriteMs = Date\.now\(\)/)
  })

  it('boot baseline: the first observation seeds lastSeen and must not warn', () => {
    const det = MONITOR.slice(MONITOR.indexOf('function checkExternalMainRespawn'))
    const firstReturn = det.indexOf('return')
    expect(det.slice(0, firstReturn)).toMatch(/lastSeenRespawnStampMs = stampMs/)
  })

  it('channels.sh mirrors BOTH watchdog-exit reasons into store/channels-respawn.log', () => {
    expect(CHANNELS).toMatch(/respawn_log "never-started:/)
    expect(CHANNELS).toMatch(/respawn_log "died-after-up:/)
    expect(CHANNELS).toMatch(/channels-respawn\.log/)
  })
})

// --- runnable probe: respawn_log writes, appends, and trims ---

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

describe('channels.sh respawn_log (runnable)', () => {
  it('appends timestamped lines and trims past 1000 to the newest 500', () => {
    const dir = mkdtempSync(join(tmpdir(), 'respawnlog-'))
    const logPath = join(dir, 'channels-respawn.log')
    const body = [
      '#!/bin/bash',
      `CHANNELS_RESPAWN_LOG="${logPath}"`,
      sliceShellFn(CHANNELS, 'respawn_log'),
      'respawn_log "never-started: probe line one"',
      'respawn_log "died-after-up: probe line two"',
      // Inflate past the cap, then one more call must trigger the trim.
      `for i in $(seq 1 1100); do echo "filler $i" >> "${logPath}"; done`,
      'respawn_log "never-started: post-cap line"',
    ].join('\n')
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    execFileSync('bash', [p], { encoding: 'utf-8' })

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    // Trimmed to the newest 500, and the newest entry survived the trim.
    expect(lines.length).toBeLessThanOrEqual(500)
    expect(lines[lines.length - 1]).toMatch(/never-started: post-cap line/)
    // Timestamp prefix on real entries (YYYY-MM-DD HH:MM:SS).
    expect(lines[lines.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /)
  })

  it('a failing log write never breaks the caller (best-effort contract)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'respawnlog-'))
    const body = [
      '#!/bin/bash',
      // Unwritable target: parent dir does not exist.
      `CHANNELS_RESPAWN_LOG="${join(dir, 'nope', 'x.log')}"`,
      sliceShellFn(CHANNELS, 'respawn_log'),
      'respawn_log "never-started: into the void"',
      'echo SURVIVED',
    ].join('\n')
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    const out = execFileSync('bash', [p], { encoding: 'utf-8' })
    expect(out).toMatch(/SURVIVED/)
  })
})
