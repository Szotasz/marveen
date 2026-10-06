// Card 35ea0375: the channel reapers signal only processes of the dashboard's
// own uid, and log each signal's outcome by kind.
//
// Measured case: the process tables are host-wide, so a detached
// `claude --channels` of ANOTHER user on the same host passed the orphan test.
// Its SIGTERM failed with EPERM, the catch took that for "already gone", and the
// log said "killed" for the same pids every cycle while they lived on.
//
// Two layers:
//   1. pure: splitByOwner, sendSignal and terminatePids with stubbed owners and
//      signals (EPERM on each step, ESRCH, a SIGTERM that ends the process, a
//      survivor that gets SIGKILL); the owner lookup through /proc and through
//      the `ps -o uid=` fallback;
//   2. real processes against a fake tmux (as in the live-pane test): an
//      own-uid poller is still reaped (positive control); the same
//      kind of poller, reported as another uid's through the owner seam, is
//      spared, counted once and never logged as killed; a refused signal (EPERM
//      through the kill seam) is not "killed" either. A process of another user
//      cannot be started without root, so the owner and the refusal come through
//      the seams; the decisions are the production code's.
// reapForeignMainPollers is held by the pure layer only: it takes no needle, so a
// real-process test on a shared host could reach a live main poller of the same user.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  splitByOwner,
  sendSignal,
  terminatePids,
  processOwnerUid,
  reapChannelOrphans,
  reapDetachedChannelClaudes,
  type KillFn,
} from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

const errno = (code: string) => Object.assign(new Error(code), { code })
const noPause = () => {}

describe('35ea0375 pure: the owner split and the signal outcome', () => {
  it('only the own uid is signalled; another uid and an unreadable owner are skipped', () => {
    const owners: Record<number, number | null> = { 101: 1000, 102: 1001, 103: null }
    expect(splitByOwner([101, 102, 103], 1000, (pid) => owners[pid] ?? null))
      .toEqual({ own: [101], foreign: [102], unknown: [103] })
    // no uid on the platform: nothing is ours
    expect(splitByOwner([101], null, () => 1000)).toEqual({ own: [], foreign: [], unknown: [101] })
  })

  it('reads the real owner of this process, and null for a pid that cannot exist', () => {
    expect(processOwnerUid(process.pid)).toBe(process.getuid?.())
    expect(processOwnerUid(2 ** 22 + 12345)).toBeNull()
  })

  it('the ps fallback (a host without /proc, e.g. macOS) reads the same owner, and null for a missing pid', () => {
    expect(processOwnerUid(process.pid, false)).toBe(process.getuid?.())
    expect(processOwnerUid(2 ** 22 + 12345, false)).toBeNull()
  })

  it('classifies one signal: ok, ESRCH, EPERM, other', () => {
    expect(sendSignal(1, 0, () => {})).toBe('ok')
    expect(sendSignal(1, 0, () => { throw errno('ESRCH') })).toBe('ESRCH')
    expect(sendSignal(1, 0, () => { throw errno('EPERM') })).toBe('EPERM')
    expect(sendSignal(1, 0, () => { throw errno('EINVAL') })).toBe('other')
  })

  it('an EPERM is never counted as killed: on the SIGTERM, on the probe, or on the SIGKILL', () => {
    let paused = 0
    const refused: KillFn = () => { throw errno('EPERM') }
    expect(terminatePids([7001], { kill: refused, pause: () => { paused++ } }))
      .toEqual({ killed: [], alreadyGone: [], permissionDenied: [7001], failed: [] })
    expect(paused).toBe(0) // nothing was delivered, so no grace period
    const probeRefused: KillFn = (_pid, signal) => { if (signal === 0) throw errno('EPERM') }
    expect(terminatePids([7002], { kill: probeRefused, pause: noPause }))
      .toEqual({ killed: [], alreadyGone: [], permissionDenied: [7002], failed: [] })
    const sigkillRefused: KillFn = (_pid, signal) => { if (signal === 'SIGKILL') throw errno('EPERM') }
    expect(terminatePids([7003], { kill: sigkillRefused, pause: noPause }))
      .toEqual({ killed: [], alreadyGone: [], permissionDenied: [7003], failed: [] })
  })

  it('killed = a signal of ours reached it: gone after SIGTERM, or SIGKILL delivered; ESRCH first is already gone', () => {
    const alive = new Set([8001, 8002])
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    const kill: KillFn = (pid, signal) => {
      sent.push([pid, signal])
      if (pid === 8003) throw errno('ESRCH') // gone before we signalled
      if (signal === 'SIGTERM' && pid === 8001) { alive.delete(pid); return } // exits on SIGTERM
      if (signal === 0 && !alive.has(pid)) throw errno('ESRCH')
      if (signal === 'SIGKILL') alive.delete(pid)
    }
    expect(terminatePids([8001, 8002, 8003], { kill, pause: noPause }))
      .toEqual({ killed: [8001, 8002], alreadyGone: [8003], permissionDenied: [], failed: [] })
    expect(sent).toContainEqual([8002, 'SIGKILL'])
    expect(sent).not.toContainEqual([8001, 'SIGKILL'])
  })
})

// ---------------------------------------------------------------------------
// Real processes, fake tmux. A real tmux server is never touched.
const tmp = mkdtempSync(join(tmpdir(), 'reap-own-uid-'))
const agentDir = join(tmp, 'agent')
const chanDir = channelStateDir('telegram', agentDir)
mkdirSync(chanDir, { recursive: true })
const fakeTmux = join(tmp, 'fake-tmux')
const kids: number[] = []

