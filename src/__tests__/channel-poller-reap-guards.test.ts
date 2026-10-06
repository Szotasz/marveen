// Card cf075d41: three guards against stopping the wrong process, on top of the
// upstream poller selection (selectReapablePollers) and the own-uid layer.
//
// On a shared host one uid runs many agents, and the pid space wraps. Three
// shapes passed the reapers before:
//   (i)   a stale bot.pid that names a live process which is not a plugin
//         process (bot.pid is exempt from the runtime check);
//   (ii)  a detached node/npx job that inherited the owning agent's state-dir
//         variable, outside the plugin root (it passes the runtime check);
//   (iii) a detached `claude --channels` that sits ABOVE a live pane leader
//         (the orphan test only looks up from the claude);
// and (iv), the positive control, a real orphan is still stopped.
// The real-process cases assert liveness FIRST, so on the code without the
// guards they fail because the process was stopped, not on a missing export.
// A real tmux server is never touched: a fake tmux answers every query.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseStateDirPollerPids,
  isPluginPollerPid,
  paneAncestorPids,
  reapChannelOrphans,
  reapDetachedChannelClaudes,
  type ProcRow,
} from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

describe('cf075d41 pure: the plugin markers and the pane ancestors', () => {
  const ps = [
    '  101 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram/0.0.7',
    '  102 ?  S  0:00 node build.js TELEGRAM_STATE_DIR=/a/telegram HOME=/h',
    '  103 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram-old CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram/0.0.7',
    '  104 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram-inline/1.0',
    '  105 ?  S  0:00 sleep 300 HOME=/h',
  ].join('\n')

  it('an env-scan candidate needs the state dir AND the plugin root, both exact', () => {
    expect(parseStateDirPollerPids(ps, 'TELEGRAM_STATE_DIR', '/a/telegram', '/telegram')).toEqual([101])
  })

  it('bot.pid is a plugin process only with the plugin root marker', () => {
    expect(isPluginPollerPid(ps, 101, '/telegram')).toBe(true)
    expect(isPluginPollerPid(ps, 102, '/telegram')).toBe(false)
    expect(isPluginPollerPid(ps, 105, '/telegram')).toBe(false)
    expect(isPluginPollerPid(ps, 999, '/telegram')).toBe(false) // not in the snapshot
  })

  it('the pane ancestors hold the parent and the grandparent of a pane', () => {
    const procs: ProcRow[] = [
      { pid: 10, ppid: 1, command: 'tmux new-session' },
      { pid: 20, ppid: 10, command: 'claude --channels plugin:telegram@x' },
      { pid: 30, ppid: 20, command: 'bash' },
      { pid: 40, ppid: 1, command: 'claude --channels plugin:telegram@y' },
    ]
    expect([...paneAncestorPids(procs, new Set([30]))].sort()).toEqual([10, 20])
  })
})

// ---------------------------------------------------------------------------
// Real processes, fake tmux.
const tmp = mkdtempSync(join(tmpdir(), 'reap-guards-'))
const agentDir = join(tmp, 'agent')
const chanDir = channelStateDir('telegram', agentDir)
mkdirSync(chanDir, { recursive: true })
const pluginRoot = join(tmp, 'plugins', 'cache', 'official', 'telegram', '0.0.1')
const fakeTmux = join(tmp, 'fake-tmux')
const kids: number[] = []

