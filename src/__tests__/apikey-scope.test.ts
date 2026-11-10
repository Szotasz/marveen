// APIKEYSCOPE1107 (APIKULCSINDITAS1004 B): where an ANTHROPIC_API_KEY may go.
// Measured 2026-11-07 on Claude Code 2.1.319 (fake credentials, throwaway config dir): the key outranks the OAuth
// token; an interactive session with an unapproved key stops at "Detected a custom API key" (default No); `-p`
// bills the key whatever the stamp. So on a SUBSCRIPTION install the key must not reach the fleet, and on a KEY-ONLY
// install it is the fleet's credential and every sub-agent needs its approval stamp.
// The shell parts are RUN (cut out of the shipped scripts), with stub tmux / stub dirs; no real credential anywhere.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authKeyModeFrom, copyProjectsOnce, currentAuthKeyMode, envFileValue, isSharedDotClaude, isolatedDirReady, stampAllowed,
  type AuthKeyMode,
} from '../web/auth-key-mode.js'
import { buildMainSessionRespawnCmd, PANE_AUTH_PATH } from '../web/channel-monitor.js'

const REPO = process.cwd()
const LIB = join(REPO, 'scripts', 'lib', 'auth-key-mode.sh')
const FAKE_KEY = 'fake-api-key-value-for-tests-0123456789' // no vendor prefix: the logic never looks at it
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (p = 'aks-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }

function install(env: string, token: string | null): string {
  const d = tmp('aks-inst-')
  mkdirSync(join(d, 'store'))
  writeFileSync(join(d, '.env'), env)
  if (token !== null) writeFileSync(join(d, 'store', '.claude-oauth-token'), token)
  return d
}
const bashMode = (dir: string) =>
  execFileSync('/bin/bash', ['-c', `. "$1" && auth_key_mode "$2"`, 'bash', LIB, dir], { encoding: 'utf-8' }).trim()

describe('the mode: bash and TS decide the same way (parity, no mode file)', () => {
  const cases: Array<[string, string, string | null, AuthKeyMode]> = [
    ['token file only', 'X=1\n', 'tok', 'subscription'],
    ['.env token only', 'CLAUDE_CODE_OAUTH_TOKEN=tok\n', null, 'subscription'],
    ['token + key', `CLAUDE_CODE_OAUTH_TOKEN=tok\nANTHROPIC_API_KEY=${FAKE_KEY}\n`, null, 'subscription'],
    ['token file + key', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, 'tok', 'subscription'],
    ['key only', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, null, 'keyonly'],
    ['empty token file + key', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, '', 'keyonly'],
    ['whitespace-only token file + key (no token, as the launchers read it)', `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, ' \n\t\n', 'keyonly'],
    ['empty key line', 'ANTHROPIC_API_KEY=\n', null, 'none'],
    ['nothing', 'X=1\n', null, 'none'],
    ['first line wins (as channels.sh reads it)', `ANTHROPIC_API_KEY=\nANTHROPIC_API_KEY=${FAKE_KEY}\n`, null, 'none'],
  ]
  for (const [name, env, token, want] of cases) {
    it(name, () => {
      const d = install(env, token)
      const ts = currentAuthKeyMode(join(d, '.env'), join(d, 'store', '.claude-oauth-token'))
      expect(ts).toBe(want)
      expect(bashMode(d)).toBe(ts)
    })
  }
  it('envFileValue reads the first raw line, like grep | head -1 | cut -d= -f2-', () => {
    expect(envFileValue('A=1\nA=2\n', 'A')).toBe('1')
    expect(envFileValue('AB=1\n', 'A')).toBe('')
    expect(envFileValue('A=x=y\n', 'A')).toBe('x=y')
    expect(authKeyModeFrom({ envText: '', tokenFileNonEmpty: false })).toBe('none')
  })
  it('channels.sh takes its mode from the lib, and writes no mode file', () => {
    const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
    expect(src).toContain('KEY_MODE="$(auth_key_mode "$INSTALL_DIR")"')
    expect(src).not.toContain('.auth-key-mode"')
  })
})

describe('channels.sh: the key in the tmux SERVER global env only on a key-only install', () => {
  const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  const start = src.indexOf('_tmux_set_auth_globals() {')
  const fn = src.slice(start, src.indexOf('\n}\n', start) + 3)
  const run = (mode: string) => {
    const d = tmp('aks-tmux-')
    const log = join(d, 'tmux.log')
    writeFileSync(join(d, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`)
    chmodSync(join(d, 'tmux'), 0o755)
    execFileSync('/bin/bash', ['-c', `${fn}\nTMUX='${join(d, 'tmux')}'; KEY_MODE='${mode}'; ANTHROPIC_API_KEY='${FAKE_KEY}'; CLAUDE_CODE_OAUTH_TOKEN=tok; _tmux_set_auth_globals`])
    return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
  }
  it('subscription: the key is removed from the global env (-u), the token stays', () => {
    const calls = run('subscription')
    expect(calls).toContain('set-environment -g -u ANTHROPIC_API_KEY')
    expect(calls.some((c) => c.startsWith('set-environment -g ANTHROPIC_API_KEY'))).toBe(false)
    expect(calls).toContain('set-environment -g CLAUDE_CODE_OAUTH_TOKEN tok')
  })
  it('keyonly: the key goes global, as the fleet credential', () => {
    expect(run('keyonly')).toContain(`set-environment -g ANTHROPIC_API_KEY ${FAKE_KEY}`)
  })
  it('none: removed', () => {
    expect(run('none')).toContain('set-environment -g -u ANTHROPIC_API_KEY')
  })
})

describe('the three main-session respawn paths source the pane-auth file BEFORE their config branch', () => {
  for (const f of ['scripts/channel-watchdog.sh', 'scripts/stuck-modal-guard.sh']) {
    const src = readFileSync(join(REPO, f), 'utf-8')
    it(`${f}: the respawn command carries the source before CFG_ENV`, () => {
      expect(src).toMatch(/PANE_AUTH_SRC="\{ \[ ! -f \$\(sh_single_quote "\$INSTALL_DIR\/store\/\.channels-pane-auth"\)/)
      const respawn = src.split('\n').find((l) => /RESPAWN_CMD="export PATH=/.test(l)) ?? ''
      expect(respawn.indexOf('${PANE_AUTH_SRC}')).toBeGreaterThan(-1)
      expect(respawn.indexOf('${PANE_AUTH_SRC}')).toBeLessThan(respawn.indexOf('${CFG_ENV}'))
    })
    it(`${f}: an own login (explicit/rotated) unsets both inherited credentials`, () => {
      expect(src).toContain('CFG_ENV="export CLAUDE_CONFIG_DIR=$(sh_single_quote "$_cfg_dir") && unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && "')
    })
  }
  it('the source form keeps the chain going when the file is missing, and exports the key when present', () => {
    const d = tmp('aks-src-')
    const file = join(d, '.channels-pane-auth')
    const chain = (f: string) => `{ [ ! -f '${f}' ] || . '${f}'; } && printf '%s' "\${ANTHROPIC_API_KEY:-none}"`
    expect(execFileSync('/bin/bash', ['-c', chain(file)], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })).toBe('none')
    writeFileSync(file, `export ANTHROPIC_API_KEY='${FAKE_KEY}'\n`)
    expect(execFileSync('/bin/bash', ['-c', chain(file)], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })).toBe(FAKE_KEY)
  })
  const base = { claudePath: '/x/claude', pluginId: 'telegram@claude-plugins-official', channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/s' } }
  it('channel-monitor: buildMainSessionRespawnCmd sources it before the config branch, every mode', () => {
    const variants = [
      { isolatedConfigDir: null, fleetToken: true },
      { isolatedConfigDir: '/cfg', ownCredentials: true },
      { isolatedConfigDir: '/cfg', fleetToken: true },
    ]
    for (const config of variants) {
      const cmd = buildMainSessionRespawnCmd({ ...base, config } as never)
      const src = cmd.indexOf(`. '${PANE_AUTH_PATH}'`)
      expect(src, JSON.stringify(config)).toBeGreaterThan(-1)
      const cfg = cmd.indexOf('CLAUDE_CONFIG_DIR')
      if (cfg > -1) expect(src).toBeLessThan(cfg)
      expect(cmd).not.toContain(FAKE_KEY)
    }
    const own = buildMainSessionRespawnCmd({ ...base, config: { isolatedConfigDir: '/cfg', ownCredentials: true } } as never)
    expect(own.indexOf('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY')).toBeGreaterThan(own.indexOf(`. '${PANE_AUTH_PATH}'`))
  })
})

describe('channels.sh: a new-session that creates the server gets no key off key-only', () => {
  const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
  it('both new-session calls carry the mode\'s env unset', () => {
    const calls = src.split('\n').filter((l) => /\$TMUX new-session -d -s "\$SESSION"/.test(l))
    expect(calls.length).toBe(2)
    for (const l of calls) expect(l).toContain('env -u "$STATE_ENV_VAR" $_AKM_ENV_UNSET $TMUX new-session')
    expect(src).toContain('[ "$KEY_MODE" = keyonly ] || _AKM_ENV_UNSET="-u ANTHROPIC_API_KEY"')
  })
})

describe('a key-only fleet agent runs on the very key it is stamped for', () => {
  it('the host key is exported by reference and stamped, only for agents that keep the key', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
    // SUBPLANTOKEN1110 follow-up: never for a plan-token launch either.
    expect(src).toContain("if (!stampKey && keyMode === 'keyonly' && needsFleetOauth && !configuredConfigDir && !ownTokenFile && !planToken) {")
    expect(src).toMatch(/apiKeyEnv = `export ANTHROPIC_API_KEY=\$\{launchSecretRef\(`agent-\$\{name\}-api-key`, hostKey\)\} && `\n\s+stampKey = hostKey/)
  })
})

describe('the approval stamp: never the shared ~/.claude.json on a subscription install', () => {
  it('stampAllowed by mode and path; a symlink to the shared file counts as the shared file', () => {
    const home = tmp('aks-home-')
    writeFileSync(join(home, '.claude.json'), '{}')
    const iso = tmp('aks-iso-')
    writeFileSync(join(iso, '.claude.json'), '{}')
    const link = join(tmp('aks-link-'), '.claude.json')
    symlinkSync(join(home, '.claude.json'), link)
    expect(stampAllowed(join(home, '.claude.json'), 'subscription', home)).toBe(false)
    expect(stampAllowed(link, 'subscription', home)).toBe(false)
    expect(isSharedDotClaude(link, home)).toBe(true)
    expect(stampAllowed(join(iso, '.claude.json'), 'subscription', home)).toBe(true)
    // key-only: the key IS the install's credential, there is no OAuth for it to shadow (Samu 72235)
    expect(stampAllowed(join(home, '.claude.json'), 'keyonly', home)).toBe(true)
    expect(stampAllowed(join(home, '.claude.json'), 'none', home)).toBe(false)
  })
})

describe('moving an authMode=api agent off the shared ~/.claude: nothing lost, nothing widened, no half success', () => {
  it('copyProjectsOnce copies the agent dir once, modes kept, symlinks not followed, never overwrites', () => {
    const src = tmp('aks-src-proj-')
    const dst = join(tmp('aks-dst-'), 'projects')
    const enc = '-Users-x-agents-a'
    mkdirSync(join(src, enc, 'memory'), { recursive: true })
    chmodSync(join(src, enc), 0o700)
    writeFileSync(join(src, enc, 'session.jsonl'), 'secret transcript')
    chmodSync(join(src, enc, 'session.jsonl'), 0o600)
    writeFileSync(join(src, enc, 'memory', 'MEMORY.md'), 'm')
    // a mode the usual umask (022) would cut (0775 -> 0755): the copy keeps the source mode exactly
    chmodSync(join(src, enc, 'memory'), 0o775)
    symlinkSync('/etc/hosts', join(src, enc, 'outside'))
    expect(copyProjectsOnce(src, dst, enc)).toBe(true)
    expect(readFileSync(join(dst, enc, 'session.jsonl'), 'utf-8')).toBe('secret transcript')
    expect(statSync(join(dst, enc)).mode & 0o777).toBe(0o700)
    expect(statSync(join(dst, enc, 'session.jsonl')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dst, enc, 'memory')).mode & 0o777).toBe(0o775)
    expect(existsSync(join(dst, enc, 'outside'))).toBe(false)
    writeFileSync(join(src, enc, 'session.jsonl'), 'changed')
    expect(copyProjectsOnce(src, dst, enc)).toBe(true)
    expect(readFileSync(join(dst, enc, 'session.jsonl'), 'utf-8')).toBe('secret transcript')
  })
  it('only a COMPLETE copy counts: a leftover from an interrupted copy is redone, a linked project dir is refused', () => {
    const src = tmp('aks-src-int-')
    const dst = join(tmp('aks-dst-int-'), 'projects')
    const enc = 'a'
    mkdirSync(join(src, enc))
    writeFileSync(join(src, enc, 't.jsonl'), 'full')
    mkdirSync(join(dst, `${enc}.copying`), { recursive: true })
    writeFileSync(join(dst, `${enc}.copying`, 'half'), 'x')
    expect(copyProjectsOnce(src, dst, enc)).toBe(true)
    expect(readFileSync(join(dst, enc, 't.jsonl'), 'utf-8')).toBe('full')
    expect(existsSync(join(dst, enc, 'half'))).toBe(false)
    expect(existsSync(join(dst, `${enc}.copying`))).toBe(false)
    const linked = tmp('aks-src-link-')
    symlinkSync(join(src, enc), join(linked, 'b'))
    const linkedDst = join(tmp('aks-dst-l-'), 'projects')
    expect(copyProjectsOnce(linked, linkedDst, 'b')).toBe(false)
    expect(existsSync(linkedDst)).toBe(false) // refused before anything is created
  })
  it('a copy that breaks off half-way leaves NO project dir, so the next launch copies again', () => {
    const src = tmp('aks-src-half-')
    const dst = join(tmp('aks-dst-half-'), 'projects')
    const enc = 'h'
    mkdirSync(join(src, enc))
    writeFileSync(join(src, enc, 'a.jsonl'), 'first')
    writeFileSync(join(src, enc, 'z.jsonl'), 'last')
    chmodSync(join(src, enc, 'z.jsonl'), 0o000) // unreadable: the copy fails after a.jsonl
    try {
      expect(copyProjectsOnce(src, dst, enc)).toBe(false)
      expect(existsSync(join(dst, enc))).toBe(false)
    } finally {
      chmodSync(join(src, enc, 'z.jsonl'), 0o600)
    }
    expect(copyProjectsOnce(src, dst, enc)).toBe(true)
    expect(readFileSync(join(dst, enc, 'z.jsonl'), 'utf-8')).toBe('last')
  })

  it('a copy that fails is reported, not swallowed', () => {
    const src = tmp('aks-src-bad-')
    const enc = 'p'
    mkdirSync(join(src, enc))
    const blocker = join(tmp('aks-blk-'), 'file')
    writeFileSync(blocker, 'x') // the destination root is a FILE: mkdir under it fails
    expect(copyProjectsOnce(src, join(blocker, 'projects'), enc)).toBe(false)
  })
  it('isolatedDirReady: only a parsing .claude.json past onboarding', () => {
    const d = tmp('aks-ready-')
    expect(isolatedDirReady(d)).toBe(false)
    writeFileSync(join(d, '.claude.json'), '{broken')
    expect(isolatedDirReady(d)).toBe(false)
    writeFileSync(join(d, '.claude.json'), '{"hasCompletedOnboarding":false}')
    expect(isolatedDirReady(d)).toBe(false)
    writeFileSync(join(d, '.claude.json'), '{"hasCompletedOnboarding":true}')
    expect(isolatedDirReady(d)).toBe(true)
  })
  it('startAgentProcess refuses the launch when any of the three steps fails, and stamps only where allowed', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toContain('if (!isolated || !copied || !isolatedDirReady(isolated)) {')
    expect(src).toContain("return { ok: false, error: 'authMode=api: isolated config dir could not be provisioned' }")
    expect(src).toContain('if (!stampAllowed(target, keyMode)) {')
    expect(src).toContain("return { ok: false, error: 'authMode=api: no API key (vault agent-<name>-api-key or .env ANTHROPIC_API_KEY)' }")
    // the api key is exported by reference (launchSecretRef), never inlined
    expect(src).toMatch(/apiKeyEnv = `export ANTHROPIC_API_KEY=\$\{launchSecretRef\(`agent-\$\{name\}-api-key`, agentApiKey\)\} && `/)
  })
})

