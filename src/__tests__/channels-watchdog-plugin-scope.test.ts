import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const channelsSh = readFileSync(join(REPO_ROOT, 'scripts', 'channels.sh'), 'utf-8')

// Regression lock for kanban c0390130 (2026-08-19, found by pedro): the
// watchdog's no-bot.pid fallback used to scan the WHOLE host for any process
// whose env carried CLAUDE_PLUGIN_ROOT=.../telegram, which matches every
// agent's telegram plugin on a multi-agent fleet host -- so the fallback
// always found SOMEONE's live plugin and reported this agent's own dead
// plugin as alive. The fix scopes the fallback to a `pgrep -P` check under
// this session's own claude pane_pid (the same technique already used by the
// post-init unlock Check 1 a few hundred lines above in this same file).

function extractWatchdogLoop(): string {
  const start = channelsSh.indexOf('while $TMUX has-session -t "$SESSION"')
  expect(start, 'watchdog while-loop not found').toBeGreaterThan(0)
  const end = channelsSh.indexOf('\ndone\n', start)
  expect(end, 'watchdog while-loop close (done) not found').toBeGreaterThan(start)
  return channelsSh.slice(start, end)
}

describe('channels.sh watchdog plugin-liveness fallback is scoped to this session, not host-wide', () => {
  it('computes the session pane_pid once, before the watchdog loop', () => {
    const preLoop = channelsSh.slice(0, channelsSh.indexOf('while $TMUX has-session -t "$SESSION"'))
    const idx = preLoop.lastIndexOf('_watchdog_claude_pid=')
    expect(idx, '_watchdog_claude_pid assignment not found before the loop').toBeGreaterThan(0)
    const line = preLoop.slice(idx, preLoop.indexOf('\n', idx))
    expect(line).toMatch(/list-panes -t "\$SESSION"/)
    expect(line).toMatch(/#\{pane_pid\}/)
  })

  it('the fallback check is a pgrep -P scoped to _watchdog_claude_pid, not a host-wide ps scan', () => {
    const loop = extractWatchdogLoop()
    expect(loop).toMatch(/pgrep -P "\$_watchdog_claude_pid" bun/)
  })

  it('never falls back to the old unscoped `ps eww -e | grep CLAUDE_PLUGIN_ROOT` host-wide scan', () => {
    // The exact pre-fix EXECUTABLE pattern that matched ANY agent's plugin
    // anywhere on the host. If this reappears as a live command (not just in
    // the explanatory comment describing the historical bug), the masking
    // bug is back. Scoped to lines that are not comments, so the fix's own
    // "here is what we removed" prose doesn't self-trigger this lock.
    const loop = extractWatchdogLoop()
    const codeLines = loop.split('\n').filter(l => !l.trim().startsWith('#'))
    const codeOnly = codeLines.join('\n')
    expect(codeOnly).not.toMatch(/ps eww -e/)
    expect(codeOnly).not.toMatch(/CLAUDE_PLUGIN_ROOT=\[\^ \]\*/)
  })

  it('guards against an empty pane_pid before calling pgrep (no bare pgrep -P "" )', () => {
    const loop = extractWatchdogLoop()
    const fallbackIdx = loop.indexOf('pgrep -P "$_watchdog_claude_pid" bun')
    expect(fallbackIdx).toBeGreaterThan(0)
    const precedingLine = loop.slice(0, fallbackIdx)
    const lastIf = precedingLine.lastIndexOf('if [')
    const guardClause = loop.slice(lastIf, fallbackIdx)
    expect(guardClause).toMatch(/-n "\$_watchdog_claude_pid"/)
  })
})

// Live mechanism proof: `pgrep -P <parent> <name>` finds only a genuine child
// of that exact parent pid, and nothing under an unrelated pid. This is not
// testing channels.sh's bash glue (execSync-ing the whole script would need a
// live tmux session) -- it independently proves the underlying primitive the
// fix relies on actually works on this host/OS, the same way the reap-scope
// tests prove the awk primitive rather than the whole script.
//
// The pinned property is "pgrep -P filters by parent AND by name", which does
// not require the literal name "bun". An earlier revision of this test
// simulated a bun process by copying /bin/bash to a file named `bun`: macOS
// SIGKILLs a copied platform binary, so the child was already gone by the time
// pgrep ran and the test was flaky-red on every macOS fleet host (standalone
// 3/3 red; full suite intermittently red). `/bin/sleep` is a real, unmodified
// system binary on both platforms, so nothing kills it.
import { execFileSync, spawn } from 'node:child_process'

describe('pgrep -P scoping primitive (proves the mechanism, not just the source text)', () => {
  it('finds a named child only under its real parent pid, not under an unrelated pid', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 300))
      const ownHit = execFileSync('/usr/bin/pgrep', ['-P', String(process.pid), 'sleep'], { encoding: 'utf-8' }).trim()
      expect(ownHit).toBe(String(child.pid))
      // The "unrelated parent" must be a process that provably has no children.
      // pid 1 is NOT safe for this: on macOS launchd has direct `sleep`-named
      // children, so `pgrep -P 1 sleep` legitimately matches and the negative
      // half would fail for a reason that has nothing to do with the property
      // under test. A leaf process -- the child we just spawned -- cannot have
      // children by construction, so it is the sound choice on both platforms.
      let unrelatedHit = ''
      try {
        unrelatedHit = execFileSync('/usr/bin/pgrep', ['-P', String(child.pid), 'sleep'], { encoding: 'utf-8' }).trim()
      } catch { /* pgrep exits 1 on no match -- that IS the expected "not found" */ }
      expect(unrelatedHit).toBe('')
    } finally {
      child.kill('SIGKILL')
    }
  })
})
