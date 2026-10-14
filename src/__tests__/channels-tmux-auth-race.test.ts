// CHANNELSAUTHRACE923: the channels session came up "Not logged in" when the
// dashboard's worker session created the tmux server first (measured on a
// container restart, 2026-09-23, tmux 3.3a). Replayed here with a REAL tmux on
// an isolated socket, running the auth block cut verbatim out of
// scripts/channels.sh -- the race itself, not a model of it.
// The pane writes its answer to a temp file and renames it: a shell creates
// the `>` target before writing, and a faster machine (CI, #1534) read the
// empty file.
// The race test runs the REAL primary launch lines cut out of channels.sh (with
// a stand-in $CLAUDE), and a source pin covers both new-session call sites, so
// dropping the wiring (not just the helper) turns the suite red (#1534 review).
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync, statSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SH = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0

function authBlock(): string {
  const start = SH.indexOf('_tmux_set_auth_globals() {')
  const end = SH.indexOf('unset _auth_file', start)
  if (start < 0 || end < 0) throw new Error('auth block not found in channels.sh')
  // LAUNCHQUOTEREST1008: AUTH_PANE_ENV quotes the auth file with the script's
  // own sh_single_quote, defined earlier in channels.sh; the cut-out block needs
  // that definition too (read from the script, not copied).
  const helper = (SH.match(/^sh_single_quote\(\) \{.*\}$/m) ?? [''])[0]
  expect(helper, 'sh_single_quote definition in channels.sh').not.toBe('')
  return helper + '\n' + SH.slice(start, end + 'unset _auth_file'.length)
}

const PRIMARY_LAUNCH = '$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR"'

// The primary launch as shipped: the new-session line (with its continuation)
// through the _tmux_set_auth_globals call that must follow it.
function primaryLaunch(): string {
  const start = SH.indexOf(PRIMARY_LAUNCH)
  const end = SH.indexOf('_tmux_set_auth_globals', start)
  if (start < 0 || end < 0) throw new Error('primary launch not found in channels.sh')
  return SH.slice(start, end + '_tmux_set_auth_globals'.length)
}

let dir = ''
let sock = ''
afterEach(() => {
  if (sock) spawnSync('tmux', ['-S', sock, 'kill-server'])
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function bash(script: string, env: Record<string, string> = {}): string {
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  })
}