describe('the owner-facing texts (doctor line, one-time notice)', () => {
  const notice = (mode: string, lang: string) =>
    execFileSync('/bin/bash', ['-c', `. "$1" && auth_key_mode_notice "$2" "$3"`, 'bash', LIB, mode, lang], { encoding: 'utf-8' }).trim()
  it('one per mode and language, naming the variable, never a value; none says nothing', () => {
    for (const m of ['subscription', 'keyonly']) {
      for (const l of ['hu', 'en']) {
        const t = notice(m, l)
        expect(t, `${m}/${l}`).toContain('ANTHROPIC_API_KEY')
        expect(t).not.toMatch(/sk-ant-/)
      }
    }
    // Samu 72311: the notice tells the truth for the version it ships in. B alone: the main agent still got the key.
    // MAINAUTH1107 (A): the main agent no longer gets it either, unless its own authMode is api (the switch's sentence
    // and a new notice stamp come with D).
    // MAINAUTHSWITCH1107 (D, Marveen copy round 72333): no config word for the owner; the switch named where it is
    expect(notice('subscription', 'en')).toContain('only the agents whose authentication is set to the API key on the dashboard get it')
    expect(notice('subscription', 'en')).toContain('on its card, Settings tab, in the Authentication group')
    expect(notice('subscription', 'hu')).toContain('amelyeknél a dashboardon API-kulcsos hitelesítés van beállítva')
    expect(notice('subscription', 'hu')).toContain('a kártyája Beállítások fülén, a Hitelesítés csoportban van')
    for (const l of ['en', 'hu'] as const) expect(notice('subscription', l)).not.toContain('authMode=api')
    expect(notice('none', 'hu')).toBe('')
  })
  it('channels.sh sends it once: the stamp only after notify.sh succeeded, in the background', () => {
    const src = readFileSync(join(REPO, 'scripts', 'channels.sh'), 'utf-8')
    expect(src).toContain('( bash "$INSTALL_DIR/scripts/notify.sh" "$_notice_text" >/dev/null 2>&1 && : > "$_notice_stamp" ) &')
    expect(src).toContain('_notice_stamp="$INSTALL_DIR/store/.notice-apikey-scope-switch-1107"')
  })
})