function spawnWithEnv(cmd: string, args: string[], env: Record<string, string>): number {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...env } })
  p.unref()
  kids.push(p.pid!)
  return p.pid!
}
// bot.pid names it, so the runtime check of the env scan does not apply (a `sleep` stands in for the poller);
// it carries the plugin marker, as a real poller does, because both candidate sources require it (cf075d41).
const pluginRoot = join(tmp, 'plugins', 'cache', 'official', 'telegram', '0.0.1')
const poller = () => spawnWithEnv('/bin/sleep', ['300'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
function fakeTmuxPrints(body: string): void {
  writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`)
  chmodSync(fakeTmux, 0o755)
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const myUid = process.getuid!()
const otherUid = myUid + 1
const loggedKilled = (spy: { mock: { calls: unknown[][] } }, msg: string, pid: number) =>
  spy.mock.calls.some(([obj, m]) => m === msg && ((obj as { reaped?: number[] }).reaped ?? []).includes(pid))

afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('35ea0375 reapChannelOrphans on real processes', () => {
  it('positive control: an own-uid poller is reaped, logged as killed with the outcome by kind', async () => {
    const p = poller(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(p))
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(800)
    expect(r.reaped).toContain(p)
    expect(alive(p)).toBe(false)
    expect(r.skippedOtherUid).toEqual([])
    expect(loggedKilled(info, 'channel-poller-reap: orphans killed', p)).toBe(true)
    const line = info.mock.calls.find(([, m]) => m === 'channel-poller-reap: orphans killed')
    expect((line?.[0] as { outcome?: unknown }).outcome).toMatchObject({ ok: 1, ESRCH: 0, EPERM: 0, other: 0 })
    info.mockRestore()
  })

  it('a poller owned by another uid is spared, counted once, and never logged as killed', async () => {
    const p = poller(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(p))
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux, ownerOf: () => otherUid })
    await sleep(800)
    expect(r.reaped).toEqual([])
    expect(r.skippedOtherUid).toContain(p)
    expect(alive(p)).toBe(true)
    expect(loggedKilled(info, 'channel-poller-reap: orphans killed', p)).toBe(false)
    const skips = info.mock.calls.filter(([, m]) => m === 'channel-poller-reap: spared processes not owned by this user (35ea0375)')
    expect(skips).toHaveLength(1)
    expect(skips[0][0]).toMatchObject({ skippedOtherUid: r.skippedOtherUid.length, skippedUnknownOwner: 0 })
    expect(JSON.stringify(skips[0][0])).not.toContain(String(p)) // a count, not a line per pid
    info.mockRestore()
    process.kill(p, 'SIGKILL'); await sleep(150) // the spared poller would be the next test's candidate too
  })

  it('a refused signal (EPERM) is not killed: reported by kind, not in reaped', async () => {
    const p = poller(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(p))
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux, kill: () => { throw errno('EPERM') } })
    expect(r.reaped).toEqual([])
    expect(r.killOutcome.permissionDenied).toContain(p)
    expect(alive(p)).toBe(true)
    expect(loggedKilled(info, 'channel-poller-reap: orphans killed', p)).toBe(false)
    const notKilled = warn.mock.calls.find(([, m]) => m === 'channel-poller-reap: signalled pid(s) not killed, outcome by kind')
    expect(notKilled?.[0]).toMatchObject({ notKilled: [p], outcome: { ok: 0, ESRCH: 0, EPERM: 1, other: 0 } })
    info.mockRestore()
    warn.mockRestore()
    process.kill(p, 'SIGKILL'); await sleep(150)
  })
})

// The detached-claude path, with a needle that exists only in this test's argv
// (a fake tmux makes every real `claude --channels` on the host look detached).
describe('35ea0375 reapDetachedChannelClaudes on real processes', () => {
  const needle = (tag: string) => `plugin:telegram@own-uid-35ea0375-${tag}-${process.pid}-${Date.now()}`
  async function claudeWithChild(tag: string, n: string): Promise<{ claude: number; child: number }> {
    const childFile = join(tmp, `dc-${tag}.pid`)
    const claude = spawnWithEnv('/bin/bash', ['-c',
      `exec -a claude /bin/bash -c 'sleep 300 & echo $! > ${childFile}; wait' x --channels ${n}`], {})
    for (let i = 0; i < 40 && !existsSync(childFile); i++) await sleep(50)
    const child = parseInt(readFileSync(childFile, 'utf-8').trim(), 10)
    kids.push(child)
    return { claude, child }
  }

  it('a detached claude of another uid is spared and not returned as reaped', async () => {
    const n = needle('foreign')
    const { claude } = await claudeWithChild('foreign', n)
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n, ownerOf: () => otherUid })
    await sleep(800)
    expect(reaped).toEqual([])
    expect(alive(claude)).toBe(true)
    expect(loggedKilled(info, 'channel-poller-reap: detached channel claudes killed', claude)).toBe(false)
    info.mockRestore()
  })

  it('positive control: the same shape owned by this uid is reaped', async () => {
    const n = needle('own')
    const { claude } = await claudeWithChild('own', n)
    fakeTmuxPrints('echo 4242')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n, ownerOf: () => myUid })
    await sleep(800)
    expect(reaped).toEqual([claude])
    expect(alive(claude)).toBe(false)
  })
})
