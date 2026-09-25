import { describe, it, expect, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// CHANSPARE925 (measured 2026-09-25): a Claude Code daemon background session,
// started from the main agent's config dir with --channels, loaded the telegram
// plugin and wrote ITS bun pid into bot.pid -- it took the poller. The watchdog
// only asked `kill -0 bot.pid`, the thief was alive, so the plugin read as
// healthy while the owner's messages went to a session with no transcript.
// The fix: a live bot.pid counts as our plugin only when it hangs under this
// session's pane pid. These tests run the real detector against REAL process
// trees (positive and negative control), and pin the watchdog wiring.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHANNELS = join(REPO_ROOT, 'scripts', 'channels.sh')
const channelsSh = readFileSync(CHANNELS, 'utf-8')

function ownerCheck(botPid: string | number, panePid: string | number): string {
  return execFileSync('bash', [CHANNELS, '--bot-owner-check', String(botPid), String(panePid)], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

const spawned: ChildProcess[] = []
afterAll(() => {
  for (const p of spawned) {
    try { process.kill(-p.pid!, 'SIGKILL') } catch { /* already gone */ }
  }
})

// A detached tree: bash (root) -> bash -> sleep. Returns the root pid and the
// grandchild sleep pid once both exist.
async function tree(): Promise<{ root: number; leaf: number }> {
  const p = spawn('bash', ['-c', 'bash -c "sleep 60; true" & wait'], { detached: true, stdio: 'ignore' })
  spawned.push(p)
  const root = p.pid!
  for (let i = 0; i < 50; i++) {
    const out = execFileSync('bash', ['-c', `pgrep -P $(pgrep -P ${root} | head -1) 2>/dev/null || true`], { encoding: 'utf-8' }).trim()
    if (out) return { root, leaf: Number(out.split('\n')[0]) }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('process tree did not come up')
}

describe('bot_pid_descends_from: whose plugin owns bot.pid (real process trees)', () => {
  it('a grandchild of the pane pid is OURS (positive control)', async () => {
    const t = await tree()
    expect(ownerCheck(t.leaf, t.root)).toBe('own')
  })

  it('the pane pid itself is ours', async () => {
    const t = await tree()
    expect(ownerCheck(t.root, t.root)).toBe('own')
  })

  it('a live process in ANOTHER tree is foreign (negative control: the hijack)', async () => {
    const mine = await tree()
    const thief = await tree()
    expect(ownerCheck(thief.leaf, mine.root)).toBe('foreign')
  })

  it('a pid that no longer exists is foreign, not ours', async () => {
    const t = await tree()
    process.kill(-t.root, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
    expect(ownerCheck(t.leaf, 1)).toBe('foreign')
  })

  it('empty or non-numeric input is foreign (never "own" by accident)', () => {
    expect(ownerCheck('', 123)).toBe('foreign')
    expect(ownerCheck('12a', 123)).toBe('foreign')
    expect(ownerCheck(123, '')).toBe('foreign')
  })
})

function watchdogLoop(): string {
  const start = channelsSh.indexOf('while $TMUX has-session -t "$SESSION"')
  expect(start).toBeGreaterThan(0)
  const end = channelsSh.indexOf('\ndone\n', start)
  expect(end).toBeGreaterThan(start)
  return channelsSh.slice(start, end)
}

describe('the watchdog uses the owner check (wiring)', () => {
  it('a live bot.pid is tested against this session pane pid before it counts as alive', () => {
    const loop = watchdogLoop()
    const check = loop.indexOf('bot_pid_descends_from "$_bot_pid" "$_watchdog_claude_pid"')
    const alive = loop.indexOf('_plugin_alive=true')
    expect(check).toBeGreaterThan(0)
    expect(alive).toBeGreaterThan(check)
  })

  it('a hijack is logged to the respawn log and on stderr', () => {
    const loop = watchdogLoop()
    expect(loop).toMatch(/respawn_log "poller-hijack: bot\.pid=/)
    expect(loop).toMatch(/poller hijacked -- bot\.pid/)
  })

  it('the bun-child fallback cannot overrule a hijack', () => {
    const loop = watchdogLoop()
    expect(loop).toMatch(/if \[ "\$_plugin_alive" != "true" \] && \[ "\$_bot_hijacked" != "true" \]; then/)
  })
})