describe.skipIf(!HAS_TMUX)('channels.sh tmux auth (real tmux, isolated socket)', () => {
  it('root cause: start-server alone keeps no server, so set-environment -g is lost', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    sock = join(dir, 's')
    const out = bash(`tmux -S ${sock} start-server; tmux -S ${sock} set-environment -g X 1 2>&1; echo rc=$?`)
    expect(out).toMatch(/no server running/)
  })

  it('the worker wins the race: the channels pane (launched by the real channels.sh lines) still has the token, and the server global env gets it after new-session', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    mkdirSync(join(dir, 'store'))
    sock = join(dir, 's')
    const out = join(dir, 'pane-env')
    // stand-in for the claude binary: report the token the pane got, then idle
    const fake = join(dir, 'fake-claude')
    writeFileSync(fake, `#!/bin/sh\nprintenv CLAUDE_CODE_OAUTH_TOKEN > ${out}.tmp; mv ${out}.tmp ${out}; sleep 30\n`)
    chmodSync(fake, 0o755)
    const log = bash(`
      TMUX="tmux -S ${sock}"
      SESSION=channels INSTALL_DIR=${dir} CLAUDE=${fake}
      STATE_DIR_ENV= MCP_BATCH_ENV= CFG_ENV= MODEL_FLAG= PLUGIN_ID=x EXTRA_CHANNELS=
      ${authBlock()}
      echo "tmux=$(tmux -V) auth=\${AUTH_PANE_ENV:+set}"
      # the dashboard worker creates the server first, WITHOUT the token
      env -u CLAUDE_CODE_OAUTH_TOKEN tmux -S ${sock} new-session -d -s worker "sleep 30"
      ${primaryLaunch()}
    `, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })
    // the pane sources a 0600 file instead of receiving the token in argv (TOKENARGV929)
    expect(log).toMatch(/auth=set$/m)
    expect(statSync(join(dir, 'store', '.channels-pane-auth')).mode & 0o777).toBe(0o600)
    for (let i = 0; i < 100 && !existsSync(out); i++) execFileSync('sleep', ['0.1'])
    expect(readFileSync(out, 'utf-8').trim()).toBe('sk-ant-oat01-test')
    const globalEnv = execFileSync('tmux', ['-S', sock, 'show-environment', '-g', 'CLAUDE_CODE_OAUTH_TOKEN'], { encoding: 'utf-8' })
    expect(globalEnv.trim()).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test')
  })

  it('without the fix (no -e, no second set-environment) the same race leaves the pane without the token', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    sock = join(dir, 's')
    const out = join(dir, 'pane-env')
    bash(`
      tmux -S ${sock} start-server
      tmux -S ${sock} set-environment -g CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null
      env -u CLAUDE_CODE_OAUTH_TOKEN tmux -S ${sock} new-session -d -s worker "sleep 30"
      tmux -S ${sock} new-session -d -s channels "printenv CLAUDE_CODE_OAUTH_TOKEN > ${out}.tmp; echo rc=\\$? >> ${out}.tmp; mv ${out}.tmp ${out}; sleep 30"
    `, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })
    for (let i = 0; i < 100 && !existsSync(out); i++) execFileSync('sleep', ['0.1'])
    expect(readFileSync(out, 'utf-8')).not.toContain('sk-ant-oat01-test')
  })

  it('no token configured: nothing sourced, no auth file, nothing breaks', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    mkdirSync(join(dir, 'store'))
    sock = join(dir, 's')
    const n = bash(`TMUX="tmux -S ${sock}"; INSTALL_DIR=${dir}; ${authBlock()}; echo "[\${AUTH_PANE_ENV}]"`)
    expect(n.trim().split('\n').pop()).toBe('[]')
    expect(existsSync(join(dir, 'store', '.channels-pane-auth'))).toBe(false)
  })

  // #1647 review (Geri): the auth file is written to a NEW 0600 file and renamed
  // over the name, so a pre-existing wider-mode file or a planted symlink never
  // receives the value.
  it('a pre-existing 0644 auth file: replaced by a 0600 file, never written in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxauthfile-'))
    mkdirSync(join(dir, 'store'))
    const f = join(dir, 'store', '.channels-pane-auth')
    writeFileSync(f, 'old\n')
    chmodSync(f, 0o644)
    const ino = statSync(f).ino
    bash(`TMUX="tmux -S ${join(dir, 's')}"; INSTALL_DIR=${dir}; ${authBlock()}`, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-filemode' })
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(statSync(f).ino).not.toBe(ino) // a new file, not the old one truncated
    expect(readFileSync(f, 'utf-8')).toContain('sk-ant-oat01-filemode')
  })

  it('a symlink planted at the auth path: its target is never written, the link itself is replaced', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxauthfile-'))
    mkdirSync(join(dir, 'store'))
    const target = join(dir, 'elsewhere')
    writeFileSync(target, 'untouched\n')
    chmodSync(target, 0o644)
    const f = join(dir, 'store', '.channels-pane-auth')
    symlinkSync(target, f)
    bash(`TMUX="tmux -S ${join(dir, 's')}"; INSTALL_DIR=${dir}; ${authBlock()}`, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-symlink' })
    expect(readFileSync(target, 'utf-8')).toBe('untouched\n')
    expect(lstatSync(f).isSymbolicLink()).toBe(false)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  // TOKENARGV929: when OUR new-session creates the tmux server, the server
  // process keeps that command line for life. The token must appear in NO
  // process's command line. Counted, never printed.
  const TOKEN = 'sk-ant-oat01-argvprobe929'
  // Only the processes of THIS test's tmux: the server (its command line holds
  // the socket path) and whatever runs under it. A whole-host count would also
  // see the shell that launched the test run, if its own command text holds the
  // probe string -- that is the caller, not what channels.sh leaves behind.
  const countInPs = () => {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' }).split('\n')
      .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l); return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null })
      .filter((r): r is { pid: number; ppid: number; cmd: string } => r !== null)
    const ours = new Set(rows.filter((r) => r.cmd.includes(sock)).map((r) => r.pid))
    expect(ours.size).toBeGreaterThan(0) // the tmux server was found: the count below measures something
    for (let grew = true; grew;) {
      grew = false
      for (const r of rows) if (!ours.has(r.pid) && ours.has(r.ppid)) { ours.add(r.pid); grew = true }
    }
    return rows.filter((r) => ours.has(r.pid)).reduce((n, r) => n + r.cmd.split(TOKEN).length - 1, 0)
  }

  it('the token is in no process command line when the channels launch creates the tmux server', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxargv-'))
    mkdirSync(join(dir, 'store'))
    sock = join(dir, 's')
    const out = join(dir, 'pane-env')
    const fake = join(dir, 'fake-claude')
    writeFileSync(fake, `#!/bin/sh\nprintenv CLAUDE_CODE_OAUTH_TOKEN > ${out}.tmp; mv ${out}.tmp ${out}; sleep 30\n`)
    chmodSync(fake, 0o755)
    bash(`
      TMUX="tmux -S ${sock}"
      SESSION=channels INSTALL_DIR=${dir} CLAUDE=${fake} STATE_ENV_VAR=TELEGRAM_STATE_DIR
      STATE_DIR_ENV= MCP_BATCH_ENV= CFG_ENV= MODEL_FLAG= PLUGIN_ID=x EXTRA_CHANNELS=
      ${authBlock()}
      ${primaryLaunch()}
    `, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    for (let i = 0; i < 100 && !existsSync(out); i++) execFileSync('sleep', ['0.1'])
    // the pane still got the token ...
    expect(readFileSync(out, 'utf-8').trim()).toBe(TOKEN)
    // ... and no command line carries it, the tmux server's included
    expect(countInPs()).toBe(0)
  })

  it('negative control: the old "new-session -e TOKEN=..." launch leaves the token in the server command line', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxargv-'))
    sock = join(dir, 's')
    bash(`tmux -S ${sock} new-session -d -s channels -e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN" "sleep 30"`, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(countInPs()).toBeGreaterThan(0)
  })
})

