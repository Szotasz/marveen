// TMUXWINDOWATTR920 (2026-09-20): tmux's one-line errors from the dashboard's
// pollers ("can't find window: marveen-channels" x133, "can't find session:
// agent-*" x~3500) sat in dashboard.error.log undated and unattributed, because
// execFileSync WITHOUT a stdio option copies the child's stderr onto the
// parent's stderr as well as attaching it to the thrown error. The fix is not
// silence: the callers pipe stderr and log the line through the logger with the
// call site and the session. These tests pin (a) the mechanism, (b) every call
// site, so a new tmux poller written the old way goes red here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmuxStderr } from '../web/tmux-stderr.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const src = (rel: string) => readFileSync(join(ROOT, 'src', 'web', rel), 'utf-8')

function haveTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 }); return true } catch { return false }
}

describe('tmux stderr attribution (TMUXWINDOWATTR920)', () => {
  it('MECHANISM: without stdio the child stderr reaches the parent stderr; with a piped stderr it does not', () => {
    if (!haveTmux()) return
    // Each case runs in a child node so the PARENT stderr is observable here.
    const snippet = (opts: string) =>
      `const {execFileSync}=require('node:child_process');try{execFileSync('tmux',['list-panes','-t','nincs-ilyen-session-xyz','-F','#{pane_pid}'],${opts})}catch(e){process.stdout.write('caught:'+String(e.stderr||'').trim())}`
    const leaky = spawnSync(process.execPath, ['-e', snippet("{timeout:3000,encoding:'utf-8'}")], { encoding: 'utf-8' })
    const piped = spawnSync(process.execPath, ['-e', snippet("{timeout:3000,encoding:'utf-8',stdio:['ignore','pipe','pipe']}")], { encoding: 'utf-8' })
    expect(leaky.stdout).toContain("caught:can't find window")
    expect(leaky.stderr).toContain("can't find window")          // the leak the log was full of
    expect(piped.stdout).toContain("caught:can't find window")   // the error is still available to the caller
    expect(piped.stderr.trim()).toBe('')                          // ...and nothing reaches the parent stderr
  })

  it('tmuxStderr() returns the one tmux line, trimmed and bounded, falling back to the message', () => {
    expect(tmuxStderr({ stderr: "can't find window: marveen-channels\n" })).toBe("can't find window: marveen-channels")
    expect(tmuxStderr({ stderr: Buffer.from('x\n') })).toBe('x')
    expect(tmuxStderr({ stderr: '', message: 'spawnSync tmux ETIMEDOUT' })).toBe('spawnSync tmux ETIMEDOUT')
    expect(tmuxStderr(new Error('boom')).length).toBeGreaterThan(0)
    expect(tmuxStderr({ stderr: 'a'.repeat(500) }).length).toBe(200)
  })

  // Every tmux poller that targets a session by name must pipe stderr AND log
  // with a `site`. Pinned per file so a regression names the file.
  const SITES: Array<[file: string, call: RegExp, site: string]> = [
    ['channel-monitor.ts', /\['list-panes', '-t', MAIN_CHANNELS_SESSION, '-F', '#\{pane_pid\}'\],\s*\{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'channel-monitor.mainPaneClaudePid'],
    ['channel-monitor.ts', /\['has-session', '-t', MAIN_CHANNELS_SESSION\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'channel-monitor.mainChannelsSessionExists'],
    ['context-restart-gate-runner.ts', /\['list-panes', '-t', session, '-F', '#\{pane_pid\}'\],\s*\{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'context-restart-gate-runner.getPanePid'],
    ['channel-plugin-unlock.ts', /\['list-panes', '-t', session, '-F', '#\{pane_pid\}'\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'channel-plugin-unlock.getSessionClaudePid'],
    ['stuck-tool-call-watcher.ts', /\['list-panes', '-t', session, '-F', '#\{pane_pid\}'\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'stuck-tool-call-watcher.sampleMainClaudeCpuPercent'],
    ['agent-worker.ts', /\['kill-session', '-t', ctx\.session\], \{[^}]*stdio: \['ignore', 'pipe', 'pipe'\]/, 'agent-worker.restart'],
  ]
  for (const [file, call, site] of SITES) {
    it(`SITE ${file}: pipes stderr and logs with site='${site}'`, () => {
      const s = src(file)
      expect(s, `${file}: the tmux call must pipe stderr`).toMatch(call)
      expect(s, `${file}: the catch must log the site`).toContain(`site: '${site}'`)
      expect(s, `${file}: the log must carry the tmux line`).toContain('tmux: tmuxStderr(err)')
    })
  }

  it('no tmux call in src/web still runs with the leaky default (no stdio) on a by-name target', () => {
    // A new poller written the old way must land here, not in dashboard.error.log.
    const files = ['channel-monitor.ts', 'context-restart-gate-runner.ts', 'channel-plugin-unlock.ts', 'stuck-tool-call-watcher.ts', 'agent-worker.ts']
    for (const f of files) {
      const s = src(f)
      const leaky = s.match(/execFileSync\((?:tmuxBin\(\)|TMUX), \['(?:list-panes|has-session|kill-session)', '-t', [^\]]+\], \{[^}]*\}\)/g) ?? []
      const bad = leaky.filter((m) => !/stdio: \['ignore', 'pipe', 'pipe'\]/.test(m))
      expect(bad, `${f}: leaky tmux call(s): ${bad.join(' | ')}`).toEqual([])
    }
  })
})
