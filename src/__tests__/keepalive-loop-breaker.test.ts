import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  decideKeepaliveLoop, releaseKeepaliveLoop, keepaliveProducerAdvanced, keepaliveProducerRemedy, keepaliveHoldReason,
  KEEPALIVE_LOOP_INITIAL, KEEPALIVE_USELESS_RESPAWN_LIMIT, type KeepaliveLoopState,
} from '../web/channel-monitor.js'

// KEEPALIVELOOP923. 2026-09-23: the keepalive producer hung, the file stayed
// stale with a LIVE poller, and the keepalive path respawned a healthy main
// session 28 times in one morning. A respawn cannot fix a dead producer, so
// after KEEPALIVE_USELESS_RESPAWN_LIMIT useless respawns the monitor must hold
// and alert once.
//
// ISSUE1891 (b): "useless" and "released" are judged by the PRODUCER's own
// stamp, never by store/.channel-keepalive, which has other writers (channels.sh
// whenever it starts the session, and inbound traffic). The probe writes two
// stamps: .channel-keepalive-produced only next to its keepalive touch (the
// breaker trusts this one), and .channel-keepalive-probe at the start of every
// run (only the alert's wording). Review of #1919: with the probe's own
// self-timeout a hung run still writes the run stamp every cycle, so a breaker
// judged by the run stamp would never hold in the 2026-09-23 shape. The
// functions below take no keepalive mtime; the call site is pinned.

const ALIVE = { pollerAlive: true }

// One stale tick at the call site: release first (as checkMainKeepaliveStaleness
// does before its early returns), then the verdict.
function staleTick(state: KeepaliveLoopState, obs: { pollerAlive: boolean; producerMtimeMs: number | null; runMtimeMs?: number | null }) {
  const rel = releaseKeepaliveLoop(state, obs.producerMtimeMs)
  const d = decideKeepaliveLoop(rel.state, obs)
  return { state: d.state, decision: d.decision, released: rel.released }
}

