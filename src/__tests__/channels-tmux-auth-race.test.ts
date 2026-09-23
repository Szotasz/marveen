// CHANNELSAUTHRACE923: the channels session came up "Not logged in" when the
// dashboard's worker session created the tmux server first (measured on a
// container restart, 2026-09-23, tmux 3.3a). Replayed here with a REAL tmux on
// an isolated socket, running the auth block cut verbatim out of
// scripts/channels.sh -- the race itself, not a model of it.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SH = readFileSync(join(__dirname, '..', '..', 'scripts', 'channels.sh'), 'utf-8')
const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0

function authBlock(): string {
  const start = SH.indexOf('_tmux_set_auth_globals() {')
  const end = SH.indexOf('unset _tmux_ver', start)
  if (start < 0 || end < 0) throw new Error('auth block not found in channels.sh')
  return SH.slice(start, end + 'unset _tmux_ver'.length)
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

  it('the worker wins the race: the channels pane still has the token, and the server global env gets it after new-session', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    sock = join(dir, 's')
    const out = join(dir, 'pane-env')
    bash(`
      TMUX="tmux -S ${sock}"
      ${authBlock()}
      # the dashboard worker creates the server first, WITHOUT the token
      env -u CLAUDE_CODE_OAUTH_TOKEN tmux -S ${sock} new-session -d -s worker "sleep 30"
      $TMUX new-session -d -s channels \${TMUX_AUTH_ENV[@]+"\${TMUX_AUTH_ENV[@]}"} "printenv CLAUDE_CODE_OAUTH_TOKEN > ${out}; sleep 30"
      _tmux_set_auth_globals
    `, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })
    for (let i = 0; i < 50 && !existsSync(out); i++) execFileSync('sleep', ['0.1'])
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
      tmux -S ${sock} new-session -d -s channels "printenv CLAUDE_CODE_OAUTH_TOKEN > ${out}; echo rc=\\$? >> ${out}; sleep 30"
    `, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' })
    for (let i = 0; i < 50 && !existsSync(out); i++) execFileSync('sleep', ['0.1'])
    expect(readFileSync(out, 'utf-8')).not.toContain('sk-ant-oat01-test')
  })

  it('no token configured: no -e flag, nothing breaks', () => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxrace-'))
    sock = join(dir, 's')
    const n = bash(`TMUX="tmux -S ${sock}"; ${authBlock()}; echo "\${#TMUX_AUTH_ENV[@]}"`)
    expect(n.trim().split('\n').pop()).toBe('0')
  })
})
