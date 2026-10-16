/**
 * TMUXEXACT1771 (#1771): every tmux target is the exact form `=NAME:`.
 *
 * tmux resolves a bare `-t NAME` exactly first and, when no session has that
 * name, as a PREFIX: measured on tmux 3.6a (private socket), `has-session -t
 * agent-foo` answered 0 while only `agent-foo2` existed, and `list-panes -t
 * agent-foo` listed agent-foo2's panes. So a liveness check called a dead agent
 * alive, and a capture or a keystroke aimed at it landed in the sibling.
 *
 * 1. the helper's forms;
 * 2. the binding that would silently break: runAsUserForTmuxArgs maps a target
 *    to the agent's own OS user, and must still find it in the exact form;
 * 3. a REAL caller against a REAL, isolated tmux server: getClaudePidForSession
 *    for a missing session must not answer with the sibling's claude;
 * 4. a source pin over src/: every tmux `-t` argument goes through
 *    exactTmuxTarget (or is a literal `=...`), with positive controls.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exactTmuxTarget, sessionOfTmuxTarget } from '../tmux-target.js'
import { runAsUserForTmuxArgs } from '../web/agent-process.js'

const SK = 'send' + '-keys'

describe('exactTmuxTarget', () => {
  it('a bare session name becomes =NAME: (the form every subcommand accepts)', () => {
    expect(exactTmuxTarget('agent-foo')).toBe('=agent-foo:')
    expect(exactTmuxTarget('marveen-channels')).toBe('=marveen-channels:')
  })
  it('a target that already names a window or pane only gets the =', () => {
    expect(exactTmuxTarget('agent-foo:0.1')).toBe('=agent-foo:0.1')
    expect(exactTmuxTarget('monitor:3')).toBe('=monitor:3')
  })
  it('is idempotent', () => {
    expect(exactTmuxTarget(exactTmuxTarget('agent-foo'))).toBe('=agent-foo:')
  })
  it('sessionOfTmuxTarget strips the = and the window/pane part', () => {
    expect(sessionOfTmuxTarget('=agent-foo:')).toBe('agent-foo')
    expect(sessionOfTmuxTarget('=agent-foo:0.1')).toBe('agent-foo')
    expect(sessionOfTmuxTarget('agent-foo')).toBe('agent-foo')
  })
})

describe('runAsUserForTmuxArgs still finds the agent in the exact form', () => {
  const map = new Map([['agent-alice', 'alice']])
  it('=agent-alice: -> alice (the session map is keyed on the bare name)', () => {
    expect(runAsUserForTmuxArgs([SK, '-t', exactTmuxTarget('agent-alice'), 'Enter'], map)).toBe('alice')
    expect(runAsUserForTmuxArgs(['capture-pane', '-t', '=agent-alice:0.0', '-p'], map)).toBe('alice')
  })
  it('a sibling with a longer name is NOT the agent', () => {
    expect(runAsUserForTmuxArgs([SK, '-t', exactTmuxTarget('agent-alice2'), 'Enter'], map)).toBeNull()
  })
})

// --- a real tmux server, isolated by TMUX_TMPDIR (never the fleet's server) ---
let tmuxBin: string | null = null
try { tmuxBin = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf-8' }).trim() || null } catch { tmuxBin = null }
const SOCKDIR = mkdtempSync(join(tmpdir(), 'tmuxexact-'))
const savedEnv = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR }
const startedSessions: string[] = []
function isolatedTmux(args: string[]): string {
  return execFileSync(tmuxBin as string, args, { encoding: 'utf-8', env: { ...process.env, TMUX: '', TMUX_TMPDIR: SOCKDIR } })
}
afterAll(() => {
  if (tmuxBin) {
    for (const s of startedSessions) {
      try {
        // Only ever on the isolated server: re-check the socket before touching anything.
        const sock = isolatedTmux(['display-message', '-p', '-t', `=${s}:`, '#{socket_path}']).trim()
        if (sock.startsWith(SOCKDIR) || sock.startsWith(join('/private', SOCKDIR))) isolatedTmux(['kill-session', '-t', `=${s}:`])
      } catch { /* already gone */ }
    }
  }
  process.env.TMUX = savedEnv.TMUX
  process.env.TMUX_TMPDIR = savedEnv.TMUX_TMPDIR
  if (savedEnv.TMUX === undefined) delete process.env.TMUX
  if (savedEnv.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR
  rmSync(SOCKDIR, { recursive: true, force: true })
})