describe('decideKeepaliveLoop: judged by the producer stamp', () => {
  it('respawns on the first stale tick (no earlier respawn to judge) and records the producer as the baseline', () => {
    const r = decideKeepaliveLoop(KEEPALIVE_LOOP_INITIAL, { ...ALIVE, producerMtimeMs: 500 })
    expect(r.decision).toBe('respawn')
    expect(r.state).toEqual({ uselessRespawns: 0, producerAtLastRespawn: 500, runAtLastRespawn: null, respawned: true, alerted: false })
  })

  it('#1891: the probe never runs (no stamp), each respawn touches the keepalive -- two respawns, one alert, then silence', () => {
    let state = { ...KEEPALIVE_LOOP_INITIAL }
    const decisions: string[] = []
    for (let tick = 0; tick < 8; tick++) {
      // channels.sh touches store/.channel-keepalive here on every respawn, and
      // inbound traffic warms it; neither reaches these functions.
      const r = staleTick(state, { ...ALIVE, producerMtimeMs: null })
      decisions.push(r.decision)
      expect(r.released).toBe(false)
      state = r.state
    }
    expect(decisions).toEqual(['respawn', 'respawn', 'hold-and-alert', 'hold', 'hold', 'hold', 'hold', 'hold'])
  })

  it('2026-09-23 with the self-timeout: every run STARTS (run stamp moves each tick) but none produces -- still two respawns, one alert, then silence', () => {
    let state = { ...KEEPALIVE_LOOP_INITIAL }
    const decisions: string[] = []
    const reasons: string[] = []
    for (let tick = 0; tick < 6; tick++) {
      const run = 10_000 + tick * 180_000
      reasons.push(keepaliveHoldReason(state, run))
      const r = staleTick(state, { ...ALIVE, producerMtimeMs: 1000, runMtimeMs: run })
      decisions.push(r.decision)
      expect(r.released).toBe(false)
      state = r.state
    }
    expect(decisions).toEqual(['respawn', 'respawn', 'hold-and-alert', 'hold', 'hold', 'hold'])
    expect(reasons[2]).toBe('not-producing') // the alert points at the log, not at starting the job
  })

  it('the alert wording: no run stamp, or one that did not move since the respawn, is "not running"', () => {
    const afterRespawn = decideKeepaliveLoop(KEEPALIVE_LOOP_INITIAL, { ...ALIVE, producerMtimeMs: null, runMtimeMs: 5000 }).state
    expect(keepaliveHoldReason(afterRespawn, null)).toBe('not-running')
    expect(keepaliveHoldReason(afterRespawn, 5000)).toBe('not-running')
    expect(keepaliveHoldReason(afterRespawn, 5180)).toBe('not-producing')
  })

  it('2026-09-23: a hung producer (stamp frozen) -- the same two respawns, one alert, then silence', () => {
    let state = { ...KEEPALIVE_LOOP_INITIAL }
    const decisions: string[] = []
    for (let tick = 0; tick < 5; tick++) {
      const r = staleTick(state, { ...ALIVE, producerMtimeMs: 1000 })
      decisions.push(r.decision)
      state = r.state
    }
    expect(decisions).toEqual(['respawn', 'respawn', 'hold-and-alert', 'hold', 'hold'])
  })

  it('a producer that ran between respawns keeps the count at zero', () => {
    let state = { ...KEEPALIVE_LOOP_INITIAL }
    for (const producer of [1000, 2000, 3000, 4000]) {
      const r = staleTick(state, { ...ALIVE, producerMtimeMs: producer })
      expect(r.decision).toBe('respawn')
      expect(r.state.uselessRespawns).toBe(0)
      state = r.state
    }
  })

  it('a stamp that appears after a respawn without one counts as the producer starting', () => {
    const first = decideKeepaliveLoop(KEEPALIVE_LOOP_INITIAL, { ...ALIVE, producerMtimeMs: null }).state
    expect(keepaliveProducerAdvanced(first, null)).toBe(false)
    expect(keepaliveProducerAdvanced(first, 1000)).toBe(true)
  })

  it('never holds back when the poller is dead (real deafness), even while alerted', () => {
    const held: KeepaliveLoopState = { uselessRespawns: 5, producerAtLastRespawn: 1000, runAtLastRespawn: null, respawned: true, alerted: true }
    const r = decideKeepaliveLoop(held, { pollerAlive: false, producerMtimeMs: 1000 })
    expect(r.decision).toBe('respawn')
    expect(r.state.uselessRespawns).toBe(0)
  })
})

describe('releaseKeepaliveLoop: only the producer releases a held breaker', () => {
  const held: KeepaliveLoopState = { uselessRespawns: 2, producerAtLastRespawn: 1000, runAtLastRespawn: null, respawned: true, alerted: true }

  it('the producer stamp moved since the last respawn: released, once, back to the initial state', () => {
    const r = releaseKeepaliveLoop(held, 1180)
    expect(r).toEqual({ state: KEEPALIVE_LOOP_INITIAL, released: true })
    expect(releaseKeepaliveLoop(r.state, 1360).released).toBe(false) // not alerted any more: nothing to release
  })

  it('the stamp did not move (or is missing): stays held, whatever the keepalive file did', () => {
    expect(releaseKeepaliveLoop(held, 1000)).toEqual({ state: held, released: false })
    expect(releaseKeepaliveLoop(held, null)).toEqual({ state: held, released: false })
  })

  it('a held breaker over hours of channels.sh touches and inbound traffic says nothing more, then releases on the first probe run', () => {
    let state: KeepaliveLoopState = { ...held }
    const events: string[] = []
    for (let tick = 0; tick < 12; tick++) {
      const producer = tick < 10 ? 1000 : 1000 + tick * 180
      const r = staleTick(state, { ...ALIVE, producerMtimeMs: producer })
      events.push(r.released ? 'released' : r.decision)
      state = r.state
    }
    expect(events).toEqual([...Array(10).fill('hold'), 'released', 'respawn'])
  })
})

