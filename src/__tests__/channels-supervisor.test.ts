import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPERVISOR_STUCK_MS, SUPERVISOR_WAIT_GAP_MS, etimeSeconds, freshSupervisor, launchdReloadVerdict, reloadWindowSec, runningChannelsSupervisors, supervisorWaitDecision, supervisorsFromPs } from '../web/channels-supervisor.js'

// CHANNELSDUP1023 (measured 2026-10-22 13:10): the hard restart read an unreadable pane after
// the launchd reload as "no effect" and launched a second channels.sh next to the one launchd
// had just started. These pin the supervisor detection and both call sites.
const SCRIPT = '/opt/inst/scripts/channels.sh'

describe('etimeSeconds', () => {
  it('reads every ps etime shape', () => {
    expect(etimeSeconds('00:07')).toBe(7)
    expect(etimeSeconds('17:44')).toBe(17 * 60 + 44)
    expect(etimeSeconds('09:01:11')).toBe(9 * 3600 + 61 + 10)
    expect(etimeSeconds('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
    expect(etimeSeconds('nonsense')).toBeNull()
  })
})

describe('supervisorsFromPs', () => {
  const ps = [
    `19392    09:01:11 /bin/bash ${SCRIPT}`,
    `82125    17:44:48 bash ${SCRIPT}`,
    `  555       00:03 /bin/bash ${SCRIPT} --resolve-main-model`,
    `  556       00:03 /bin/bash /other/install/scripts/channels.sh`,
    `  557       00:03 /bin/zsh -c source snap && eval 'grep ${SCRIPT}'`,
    `  558       00:03 /bin/bash /opt/inst/scripts/channel-watchdog.sh`,
    '',
  ].join('\n')

  it('counts the script run with no arguments, under bash or sh, as a supervisor', () => {
    expect(supervisorsFromPs(ps, SCRIPT)).toEqual([
      { pid: 19392, elapsedSec: 9 * 3600 + 71 },
      { pid: 82125, elapsedSec: 17 * 3600 + 44 * 60 + 48 },
    ])
  })

  it('never counts a seam call with arguments, another install, a shell that only names the path, or another script', () => {
    const pids = supervisorsFromPs(ps, SCRIPT).map((s) => s.pid)
    expect(pids).not.toContain(555)
    expect(pids).not.toContain(556)
    expect(pids).not.toContain(557)
    expect(pids).not.toContain(558)
  })
})

describe('freshSupervisor', () => {
  it('finds the one started within the window, and nothing when all are older', () => {
    const list = [{ pid: 1, elapsedSec: 3600 }, { pid: 2, elapsedSec: 9 }]
    expect(freshSupervisor(list, 12)).toEqual({ pid: 2, elapsedSec: 9 })
    expect(freshSupervisor(list, 5)).toBeNull()
    expect(freshSupervisor([], 100)).toBeNull()
  })
})


describe('launchdReloadVerdict', () => {
  it('a different pid in the pane is a rebuild', () => {
    expect(launchdReloadVerdict(75657, 80001, null)).toBe('rebuilt')
  })
  it('an unreadable pane with a supervisor started for this reload is a rebuild in progress (the 2026-10-22 13:10 case)', () => {
    expect(launchdReloadVerdict(75657, null, 76998)).toBe('rebuilding')
  })
  it('an unreadable pane with no fresh supervisor proves nothing, and neither does an unchanged pid', () => {
    expect(launchdReloadVerdict(75657, null, null)).toBe('none')
    expect(launchdReloadVerdict(6476, 6476, 76998)).toBe('none')
    expect(launchdReloadVerdict(null, null, 76998)).toBe('none')
    expect(launchdReloadVerdict(null, 70123, null)).toBe('none')
  })
})

describe('reloadWindowSec', () => {
  it('spans the time since the reload began, rounded up, plus one second', () => {
    expect(reloadWindowSec(1_000_000, 1_008_200)).toBe(10)
    expect(reloadWindowSec(1_000_000, 1_000_000)).toBe(1)
  })
})


describe('runningChannelsSupervisors when ps cannot run (Dani, #2203 review)', () => {
  it('answers an empty list, so a ps failure never blocks a recreate', () => {
    expect(runningChannelsSupervisors('/opt/inst/scripts/channels.sh', '/nonexistent/bin/ps')).toEqual([])
  })
})

describe('supervisorWaitDecision (#2203 follow-up: a supervisor is waited on, but not forever)', () => {
  const t0 = 1_000_000
  it('no supervisor: start one, and the wait is cleared', () => {
    expect(supervisorWaitDecision({ since: t0, lastSeen: t0 }, t0 + 1000, 0)).toEqual({ verdict: 'start', state: null })
  })
  it('a running supervisor is waited on while the session stays absent for less than the limit', () => {
    const first = supervisorWaitDecision(null, t0, 1)
    expect(first).toEqual({ verdict: 'wait', state: { since: t0, lastSeen: t0 } })
    const second = supervisorWaitDecision(first.state, t0 + 60_000, 1)
    expect(second.verdict).toBe('wait')
  })
  it('past the limit, one minute apart, it reads as stuck', () => {
    let st = supervisorWaitDecision(null, t0, 1).state
    for (let m = 1; m * 60_000 <= SUPERVISOR_STUCK_MS; m++) {
      const d = supervisorWaitDecision(st, t0 + m * 60_000, 1)
      expect(d.verdict).toBe('wait')
      st = d.state
    }
    expect(supervisorWaitDecision(st, t0 + SUPERVISOR_STUCK_MS + 1000, 1).verdict).toBe('stuck')
  })
  it('the limit is the recreate path\'s own cold-start grace (Marveen 42304)', () => {
    const monitor = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    const grace = Number(/const MAIN_SESSION_CREATE_GRACE_MS = ([\d_]+)/.exec(monitor)?.[1].replace(/_/g, ''))
    expect(SUPERVISOR_STUCK_MS).toBe(grace)
  })
  it('a gap longer than the poll means the earlier wait ended: a new one starts from zero', () => {
    const old = { since: t0, lastSeen: t0 + 60_000 }
    const later = t0 + 60_000 + SUPERVISOR_WAIT_GAP_MS + 1
    expect(supervisorWaitDecision(old, later, 1)).toEqual({ verdict: 'wait', state: { since: later, lastSeen: later } })
  })
})

describe('runningChannelsSupervisors on a real process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chansup-'))
  const script = join(dir, 'channels.sh')
  writeFileSync(script, '#!/bin/bash\nsleep 30\n', { mode: 0o755 })
  const kids: ChildProcess[] = []
  afterAll(() => {
    for (const k of kids) { try { k.kill('SIGKILL') } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  it('sees a bash supervisor of this script, freshly started, and not a seam call of it', async () => {
    const sup = spawn('/bin/bash', [script], { stdio: 'ignore' })
    const seam = spawn('/bin/bash', [script, '--resolve-main-model'], { stdio: 'ignore' })
    kids.push(sup, seam)
    await new Promise((r) => setTimeout(r, 300))
    const found = runningChannelsSupervisors(script)
    expect(found.map((s) => s.pid)).toEqual([sup.pid])
    expect(freshSupervisor(found, 5)?.pid).toBe(sup.pid)
  })
})

describe('the two call sites in channel-monitor.ts', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const fn = (name: string) => {
    const a = src.indexOf(`export function ${name}`)
    expect(a, name).toBeGreaterThan(0)
    const b = src.indexOf('\nexport function ', a + 10)
    const c = src.indexOf('\nfunction ', a + 10)
    const end = [b, c].filter((x) => x > a).sort((x, y) => x - y)[0]
    return src.slice(a, end)
  }

  it('createMainChannelsSession asks for a running supervisor before it spawns, and leaves it alone', () => {
    const body = fn('createMainChannelsSession')
    const check = body.indexOf('runningChannelsSupervisors(CHANNELS_SCRIPT)')
    const spawnAt = body.indexOf('spawn(')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(spawnAt)
    expect(body.slice(check, spawnAt)).toMatch(/supervisorWaitDecision\(supervisorWait, now, live\.length\)/)
  })

  it('createMainChannelsSession tells the owner about a stuck supervisor and still starts no second one', () => {
    const body = fn('createMainChannelsSession')
    const decide = body.indexOf('supervisorWaitDecision(supervisorWait, now, live.length)')
    const spawnAt = body.indexOf('spawn(')
    expect(decide).toBeGreaterThan(0)
    expect(decide).toBeLessThan(spawnAt)
    // The wait is kept across ticks; without it every tick starts from zero and nothing is ever stuck.
    expect(body.slice(decide, decide + 120)).toMatch(/\n\s*supervisorWait = wait\.state\n/)
    // Each branch is cut out up to its OWN closing brace (Dani's #2204 review: lazy regexes let
    // a guarded alert and a stuck branch without its return pass on the wait branch's text).
    const block = (head: string) => {
      const a = body.indexOf(head)
      expect(a, head).toBeGreaterThan(decide)
      const b = body.indexOf('\n  }\n', a)
      expect(b).toBeLessThan(spawnAt)
      return body.slice(a + head.length, b).split('\n').map((l) => l.trim()).filter(Boolean)
    }
    const stuck = block("if (wait.verdict === 'stuck') {")
    expect(stuck[0]).toMatch(/^logger\.error\(/)
    // Owner-action alert (Szotasz/marveen#2353 review): this branch starts
    // nothing, so it must stay off the NOTIFY_ROUTINE_ALERTS-gated path.
    expect(stuck.some((l) => /^sendOwnerActionAlert\('main-session-supervisor-stuck', /.test(l))).toBe(true)
    expect(stuck.some((l) => /^sendRoutineAlert\(/.test(l))).toBe(false)
    expect(stuck[stuck.length - 1]).toBe("return 'grace'")
    expect(stuck).toHaveLength(6)
    const waitLines = block("if (wait.verdict === 'wait') {")
    expect(waitLines[waitLines.length - 1]).toBe("return 'grace'")
    expect(waitLines).toHaveLength(2)
  })

  it('hardRestartMarveenChannels takes a fresh supervisor as the effect when the pane is unreadable, before the fall-through', () => {
    const body = fn('hardRestartMarveenChannels')
    const reloadAt = body.indexOf('const reloadAt = Date.now()')
    const unload = body.indexOf("'unload'")
    const fresh = body.indexOf('freshSupervisor(runningChannelsSupervisors(CHANNELS_SCRIPT), reloadWindowSec(reloadAt, Date.now()))')
    const fallThrough = body.indexOf('falling through to respawn-pane')
    expect(reloadAt).toBeGreaterThan(0)
    expect(reloadAt).toBeLessThan(unload)
    expect(fresh).toBeGreaterThan(unload)
    expect(fresh).toBeLessThan(fallThrough)
    expect(body.slice(fresh - 200, fresh)).toContain('if (pidBefore !== null && pidAfter === null)')
    expect(body.slice(fresh, fallThrough)).toMatch(/if \(launchdReloadVerdict\(pidBefore, pidAfter, fresh\?\.pid \?\? null\) === 'rebuilding'\) \{[\s\S]*?return \{ ok: true \}/)
  })
})