describe.skipIf(!tmuxBin)('a real caller against an isolated tmux server', () => {
  it('getClaudePidForSession(agent-foo) is null while only agent-foo2 runs a claude', async () => {
    // A process NAMED claude: a symlink to sleep, so `ps -o comm=` ends in /claude.
    // (A COPY of /bin/sleep is SIGKILLed by macOS code signing, measured rc 137.)
    const fakeClaude = join(SOCKDIR, 'claude')
    symlinkSync('/bin/sleep', fakeClaude)
    isolatedTmux(['new-session', '-d', '-s', 'agent-foo2', `${fakeClaude} 300`])
    startedSessions.push('agent-foo2')
    const sock = isolatedTmux(['display-message', '-p', '-t', '=agent-foo2:', '#{socket_path}']).trim()
    expect(sock.includes(SOCKDIR.replace(/^\/private/, ''))).toBe(true) // isolation proven before any caller runs

    // The caller reads process.env at exec time: point it at the isolated server.
    process.env.TMUX = ''
    process.env.TMUX_TMPDIR = SOCKDIR
    const { getClaudePidForSession } = await import('../channel-coordinator/liveness.js')
    let siblingPid: number | null = null
    for (let i = 0; i < 20 && siblingPid == null; i++) {
      siblingPid = getClaudePidForSession('agent-foo2')
      if (siblingPid == null) await new Promise((r) => setTimeout(r, 100))
    }
    expect(siblingPid).toBeGreaterThan(1) // positive control: the instrument sees a claude
    expect(getClaudePidForSession('agent-foo')).toBeNull() // the prefix match is gone
  })
})

// --- source pin over src/ ---
const TMUX_SUB = /'(send-keys|capture-pane|has-session|kill-session|list-panes|display-message|respawn-pane|set-option|select-window|kill-window|rename-window|link-window|pipe-pane|resize-window|set-environment|show-environment)'/
export function bareTmuxTargets(source: string): string[] {
  const out: string[] = []
  source.split('\n').forEach((line, i) => {
    if (TMUX_SUB.test(line)) {
      const re = /'-t',\s*([^,\]\s][^,\]]*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        const arg = m[1].trim()
        if (!arg.startsWith('exactTmuxTarget(') && !arg.startsWith("'=") && !arg.startsWith('`=')) out.push(`${i + 1}: ${arg}`)
      }
    }
    // A tmux command line built as a string (execSync): `${tmux} <sub> -t ${x}`.
    const tm = /\$\{tmux\w*\}\s+[a-z-]+\s+-t\s+\$\{(?!shQuote\(exactTmuxTarget\()/i.exec(line)
    if (tm) out.push(`${i + 1}: string target`)
  })
  return out
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (e === '__tests__' || e === 'node_modules') continue
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('source pin: every tmux -t target under src/ is exact', () => {
  it('positive controls: the old forms are caught', () => {
    expect(bareTmuxTargets(`execFileSync(TMUX, ['${SK}', '-t', session, 'Enter'])`)).toHaveLength(1)
    expect(bareTmuxTargets(`runTmux(host, ['capture-pane', '-t', ctx.session, '-p'])`)).toHaveLength(1)
    expect(bareTmuxTargets("execSync(`${tmuxPath} list-panes -t ${session} -F '#{pane_pid}'`)")).toHaveLength(1)
  })
  it('negative controls: exact forms and non-tmux -t pass', () => {
    expect(bareTmuxTargets(`execFileSync(TMUX, ['${SK}', '-t', exactTmuxTarget(session), 'Enter'])`)).toEqual([])
    expect(bareTmuxTargets(`execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath])`)).toEqual([])
    expect(bareTmuxTargets("execSync(`${tmuxPath} list-panes -t ${shQuote(exactTmuxTarget(session))} -F x`)")).toEqual([])
  })
  it('no bare tmux target anywhere under src/', () => {
    const root = join(__dirname, '..')
    const hits: string[] = []
    for (const f of tsFiles(root)) for (const h of bareTmuxTargets(readFileSync(f, 'utf-8'))) hits.push(`${f.slice(root.length + 1)}:${h}`)
    expect(hits).toEqual([])
  })
})