describe('keepaliveProducerRemedy: the alert names the job and the command', () => {
  it('macOS: the launchd job, bootstrap + kickstart in gui/<uid>', () => {
    expect(keepaliveProducerRemedy('darwin', 'hex', 501, '/Users/h')).toEqual({
      job: 'com.hex.channel-keepalive-probe (launchd)',
      command: 'launchctl bootstrap gui/501 "/Users/h/Library/LaunchAgents/com.hex.channel-keepalive-probe.plist" 2>/dev/null; launchctl kickstart gui/501/com.hex.channel-keepalive-probe',
    })
  })
  it('Linux: the user timer, enable --now', () => {
    expect(keepaliveProducerRemedy('linux', 'hex', 1000, '/home/h')).toEqual({
      job: 'hex-channel-keepalive-probe.timer (systemd --user)',
      command: 'systemctl --user enable --now hex-channel-keepalive-probe.timer',
    })
  })
})

describe('the call site (checkMainKeepaliveStaleness) is bound to the producer stamp', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  const start = src.indexOf('function checkMainKeepaliveStaleness')
  const body = src.slice(start, src.indexOf('\nexport function sendAlert', start))

  it('reads the PRODUCED stamp for the breaker; the run stamp only words the alert', () => {
    expect(src).toContain("const KEEPALIVE_PRODUCER_STAMP = join(PROJECT_ROOT, 'store', '.channel-keepalive-produced')")
    expect(src).toContain("const KEEPALIVE_RUN_STAMP = join(PROJECT_ROOT, 'store', '.channel-keepalive-probe')")
    expect(src).toMatch(/function readProducerStampMtime\(\)[^}]*KEEPALIVE_PRODUCER_STAMP/)
    expect(body).toContain('const producerMtimeMs = readProducerStampMtime()')
    expect(body).toContain('releaseKeepaliveLoop(keepaliveLoop, producerMtimeMs)')
    expect(body).toContain('decideKeepaliveLoop(keepaliveLoop, { pollerAlive, producerMtimeMs, runMtimeMs })')
    expect(body).toContain('keepaliveHoldReason(keepaliveLoop, runMtimeMs)')
    expect(body).not.toMatch(/keepaliveMtime/)
  })

  it('checks the release before the live-poller shortcut can return', () => {
    const rel = body.indexOf('releaseKeepaliveLoop(')
    const shortcut = body.indexOf('hasChannelPluginAlive(')
    expect(rel).toBeGreaterThan(0)
    expect(shortcut).toBeGreaterThan(rel)
  })

  it('the hold alert names the job and, by the reason, the start command or the log; the release is said once', () => {
    expect(body).toContain('keepaliveProducerRemedy(process.platform, SERVICE_ID,')
    expect(body).toContain('A jelző: ${fix.job}.')
    expect(body).toMatch(/holdReason === 'not-running'\s*\?[^:]*Indítsd el: \$\{fix\.command\}/)
    expect(body).toContain('store/channel-keepalive-probe.log')
    expect(body).toMatch(/if \(rel\.released\) \{[\s\S]{0,200}sendAlert\(/)
  })
})