// The test runner's own environment may carry either marker; every process here
// gets exactly the markers its case names.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'TELEGRAM_STATE_DIR' && k !== 'CLAUDE_PLUGIN_ROOT') env[k] = v
  }
  return env
}
function spawnWith(cmd: string, args: string[], extra: Record<string, string>): number {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...baseEnv(), ...extra } })
  p.unref()
  kids.push(p.pid!)
  return p.pid!
}
const nodeJob = (extra: Record<string, string>) => spawnWith(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], extra)
function fakeTmuxPrints(body: string): void {
  writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`)
  chmodSync(fakeTmux, 0o755)
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clearBotPid = () => { rmSync(join(chanDir, 'bot.pid'), { force: true }) }

afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('cf075d41 reapChannelOrphans on real processes', () => {
  it('(i) a stale bot.pid naming a live process that is not a plugin process: NOT stopped', async () => {
    const stranger = spawnWith('/bin/sleep', ['300'], {})
    await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(stranger))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(stranger)).toBe(true)
    expect(r.reaped).not.toContain(stranger)
    expect(r.source.fromBotPid).toBeNull()
    expect(r.skippedNotPlugin).toContain(stranger)
    clearBotPid()
  })

  it('(ii) a detached node job with the inherited state dir, outside the plugin root: NOT stopped', async () => {
    clearBotPid()
    const job = nodeJob({ TELEGRAM_STATE_DIR: chanDir })
    await sleep(300)
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(job)).toBe(true)
    expect(r.reaped).not.toContain(job)
    expect(r.source.fromEnvScan).not.toContain(job)
    expect(r.skippedNotPlugin).toContain(job)
    const line = info.mock.calls.find(([, m]) => String(m).includes('are not plugin processes (cf075d41)'))
    expect(line?.[0]).toMatchObject({ skippedNotPlugin: r.skippedNotPlugin.length })
    expect(JSON.stringify(line?.[0])).not.toContain(String(job)) // a count, not a line per pid
    info.mockRestore()
    process.kill(job, 'SIGKILL'); await sleep(150)
  })

  it('(iv) positive control: a real orphan poller (state dir AND plugin root) is still stopped, via the env scan and via bot.pid', async () => {
    clearBotPid()
    const scanned = nodeJob({ TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    const listed = spawnWith('/bin/sleep', ['300'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    await sleep(300)
    writeFileSync(join(chanDir, 'bot.pid'), String(listed))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(scanned)).toBe(false)
    expect(alive(listed)).toBe(false)
    expect(r.reaped).toEqual(expect.arrayContaining([scanned, listed]))
    expect(r.source.fromBotPid).toBe(listed)
    clearBotPid()
  })
})

// The detached-claude path, with a needle that exists only in this test's argv
// (a fake tmux makes every real `claude --channels` on the host look detached).
describe('cf075d41 reapDetachedChannelClaudes on real processes', () => {
  const needle = (tag: string) => `plugin:telegram@guards-cf075d41-${tag}-${process.pid}-${Date.now()}`
  async function claudeWithChild(tag: string, n: string): Promise<{ claude: number; child: number }> {
    const childFile = join(tmp, `dc-${tag}.pid`)
    const claude = spawnWith('/bin/bash', ['-c',
      `exec -a claude /bin/bash -c 'sleep 300 & echo $! > ${childFile}; wait' x --channels ${n}`], {})
    for (let i = 0; i < 40 && !existsSync(childFile); i++) await sleep(50)
    const child = parseInt(readFileSync(childFile, 'utf-8').trim(), 10)
    kids.push(child)
    return { claude, child }
  }

  it('(iii) a detached claude --channels that is the parent of a live pane leader: NOT stopped', async () => {
    const n = needle('pane-parent')
    const { claude, child } = await claudeWithChild('pane-parent', n)
    fakeTmuxPrints(`echo ${child}`) // the child is a live pane leader
    const warn = vi.spyOn(logger, 'warn')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n })
    await sleep(600)
    expect(alive(claude)).toBe(true)
    expect(alive(child)).toBe(true)
    expect(reaped).toEqual([])
    const line = warn.mock.calls.find(([, m]) => String(m).includes('ancestor of a live pane'))
    expect(line?.[0]).toMatchObject({ skippedPaneAncestor: [claude] })
    warn.mockRestore()
  })

  it('(iv) positive control: a detached claude --channels with no live pane under it is still stopped', async () => {
    const n = needle('orphan')
    const { claude } = await claudeWithChild('orphan', n)
    fakeTmuxPrints('echo 4242')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n })
    await sleep(600)
    expect(reaped).toEqual([claude])
    expect(alive(claude)).toBe(false)
  })
})