describe('channels.sh tmux auth wiring (source pin)', () => {
  const launches = SH.split('\n').filter(l => /^\s*(env -u "\$STATE_ENV_VAR" )?\$TMUX new-session -d -s "\$SESSION"/.test(l))

  // TOKENARGV929: no secret on a new-session argv; the pane sources it first.
  it('neither channels new-session call site passes an -e secret, and both pane commands source the auth file first', () => {
    expect(launches).toHaveLength(2)
    for (const l of launches) {
      expect(l).not.toContain('TMUX_AUTH_ENV')
      expect(l).not.toMatch(/\s-e\s/)
    }
    expect(SH).not.toContain('TMUX_AUTH_ENV')
    const paneCmds = SH.split('\n').filter(l => l.includes('${STATE_DIR_ENV}${MCP_BATCH_ENV}${CFG_ENV}'))
    expect(paneCmds).toHaveLength(2)
    for (const l of paneCmds) expect(l.trim().startsWith('"${AUTH_PANE_ENV}${STATE_DIR_ENV}')).toBe(true)
  })

  // TMUXSERVERREAP929: whichever launch creates the shared tmux server must not
  // hand it the main session's state-dir var -- the pre-respawn poller reap
  // matches that var in /proc environ and would kill the server (every agent
  // session with it). The pane still gets the var from the command's own export.
  it('both channels new-session call sites strip the state-dir var from the tmux client env', () => {
    expect(launches).toHaveLength(2)
    for (const l of launches) expect(l.trim().startsWith('env -u "$STATE_ENV_VAR" $TMUX new-session')).toBe(true)
    expect(SH).toContain('$TMUX set-environment -g -u "$STATE_ENV_VAR"')
  })

  it('the auth globals are set again right after the primary new-session', () => {
    const start = SH.indexOf(PRIMARY_LAUNCH)
    expect(start).toBeGreaterThan(SH.indexOf('_tmux_set_auth_globals() {'))
    const after = SH.slice(start).split('\n').slice(2).filter(l => !/^\s*#/.test(l))
    expect(after[0].trim()).toBe('_tmux_set_auth_globals')
  })
})