describe('scripts/channel-keepalive-probe.sh: a run stamp on every run, a produced stamp only when it produced', () => {
  // The real script, copied into a throwaway install (it derives its store from its
  // own location), with PATH stubs; nothing here reaches this machine's tmux or launchd.
  function install(tmux: string | null): { dir: string; run: (env?: Record<string, string>) => number } {
    const dir = mkdtempSync(join(tmpdir(), 'ka-probe-'))
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'store')); mkdirSync(join(dir, 'bin'))
    copyFileSync(join(__dirname, '..', '..', 'scripts', 'channel-keepalive-probe.sh'), join(dir, 'scripts', 'channel-keepalive-probe.sh'))
    if (tmux !== null) {
      writeFileSync(join(dir, 'bin', 'tmux'), `#!/bin/sh\n${tmux}\n`)
      chmodSync(join(dir, 'bin', 'tmux'), 0o755)
    }
    const run = (env: Record<string, string> = {}) => {
      try {
        execFileSync('/bin/bash', [join(dir, 'scripts', 'channel-keepalive-probe.sh')], {
          // stdio ignored: a hung stub child would otherwise hold the pipe open past the probe's own kill.
          env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir, PROBE_TIMEOUT_S: '20', ...env }, stdio: 'ignore',
        })
        return 0
      } catch (e) {
        return (e as { status?: number }).status ?? -1
      }
    }
    return { dir, run }
  }
  const stamp = (dir: string, name: string) => join(dir, 'store', name)

  it.each([
    ['tmux missing', null],
    ['the session absent', '[ "$1" = has-session ] && exit 1; exit 1'],
  ] as const)('%s: the probe exits early with the run stamp only -- not produced, no keepalive', (_n, tmux) => {
    const { dir, run } = install(tmux)
    try {
      expect(run()).toBe(0)
      expect(readFileSync(stamp(dir, '.channel-keepalive-probe'), 'utf-8').trim()).toMatch(/^\d{10}$/)
      expect(existsSync(stamp(dir, '.channel-keepalive-produced'))).toBe(false)
      expect(existsSync(stamp(dir, '.channel-keepalive'))).toBe(false)
      // A second run moves the run stamp (set it back first: a 1 s mtime resolution would hide the move).
      utimesSync(stamp(dir, '.channel-keepalive-probe'), new Date(1_000_000_000), new Date(1_000_000_000))
      run()
      expect(statSync(stamp(dir, '.channel-keepalive-probe')).mtimeMs).toBeGreaterThan(1_000_000_000_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a run that hangs and is killed by its own timeout (2026-09-23): run stamp yes, produced no', () => {
    const { dir, run } = install('[ "$1" = has-session ] && sleep 6; exit 1')
    try {
      expect(run({ PROBE_TIMEOUT_S: '1' })).not.toBe(0)
      expect(existsSync(stamp(dir, '.channel-keepalive-probe'))).toBe(true)
      expect(existsSync(stamp(dir, '.channel-keepalive-produced'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('FLAKEKEEPALIVE1016: a normal run does not die of its own watchdog when the watchdog gets the CPU inside the EXIT trap', () => {
    // The EXIT trap kills the watchdog's sleep, then the watchdog. A pkill that
    // lingers 0.3 s after signalling hands the watchdog that gap on purpose --
    // the scheduling CI produced at random. Before the fix every such run ended
    // in the probe's own SIGTERM (status null) and a false "exceeded" WARN.
    const { dir, run } = install('[ "$1" = has-session ] && exit 1; exit 1')
    try {
      writeFileSync(join(dir, 'bin', 'pkill'), '#!/bin/sh\n/usr/bin/pkill "$@"; rc=$?; sleep 0.3; exit $rc\n')
      chmodSync(join(dir, 'bin', 'pkill'), 0o755)
      for (let i = 0; i < 3; i++) expect(run()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('a run that finds a live poller under the pane: keepalive touched and BOTH stamps written', async () => {
    const dir0 = mkdtempSync(join(tmpdir(), 'ka-poller-'))
    mkdirSync(join(dir0, 'telegram'))
    writeFileSync(join(dir0, 'telegram', 'poller.js'), 'setTimeout(() => {}, 30000)\n')
    // The "pane": a bash whose child is a node process with /telegram/ in its command line.
    const pane = spawn('/bin/bash', ['-c', `${process.execPath} ${join(dir0, 'telegram', 'poller.js')}; true`], { stdio: 'ignore' })
    // Wait until the poller child really exists under the pane (a fixed 500 ms
    // was a bet on CI scheduling), up to 10 s.
    for (let i = 0; i < 100; i++) {
      let kids = ''
      try { kids = execFileSync('/usr/bin/pgrep', ['-P', String(pane.pid)], { encoding: 'utf-8' }) } catch { /* none yet */ }
      if (kids.trim()) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const { dir, run } = install(`case "$1" in has-session) exit 0 ;; list-panes) echo ${pane.pid}; exit 0 ;; esac; exit 1`)
    try {
      expect(run()).toBe(0)
      expect(existsSync(stamp(dir, '.channel-keepalive'))).toBe(true)
      expect(existsSync(stamp(dir, '.channel-keepalive-probe'))).toBe(true)
      expect(readFileSync(stamp(dir, '.channel-keepalive-produced'), 'utf-8').trim()).toMatch(/^\d{10}$/)
    } finally {
      pane.kill('SIGKILL')
      try { execFileSync('/usr/bin/pkill', ['-f', join(dir0, 'telegram', 'poller.js')]) } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true })
      rmSync(dir0, { recursive: true, force: true })
    }
  }, 20_000)
})
