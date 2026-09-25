// Contract tests for the live-pane guard in reapChannelOrphans (PR #1402, card
// PR1402CHANNELREAP / PANEDEAD919). The guard was shipped without a test; this
// is the measurement that verified it, kept.
//
// The bug (2026-09-19, card 08a02137): `export TELEGRAM_STATE_DIR=... && exec
// claude` puts the state dir into the pane's OWN claude environment, so the
// bot.pid / env-scan candidates can include the live pane leader itself. The
// pre-respawn reap then killed the main session's claude, the pane collapsed,
// and `tmux respawn-pane -k` failed with "can't find pane".
//
// Three directions, all on real processes (a detached `sleep` carrying the
// state-dir env var) against a fake tmux passed through opts.tmuxPath:
//   A. the candidate IS a live pane leader  -> spared (skippedLivePane), alive
//   B. the tmux query fails                  -> nothing reaped (fail-safe), alive
//   C. the candidate is not a live pane     -> reaped, dead
// A real tmux server is never touched: the fake prints or fails on demand.
import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { reapChannelOrphans } from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'

const tmp = mkdtempSync(join(tmpdir(), 'reap-live-pane-'))
const agentDir = join(tmp, 'agent')
const chanDir = channelStateDir('telegram', agentDir)
mkdirSync(chanDir, { recursive: true })
const fakeTmux = join(tmp, 'fake-tmux')
const kids: number[] = []

// A long-lived process that matches BOTH candidate sources: bot.pid (written
// below) and the env-var scan (TELEGRAM_STATE_DIR in its environment).
function victim(): number {
  const p = spawn('/bin/sleep', ['300'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TELEGRAM_STATE_DIR: chanDir },
  })
  p.unref()
  kids.push(p.pid!)
  return p.pid!
}
function fakeTmuxPrints(body: string): void {
  writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`)
  chmodSync(fakeTmux, 0o755)
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('reapChannelOrphans live-pane guard', () => {
  it('A: spares a candidate that is a live tmux pane leader', async () => {
    const a = victim(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(a))
    fakeTmuxPrints(`echo ${a}\necho 4242`)
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(500)
    expect(r.skippedLivePane).toContain(a)
    expect(r.reaped).not.toContain(a)
    expect(alive(a)).toBe(true)
  })

  it('B: refuses to reap anything when the tmux query fails (fail-safe)', async () => {
    const b = victim(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(b))
    fakeTmuxPrints('exit 1')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(500)
    expect(r.reaped).toEqual([])
    expect(r.skippedLivePane).toEqual([])
    expect(alive(b)).toBe(true)
  })

  it('C: still reaps a candidate that is not a live pane', async () => {
    const c = victim(); await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(c))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(800)
    expect(r.reaped).toContain(c)
    expect(r.skippedLivePane).toEqual([])
    expect(alive(c)).toBe(false)
  })
})
