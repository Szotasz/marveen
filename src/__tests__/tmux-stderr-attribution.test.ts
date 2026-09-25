// TMUXWINDOWATTR920 (2026-09-20): tmux's one-line errors from the dashboard's
// pollers ("can't find window: marveen-channels" x133, "can't find session:
// agent-*" x~4000) sat in dashboard.error.log undated and unattributed, because
// the SYNC child-process calls (execFileSync / execSync / spawnSync) WITHOUT a
// stdio option copy the child's stderr onto the parent's stderr as well as
// attaching it to the thrown error. (The async execFile/spawn pipe by default
// and do not leak.) The fix is not silence: the callers pipe stderr and log the
// line through the logger with the call site and the session.
//
// These tests pin (a) the mechanism, (b) every converted call site, and (c) the
// WHOLE of src/web: every sync by-name tmux call that still leaks today is
// named in an allowlist with a reason and a count, so the debt is visible and
// countable -- a new leaky call fails here, and so does a silently fixed one
// (the allowlist must be updated, which is the point: the number is the debt).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { tmuxStderr } from '../web/tmux-stderr.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const WEB = join(ROOT, 'src', 'web')
const src = (rel: string) => readFileSync(join(WEB, rel), 'utf-8')

describe('tmux stderr attribution (TMUXWINDOWATTR920)', () => {
  it('MECHANISM: without stdio the child stderr reaches the parent stderr; with a piped stderr it does not', () => {
    // No tmux here on purpose: CI has no tmux server (its error there is "error
    // connecting to /tmp/tmux-…", measured on the first run), and the mechanism
    // is Node's, not tmux's. A grandchild node writes one line to stderr and
    // exits 1; the child calls it via execFileSync; the PARENT (this test)
    // observes the child's stderr.
    const line = "can't find window: marveen-channels"
    // The grandchild's code is JSON-encoded as a whole: the apostrophe in the
    // line would otherwise end a single-quoted JS string (the first draft did).
    const grandchild = `process.stderr.write(${JSON.stringify(line)});process.exit(1)`
    const snippet = (opts: string) =>
      `const {execFileSync}=require('node:child_process');try{execFileSync(process.execPath,['-e',${JSON.stringify(grandchild)}],${opts})}catch(e){process.stdout.write('caught:'+String(e.stderr||'').trim())}`
    const leaky = spawnSync(process.execPath, ['-e', snippet("{timeout:5000,encoding:'utf-8'}")], { encoding: 'utf-8' })
    const piped = spawnSync(process.execPath, ['-e', snippet("{timeout:5000,encoding:'utf-8',stdio:['ignore','pipe','pipe']}")], { encoding: 'utf-8' })
    expect(leaky.stdout).toBe('caught:' + line)          // the caller had the line either way...
    expect(leaky.stderr).toContain(line)                  // ...but the default ALSO copied it to the parent stderr: the leak
    expect(piped.stdout).toBe('caught:' + line)           // piped: the caller still has it
    expect(piped.stderr.trim()).toBe('')                  // ...and nothing reaches the parent stderr
  })

  it('tmuxStderr() returns the one tmux line, trimmed and bounded, falling back to the message', () => {
    expect(tmuxStderr({ stderr: "can't find window: marveen-channels\n" })).toBe("can't find window: marveen-channels")
    expect(tmuxStderr({ stderr: Buffer.from('x\n') })).toBe('x')
    expect(tmuxStderr({ stderr: '', message: 'spawnSync tmux ETIMEDOUT' })).toBe('spawnSync tmux ETIMEDOUT')
    expect(tmuxStderr(new Error('boom')).length).toBeGreaterThan(0)
    expect(tmuxStderr({ stderr: 'a'.repeat(500) }).length).toBe(200)
  })

  // Every converted site must pipe stderr AND log with a `site`. Pinned per
  // file so a regression names the file.
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

  // ---- (c) the whole of src/web ---------------------------------------------
  // What still leaks today, named. Each entry: file (relative to src/web),
  // subcommand, the exact number of leaky calls, and why it is allowed to stay
  // for now. Measured on the PR head 2026-09-20 with the scan below: 31 calls
  // in 6 files, 24 of them send-keys. (An async execFile in reauth-healer.ts
  // is NOT here: async execFile pipes by default and does not leak.)
  //
  // Why these are not converted in this PR: they are ACTIONS on a session
  // (key injection, pane capture, pane respawn, killing a finished background
  // session), not pollers, and on a missing session they say "can't find
  // pane: <name>" (58 such lines measured) -- a different, smaller family than
  // the "window" (133) and "session" (~4000) lines this card is about. They are
  // debt, counted here, for a follow-up card; converting them means deciding
  // per site whether absence is an error or the expected answer.
  const ALLOWED_LEAKS: Array<{ file: string; sub: string; count: number; why: string }> = [
    { file: 'agent-worker.ts', sub: 'send-keys', count: 3, why: 'worker start/restart key injection; a missing worker session is caught by the caller' },
    { file: 'channel-mcp-reconnect.ts', sub: 'send-keys', count: 8, why: '/mcp reconnect keystrokes into the main pane; the caller reads the pane afterwards' },
    { file: 'channel-monitor.ts', sub: 'send-keys', count: 3, why: 'Enter/Escape nudges into a pane the monitor has just measured as present' },
    { file: 'channel-monitor.ts', sub: 'respawn-pane', count: 3, why: 'respawn-pane -k is the hard-restart action itself; its failure is reported by the caller' },
    { file: 'channel-plugin-unlock.ts', sub: 'send-keys', count: 8, why: 'consent-dialog keystrokes; the caller captures the pane between steps' },
    { file: 'channel-plugin-unlock.ts', sub: 'capture-pane', count: 2, why: 'pane capture around the keystrokes above; failure returns null to the caller' },
    { file: 'context-restart-gate-runner.ts', sub: 'send-keys', count: 2, why: '/clear + Enter into a gated session the runner has just verified' },
    { file: 'routes/background-tasks.ts', sub: 'capture-pane', count: 1, why: 'background task output capture; null on failure' },
    { file: 'routes/background-tasks.ts', sub: 'kill-session', count: 1, why: 'killing a finished background session; "already dead" is expected' },
  ]

  const SUBS = ['list-panes', 'has-session', 'kill-session', 'send-keys', 'capture-pane', 'respawn-pane',
    'respawn-window', 'kill-window', 'select-window', 'list-windows', 'display-message', 'rename-session',
    'new-window', 'resize-pane', 'kill-pane', 'split-window']

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out) }
      else if (name.endsWith('.ts')) out.push(p)
    }
    return out
  }

  // Every SYNC child-process call whose head names tmux, whose args carry a
  // by-name subcommand with `-t`, and whose stdio leaves stderr inheriting (no
  // stdio at all, or an 'inherit' stderr slot). Pure over a text, so the
  // classifier itself can be tested on fixtures below.
  function classifyLeaks(text: string): string[] {
    const found: string[] = []
    const callRx = /\b(execFileSync|execSync|spawnSync)\(/g
    let m: RegExpExecArray | null
    while ((m = callRx.exec(text))) {
      let i = m.index + m[0].length, depth = 1
      while (i < text.length && depth) { const c = text[i]; if (c === '(') depth++; else if (c === ')') depth--; i++ }
      const call = text.slice(m.index + m[0].length, i - 1)
      const head = call.split(',', 1)[0] ?? ''
      if (!/tmux/i.test(head)) continue
      const sub = SUBS.find((s) => new RegExp(`'${s}'`).test(call) || new RegExp(`\\btmux\\b[^\`'"]*\\b${s}\\b`).test(call))
      if (!sub) continue
      if (!(call.includes("'-t'") || /\s-t\s/.test(call))) continue
      const stdio = /stdio:\s*(\[[^\]]*\]|'[a-z]+')/.exec(call)
      let leaky = true
      if (stdio) {
        const spec = stdio[1]
        if (spec.startsWith("'")) leaky = spec === "'inherit'"
        else {
          const slots = spec.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          leaky = (slots[2] ?? 'inherit') === 'inherit'
        }
      }
      if (leaky) found.push(sub)
    }
    return found
  }

  function scanLeaks(): Array<{ file: string; sub: string }> {
    const found: Array<{ file: string; sub: string }> = []
    for (const path of walk(WEB)) {
      for (const sub of classifyLeaks(readFileSync(path, 'utf-8'))) found.push({ file: relative(WEB, path), sub })
    }
    return found
  }

  it('the classifier itself: leaky vs piped vs ignored-stderr vs not-tmux vs not-by-name (fixtures)', () => {
    expect(classifyLeaks("execFileSync(tmuxBin(), ['list-panes', '-t', s, '-F', '#{pane_pid}'], { timeout: 3000 })")).toEqual(['list-panes'])
    expect(classifyLeaks("execFileSync(TMUX, ['send-keys', '-t', s, 'Enter'], { timeout: 5000 })")).toEqual(['send-keys'])
    expect(classifyLeaks("execFileSync(TMUX, ['send-keys', '-t', s, 'Enter'])")).toEqual(['send-keys'])
    expect(classifyLeaks("execFileSync(tmuxBin(), ['has-session', '-t', s], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })")).toEqual([])
    expect(classifyLeaks("execFileSync(inv.file, inv.args, { stdio: ['ignore', 'ignore', 'pipe'] })")).toEqual([]) // head not tmux
    expect(classifyLeaks("execFileSync(TMUX, ['kill-session', '-t', s], { stdio: 'inherit' })")).toEqual(['kill-session'])
    expect(classifyLeaks("execSync(`${tmuxPath} list-panes -a -F '#{pane_pid}'`, { timeout: 5000 })")).toEqual([]) // no -t
    expect(classifyLeaks("execFile(TMUX, ['kill-session', '-t', s], { timeout: 5000 }, () => resolve())")).toEqual([]) // async: pipes by default
  })

  it('WHOLE src/web: every sync by-name tmux call that still leaks stderr is named in the allowlist, with its count', () => {
    const counts = new Map<string, number>()
    for (const { file, sub } of scanLeaks()) counts.set(`${file}|${sub}`, (counts.get(`${file}|${sub}`) ?? 0) + 1)
    const measured = [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key))
    const allowed = ALLOWED_LEAKS.map((e) => ({ key: `${e.file}|${e.sub}`, count: e.count })).sort((a, b) => a.key.localeCompare(b.key))
    // Both directions: a NEW leaky call fails (not in the list, or count up),
    // and a leak fixed WITHOUT updating the list fails too (count down) -- the
    // list is the debt ledger and must stay true.
    expect(measured).toEqual(allowed)
    expect(allowed.reduce((n, e) => n + e.count, 0)).toBe(31)
  })

  it('the converted sites are NOT in the leak scan (positive control on the real tree)', () => {
    const keys = new Set(scanLeaks().map((l) => `${l.file}|${l.sub}`))
    for (const k of ['channel-monitor.ts|list-panes', 'channel-monitor.ts|has-session', 'context-restart-gate-runner.ts|list-panes',
      'channel-plugin-unlock.ts|list-panes', 'stuck-tool-call-watcher.ts|list-panes', 'agent-worker.ts|kill-session']) {
      expect(keys.has(k), k).toBe(false)
    }
  })
})
