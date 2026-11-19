// INSTNONINTER1118: install-linux.sh --non-interactive (docs/install-non-interactive.md). The REAL blocks are sliced
// out of the script and run with bash, as the other installer tests do; the installer itself never runs. Every slice
// is checked for host-changing commands before it runs, and the ones that touch files get a fresh temp dir.
//   - the start-of-run check: missing values are named (exit 1), a secret given as an env VALUE is refused, auth is
//     the pre-placed store/.claude-oauth-token, and without the flag (the Bridge's MARVEEN_NONINTERACTIVE=1 run) the
//     block does nothing;
//   - every prompt is answered without touching stdin; a secret comes from its file into the SAME variable the
//     interactive read fills, and nowhere else (the whole shell state holds it once, nothing prints it);
//   - pairing is skipped and the end of the run says so;
//   - the Bridge contract: every `read -r?p` line the Bridge's derive-headless.mjs maps is still there, byte for byte.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')
const LANG = join(ROOT, 'install-lang.sh')
const between = (text: string, from: string, to: string, includeEnd = true): string => {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from.slice(0, 60)}`)
  return text.slice(a, b + (includeEnd ? to.length : 0))
}
// A slice may not name these commands (the prelude stubs what the sliced blocks call); refused before it runs.
const FORBIDDEN = /(?<![-\w/.@$])(dscl|launchctl|useradd|chown|wget|rm|mv|cp|ln|npm|apt-get|dnf|brew|exec|source|tmux)(?![-\w/.@])/
const refuse = (slice: string) => {
  const code = slice.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  const m = code.match(FORBIDDEN)
  if (m) throw new Error(`refusing to run an installer slice on the host: it names ${m[0]}`)
}
const tmp: string[] = []
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'inst-ni-')); tmp.push(d); return d }
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

// Host-changing commands as stubs that only print. `_t` is the real one (install-lang.sh, sourced in the prelude).
const PRELUDE = [
  'set -e',
  `. '${LANG}'`,
  'BOLD="" DIM="" GREEN="" ORANGE="" RED="" BLUE="" NC=""',
  'ok() { echo "ok: $*"; }', 'warn() { echo "warn: $*"; }', 'fail() { echo "FAIL: $*"; exit 1; }',
  'sudo() { echo "STUB sudo $*"; }', 'systemctl() { echo "STUB systemctl $*"; }', 'pipx() { echo "STUB pipx $*"; }',
  'curl() { echo "{\\"ok\\":true}"; }', 'claude() { echo "STUB claude $*"; return 1; }', 'stty() { echo "STUB stty $*"; }',
  'sleep() { :; }', 'bash() { echo "STUB bash $*"; }',
  'dump() { local v; for v in "$@"; do if declare -p "$v" >/dev/null 2>&1; then declare -p "$v"; else echo "unset $v"; fi; done; }',
].join('\n')
// The flag's own helpers (INSTALL_NONINTERACTIVE=0 .. ni_answer), the start-of-run check, service_auth_present.
const NI_HELPERS = between(SCRIPT, 'INSTALL_NONINTERACTIVE=0\n', '\n}\n')
const NI_CHECK = between(SCRIPT, 'if ni_on; then\n  ni_stop()', '\n  unset __s __need __files __v\nfi\n')
const AUTH_FN = between(SCRIPT, 'service_auth_present() {', '\n}\n')

type Env = Record<string, string>
// Run a script; stdin is a sentinel line, so a prompt that reads stdin would show STDIN-WAS-READ in a variable.
const bash = (script: string, env: Env = {}, input = 'STDIN-WAS-READ\nSTDIN-WAS-READ\nSTDIN-WAS-READ\n') =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '', ...env } })

// A checkout with the pre-placed token (the official auth path of the mode).
const checkout = (withToken = true, withPkg = true) => {
  const d = tempDir()
  mkdirSync(join(d, 'store'))
  if (withPkg) writeFileSync(join(d, 'package.json'), '{}')
  if (withToken) writeFileSync(join(d, 'store', '.claude-oauth-token'), 'sk-ant-oat01-' + 'x'.repeat(50), { mode: 0o600 })
  return d
}
const secretFile = (content: string) => {
  const f = join(tempDir(), 'secret')
  writeFileSync(f, content, { mode: 0o600 })
  return f
}

describe('the start-of-run check (before any step)', () => {
  const check = (env: Env, opts: { flag?: boolean; admin?: boolean; dir?: string } = {}) => {
    refuse(NI_HELPERS + NI_CHECK + AUTH_FN)
    return bash([
      PRELUDE, NI_HELPERS, AUTH_FN,
      `INSTALL_DIR='${opts.dir ?? checkout()}'`, `ADMIN_PREREQ=${opts.admin ? 1 : 0}`,
      `INSTALL_NONINTERACTIVE=${opts.flag === false ? 0 : 1}`,
      NI_CHECK,
      'echo "PASSED choice=${NI_PROVIDER_CHOICE:-}"',
    ].join('\n'), env)
  }
  const TG = () => ({ MARVEEN_OWNER_NAME: 'Teszt Elek', MARVEEN_BOT_NAME: 'Robi', MARVEEN_CHANNEL: 'telegram', MARVEEN_TELEGRAM_TOKEN_FILE: secretFile('123456:AAbb\n') })

  it('happy path: each channel with its values passes and maps to the menu number', () => {
    expect(check(TG()).stdout).toContain('PASSED choice=1')
    const base = { MARVEEN_OWNER_NAME: 'O', MARVEEN_BOT_NAME: 'B' }
    expect(check({ ...base, MARVEEN_CHANNEL: 'slack', MARVEEN_SLACK_BOT_TOKEN_FILE: secretFile('xoxb-1'), MARVEEN_SLACK_APP_TOKEN_FILE: secretFile('xapp-1') }).stdout).toContain('PASSED choice=2')
    expect(check({ ...base, MARVEEN_CHANNEL: 'discord', MARVEEN_DISCORD_BOT_TOKEN_FILE: secretFile('d'), MARVEEN_DISCORD_CHANNEL_ID: '1', MARVEEN_DISCORD_USER_ID: '2' }).stdout).toContain('PASSED choice=3')
    expect(check({ ...base, MARVEEN_CHANNEL: 'gromzo' }).stdout).toContain('PASSED choice=4')
    expect(check({ ...base, MARVEEN_CHANNEL: 'teams', MARVEEN_TEAMS_BOT_APP_ID: 'a', MARVEEN_TEAMS_BOT_TENANT_ID: 't', MARVEEN_TEAMS_BOT_APP_PASSWORD_FILE: secretFile('pw') }).stdout).toContain('PASSED choice=5')
  })

  it.each([
    ['MARVEEN_OWNER_NAME', {}],
    ['MARVEEN_BOT_NAME', {}],
    ['MARVEEN_CHANNEL', {}],
    ['MARVEEN_TELEGRAM_TOKEN_FILE', {}],
    ['MARVEEN_SLACK_APP_TOKEN_FILE', { MARVEEN_CHANNEL: 'slack', MARVEEN_SLACK_BOT_TOKEN_FILE: 'SET' }],
    ['MARVEEN_DISCORD_USER_ID', { MARVEEN_CHANNEL: 'discord', MARVEEN_DISCORD_BOT_TOKEN_FILE: 'SET', MARVEEN_DISCORD_CHANNEL_ID: '1' }],
    ['MARVEEN_TEAMS_BOT_TENANT_ID', { MARVEEN_CHANNEL: 'teams', MARVEEN_TEAMS_BOT_APP_ID: 'a', MARVEEN_TEAMS_BOT_APP_PASSWORD_FILE: 'SET' }],
    ['MARVEEN_TEAMS_BOT_APP_PASSWORD_FILE', { MARVEEN_CHANNEL: 'teams', MARVEEN_TEAMS_BOT_APP_ID: 'a', MARVEEN_TEAMS_BOT_TENANT_ID: 't' }],
  ])('a missing %s is named, exit 1, nothing passes', (missing, extra) => {
    const env: Env = { ...TG(), ...extra }
    for (const k of Object.keys(env)) if (env[k] === 'SET') env[k] = secretFile('v')
    delete env[missing]
    const r = check(env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(missing)
    expect(r.stderr).toContain('Hiba (--non-interactive):')
    expect(r.stdout).not.toContain('PASSED')
  })

  it('the messages follow MARVEEN_LANG (en)', () => {
    const env: Env = { ...TG(), MARVEEN_LANG: 'en' }
    delete env.MARVEEN_BOT_NAME
    const r = check(env)
    expect(r.stderr).toContain('Error (--non-interactive): a required value is missing, set the env variable: MARVEEN_BOT_NAME')
  })

  it('an unknown channel, a two-line value, an i/y/n answer out of range: named, exit 1', () => {
    let r = check({ ...TG(), MARVEEN_CHANNEL: 'signal' })
    expect([r.status, r.stderr.includes('MARVEEN_CHANNEL (telegram|slack|discord|gromzo|teams)')]).toEqual([1, true])
    r = check({ ...TG(), MARVEEN_OWNER_NAME: 'Elek\nCLAUDE_CODE_OAUTH_TOKEN=x' })
    expect([r.status, r.stderr.includes('MARVEEN_OWNER_NAME')]).toEqual([1, true])
    r = check({ ...TG(), MARVEEN_SWAP: 'yes' })
    expect([r.status, r.stderr.includes('MARVEEN_SWAP (i|y|n)')]).toEqual([1, true])
    r = check({ ...TG(), MARVEEN_WHISPER: 'maybe' })
    expect([r.status, r.stderr.includes('MARVEEN_WHISPER')]).toEqual([1, true])
  })

  it('a secret file that is missing, empty or only whitespace is named, exit 1', () => {
    for (const f of [join(tempDir(), 'nope'), secretFile(''), secretFile('  \n\n')]) {
      const r = check({ ...TG(), MARVEEN_TELEGRAM_TOKEN_FILE: f })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('MARVEEN_TELEGRAM_TOKEN_FILE')
    }
  })

  it('a secret file whose FIRST line is empty is refused, even when a later line has the token (only the first line is read)', () => {
    for (const body of ['\nSECRET-LATER-9f8e7d\n', '   \nSECRET-LATER-9f8e7d\n', '\r\nSECRET-LATER-9f8e7d\r\n']) {
      const r = check({ ...TG(), MARVEEN_TELEGRAM_TOKEN_FILE: secretFile(body) })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('MARVEEN_TELEGRAM_TOKEN_FILE')
      expect(r.stdout + r.stderr).not.toContain('SECRET-LATER-9f8e7d')
    }
  })

  it.each([
    'MARVEEN_TELEGRAM_TOKEN', 'MARVEEN_BOT_TOKEN', 'MARVEEN_SLACK_BOT_TOKEN', 'MARVEEN_SLACK_APP_TOKEN',
    'MARVEEN_DISCORD_BOT_TOKEN', 'MARVEEN_TEAMS_BOT_APP_PASSWORD', 'MARVEEN_API_KEY', 'MARVEEN_OAUTH_TOKEN',
  ])('a secret given as an env VALUE (%s) is refused, and the value is never printed', (name) => {
    const VALUE = 'SECRET-VALUE-9f8e7d'
    const r = check({ ...TG(), [name]: VALUE })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(name)
    expect(r.stderr).toContain('_FILE')
    expect(r.stdout + r.stderr).not.toContain(VALUE)
  })

  it('auth: without the pre-placed store/.claude-oauth-token the run stops and names the file', () => {
    const r = check(TG(), { dir: checkout(false) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('store/.claude-oauth-token')
    // an install .env carrying the token is the same service_auth_present path, accepted
    const d = checkout(false)
    writeFileSync(join(d, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-' + 'y'.repeat(50) + '\n')
    expect(check(TG(), { dir: d }).stdout).toContain('PASSED')
  })

  it('outside a checkout (no package.json) the run stops before any step', () => {
    const r = check(TG(), { dir: checkout(true, false) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('package.json')
  })

  it('--admin-prereq with the flag checks only the secret refusal and the i/y/n values', () => {
    expect(check({}, { admin: true, dir: checkout(false, false) }).stdout).toContain('PASSED')
    expect(check({ MARVEEN_BOT_TOKEN: 'x' }, { admin: true }).status).toBe(1)
  })

  it('without the flag the block does nothing: the Bridge run (MARVEEN_NONINTERACTIVE=1 + its env secrets) passes untouched', () => {
    const r = check({ MARVEEN_NONINTERACTIVE: '1', MARVEEN_BOT_TOKEN: 'x', MARVEEN_TEAMS_BOT_APP_PASSWORD: 'y' }, { flag: false, dir: checkout(false, false) })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASSED choice=')
    expect(r.stderr).toBe('')
  })
})

describe('the mode is on only with the flag', () => {
  const PARSE = between(SCRIPT, 'while [[ $# -gt 0 ]]; do\n  case "$1" in\n    --port|--web-port)', '\ndone\n')
  const on = (args: string, env: Env = {}) => {
    refuse(NI_HELPERS + PARSE)
    return bash([PRELUDE, NI_HELPERS, `set -- ${args}`, PARSE, 'ni_on && echo ON || echo OFF'].join('\n'), env).stdout.trim()
  }
  it('--non-interactive turns it on; no flag leaves it off, whatever the environment says', () => {
    expect(on('--non-interactive')).toBe('ON')
    expect(on('--port 3421 --non-interactive')).toBe('ON')
    expect(on('')).toBe('OFF')
    expect(on('', { INSTALL_NONINTERACTIVE: '1', MARVEEN_NONINTERACTIVE: '1' })).toBe('OFF')
  })
  it('--help documents it', () => {
    expect(SCRIPT).toContain('[--non-interactive]"')
    expect(SCRIPT).toContain('See docs/install-non-interactive.md.')
  })
})

describe('every prompt is answered without stdin', () => {
  const PERSONAL = between(SCRIPT, 'echo -e "${BOLD}$(_t section_4_linux)${NC}"', '\nINSTALL_STEP="bun-install"', false)
  const VARS = 'OWNER_NAME CONTINUE_MCP PROVIDER_CHOICE CHANNEL_PROVIDER BOT_TOKEN DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID OPERATOR_DISCORD_USER_ID TEAMS_BOT_APP_ID TEAMS_BOT_TENANT_ID TEAMS_BOT_APP_PASSWORD SLACK_BOT_TOKEN SLACK_APP_TOKEN BOT_NAME MAIN_AGENT_ID BRAND_NAME SERVICE_ID'
  // Run the personal-info + channel block. ni=true: the flag; the values come from env + files. ni=false: typed.
  const personal = (ni: boolean, env: Env, input?: string, choice = '') => {
    refuse(NI_HELPERS + PERSONAL)
    return bash([
      PRELUDE, NI_HELPERS, `INSTALL_NONINTERACTIVE=${ni ? 1 : 0}`, `NI_PROVIDER_CHOICE='${choice}'`, 'IS_HEADLESS=true',
      PERSONAL, 'echo "--STATE--"', `dump ${VARS}`, 'echo "--ALL--"', 'set',
    ].join('\n'), env, input)
  }
  const state = (out: string) => out.split('--STATE--\n')[1].split('--ALL--')[0]

  it('telegram: every value from env/file, stdin untouched, the token in BOT_TOKEN only and never printed', () => {
    const TOKEN = '987654321:AAsecret_token-value'
    const r = personal(true, { MARVEEN_OWNER_NAME: 'Teszt Elek', MARVEEN_BOT_NAME: 'Robi', MARVEEN_TELEGRAM_TOKEN_FILE: secretFile(`${TOKEN}\r\n`) }, undefined, '1')
    expect(r.status).toBe(0)
    const s = state(r.stdout)
    expect(s).toContain('OWNER_NAME="Teszt Elek"')
    expect(s).toContain('CONTINUE_MCP="i"')
    expect(s).toContain('CHANNEL_PROVIDER="telegram"')
    expect(s).toContain(`BOT_TOKEN="${TOKEN}"`) // CRLF file: the same value a typed answer gives
    expect(s).toContain('BOT_NAME="Robi"')
    expect(r.stdout + r.stderr).not.toContain('STDIN-WAS-READ')
    // Nowhere else: the whole shell state (every variable, every function) holds the value exactly once.
    const all = r.stdout.split('--ALL--\n')[1]
    const holders = all.split('\n').filter((l) => l.includes(TOKEN))
    expect(holders.length).toBe(1)
    expect(holders[0]).toMatch(/^BOT_TOKEN=/)
    // ...and nothing the block printed carries it
    expect(r.stdout.split('--STATE--')[0] + r.stderr).not.toContain(TOKEN)
  })

  it('the state after the block is the same as after typing the same answers interactively', () => {
    const typed = personal(false, {}, 'Teszt Elek\ni\n1\n987654321:AAx\nRobi\n')
    const ni = personal(true, { MARVEEN_OWNER_NAME: 'Teszt Elek', MARVEEN_BOT_NAME: 'Robi', MARVEEN_TELEGRAM_TOKEN_FILE: secretFile('987654321:AAx\n') }, undefined, '1')
    expect(state(ni.stdout)).toBe(state(typed.stdout))
    const tTyped = personal(false, {}, 'O\ni\n5\n11111111-2222-3333-4444-555555555555\n66666666-7777-8888-9999-000000000000\nS3cr3t-pw\nTB\n')
    const tNi = personal(true, {
      MARVEEN_OWNER_NAME: 'O', MARVEEN_BOT_NAME: 'TB', MARVEEN_TEAMS_BOT_APP_ID: '11111111-2222-3333-4444-555555555555',
      MARVEEN_TEAMS_BOT_TENANT_ID: '66666666-7777-8888-9999-000000000000', MARVEEN_TEAMS_BOT_APP_PASSWORD_FILE: secretFile('S3cr3t-pw\n'),
    }, undefined, '5')
    expect(state(tNi.stdout)).toBe(state(tTyped.stdout))
    expect(tNi.stdout.split('--STATE--')[0] + tNi.stderr).not.toContain('S3cr3t-pw')
  })

  it('slack and discord: tokens from their files, ids from env', () => {
    let s = state(personal(true, { MARVEEN_OWNER_NAME: 'O', MARVEEN_BOT_NAME: 'B', MARVEEN_SLACK_BOT_TOKEN_FILE: secretFile('xoxb-1-2'), MARVEEN_SLACK_APP_TOKEN_FILE: secretFile('xapp-3-4\n') }, undefined, '2').stdout)
    expect(s).toContain('CHANNEL_PROVIDER="slack"')
    expect(s).toContain('SLACK_BOT_TOKEN="xoxb-1-2"')
    expect(s).toContain('SLACK_APP_TOKEN="xapp-3-4"')
    s = state(personal(true, { MARVEEN_OWNER_NAME: 'O', MARVEEN_BOT_NAME: 'B', MARVEEN_DISCORD_BOT_TOKEN_FILE: secretFile('dtok'), MARVEEN_DISCORD_CHANNEL_ID: '111', MARVEEN_DISCORD_USER_ID: '222' }, undefined, '3').stdout)
    expect(s).toContain('DISCORD_BOT_TOKEN="dtok"')
    expect(s).toContain('DISCORD_CHANNEL_ID="111"')
    expect(s).toContain('OPERATOR_DISCORD_USER_ID="222"')
    s = state(personal(true, { MARVEEN_OWNER_NAME: 'O', MARVEEN_BOT_NAME: 'B' }, undefined, '4').stdout)
    expect(s).toContain('CHANNEL_PROVIDER="gromzo"')
  })

  const yn = (from: string, to: string, pre: string, dumpVar: string, env: Env, includeEnd = true) => {
    const slice = between(SCRIPT, from, to, includeEnd)
    refuse(NI_HELPERS + slice)
    const r = bash([PRELUDE, NI_HELPERS, 'INSTALL_NONINTERACTIVE=1', pre, slice, `dump ${dumpVar}`].join('\n'), env)
    expect(r.stdout + r.stderr).not.toContain('STDIN-WAS-READ')
    return r.stdout
  }
  it('swap: MARVEEN_SWAP or the default i (create); whisper: MARVEEN_WHISPER or the default n', () => {
    const swap = (env: Env) => yn('if [ "$TOTAL_SWAP_MB" -lt 1024 ]; then', '\n    fi\n', 'TOTAL_SWAP_MB=0; swapon() { echo /swapfile; }; fallocate() { :; }; mkswap() { :; }', 'CREATE_SWAP', env)
    expect(swap({})).toContain('CREATE_SWAP="i"')
    expect(swap({ MARVEEN_SWAP: 'n' })).toContain('CREATE_SWAP="n"')
    expect(swap({ MARVEEN_SWAP: 'y' })).toContain('CREATE_SWAP="i"')
    const wh = (env: Env) => yn('# --- Whisper (opcionalis) ---', '\nINSTALL_STEP="bumblebee"', 'command() { return 1; }', 'DO_WHISPER', env, false)
    expect(wh({})).toContain('DO_WHISPER="n"')
    expect(wh({ MARVEEN_WHISPER: 'y' })).toContain('DO_WHISPER="i"')
    expect(wh({ MARVEEN_WHISPER: 'y' })).toContain('STUB pipx install openai-whisper')
  })
  it('the error helper never offers to open Claude Code (OPEN_CLAUDE = n, documented)', () => {
    const fn = between(SCRIPT, 'offer_claude_fallback() {', '\n}\n').replace('if [ -t 0 ]; then', 'if true; then')
    refuse(NI_HELPERS + fn)
    const r = bash([PRELUDE, 'command() { return 0; }', NI_HELPERS, 'INSTALL_NONINTERACTIVE=1', fn, 'offer_claude_fallback init boom 1', 'dump OPEN_CLAUDE'].join('\n'))
    expect(r.stdout).toContain('OPEN_CLAUDE="n"')
    expect(r.stdout).not.toContain('STUB claude')
  })
  it('the auth step never prompts: a token gone during the run stops it, naming the file', () => {
    const block = between(SCRIPT, 'if service_auth_present; then', '\n# Pre-flight headless probe', false)
    refuse(NI_HELPERS + block)
    const r = bash([PRELUDE, NI_HELPERS, 'INSTALL_NONINTERACTIVE=1', 'service_auth_present() { return 1; }', 'INSTALL_DIR=/x', 'IS_HEADLESS=true; IS_WSL=false', block, 'dump AUTH_MODE'].join('\n'))
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL: nincs Claude-hitelesítés')
    expect(r.stdout).toContain('/x/store/.claude-oauth-token')
    expect(r.stdout).not.toContain('AUTH_MODE')
  })
})

describe('pairing is skipped and the end of the run says so', () => {
  const TAIL = SCRIPT.slice(SCRIPT.indexOf('# INSTPAIRPATH930: the access.json'))
  const run = (ni: boolean, env: Env = {}) => {
    refuse(NI_HELPERS + TAIL)
    const d = tempDir()
    return bash([PRELUDE, NI_HELPERS, `INSTALL_NONINTERACTIVE=${ni ? 1 : 0}`, `INSTALL_DIR='${d}'`, `CHANNEL_DIR='${d}/chan'`,
      'CHANNEL_PROVIDER=telegram; BOT_TOKEN=123:abc; CHAT_ID=0; WEB_PORT=3421; INSTALL_AUTH_STATE=OK; CHAN_UNIT=c; DASH_UNIT=d',
      TAIL, 'dump PAIR_CODE DO_MIGRATE'].join('\n'), env)
  }
  it('with the flag: no pairing step, no stdin read, migration skipped, the closing line names the dashboard', () => {
    const r = run(true)
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('Telegram parositas')
    expect(r.stdout).toContain('unset PAIR_CODE')
    expect(r.stdout).toContain('DO_MIGRATE="n"')
    expect(r.stdout + r.stderr).not.toContain('STDIN-WAS-READ')
    const lines = r.stdout.split('\n').filter((l) => l.trim() !== '' && !/^(declare|unset) /.test(l))
    expect(lines[lines.length - 1]).toContain('Nem-interaktív telepítés: a csatorna párosítása kimaradt. Párosítsd a dashboardon: http://localhost:3421')
    expect(run(true, { MARVEEN_LANG: 'en' }).stdout).toContain('Non-interactive install: channel pairing was skipped. Pair the channel on the dashboard: http://localhost:3421')
  })
  it('without the flag: the pairing step runs as before and the closing line is not printed', () => {
    const r = run(false)
    expect(r.stdout).toContain('Telegram parositas')
    expect(r.stdout).toContain('PAIR_CODE="STDIN-WAS-READ"')
    expect(r.stdout).not.toContain('párosítása kimaradt')
  })
})

describe('install.sh: --non-interactive skips the language question', () => {
  const WRAPPER = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  const LANG_BLOCK = between(WRAPPER, '# INSTNONINTER1118', '\nexport MARVEEN_LANG\n')
  const run = (args: string, env: Env = {}) => bash([`set -- ${args}`, LANG_BLOCK, 'echo "LANG=$MARVEEN_LANG"'].join('\n'), env, '2\n')
  it('the flag: no question, MARVEEN_LANG or hu; without it the question is asked as before', () => {
    expect(run('--non-interactive').stdout.trim()).toBe('LANG=hu')
    expect(run('--non-interactive', { MARVEEN_LANG: 'en' }).stdout.trim()).toBe('LANG=en')
    expect(run('').stdout).toContain('LANG=en') // "2" typed on stdin
  })
})

describe('the Bridge contract (marveen-bridge-installer derive-headless.mjs + read-presets.json)', () => {
  // The Bridge derives its paid headless installer from THIS file: every `read -r?p "<prompt>" VAR` line is matched by
  // VAR, prompt text and mode, and replaced; a new, changed or missing one fails its build. Measured on
  // marveen-bridge-installer 633c685 (read-presets.json, 22 reads / 21 VARs). The flag adds no read and changes none.
  const PINNED: Array<[string, string, 'rp' | 'p']> = [
    ['OPEN_CLAUDE', '"$(_t prompt_open_claude)"', 'rp'],
    ['CREATE_SWAP', '"$(_t prompt_swap)"', 'rp'],
    ['AUTH_MODE', '"$(_t prompt_auth_mode)"', 'rp'],
    ['AUTH_MODE', '"$(_t prompt_auth_mode)"', 'rp'],
    ['ANTHROPIC_API_KEY_INPUT', '"  ANTHROPIC_API_KEY (sk-ant-...): "', 'p'],
    ['OAUTH_TOKEN_INPUT', '"  OAuth token: "', 'p'],
    ['OWNER_NAME', '"$(_t prompt_your_name)"', 'rp'],
    ['CONTINUE_MCP', '"$(_t prompt_vps_continue)"', 'rp'],
    ['PROVIDER_CHOICE', '"$(_t prompt_channel_select5)"', 'rp'],
    ['BOT_TOKEN', '"$(_t prompt_telegram_token)"', 'rp'],
    ['DISCORD_BOT_TOKEN', '"$(_t prompt_discord_bot_token)"', 'rp'],
    ['DISCORD_CHANNEL_ID', '"$(_t prompt_discord_channel_id)"', 'rp'],
    ['OPERATOR_DISCORD_USER_ID', '"$(_t prompt_discord_user_id)"', 'rp'],
    ['TEAMS_BOT_APP_ID', '"$(_t prompt_teams_app_id)"', 'rp'],
    ['TEAMS_BOT_TENANT_ID', '"$(_t prompt_teams_tenant_id)"', 'rp'],
    ['TEAMS_BOT_APP_PASSWORD', '"$(_t prompt_teams_app_password)"', 'rp'],
    ['SLACK_BOT_TOKEN', '"$(_t prompt_slack_bot_token)"', 'rp'],
    ['SLACK_APP_TOKEN', '"$(_t prompt_slack_app_token)"', 'rp'],
    ['BOT_NAME', '"$(_t prompt_bot_name)"', 'rp'],
    ['DO_WHISPER', '"$(_t prompt_whisper)"', 'rp'],
    ['PAIR_CODE', '"$(_t prompt_pair_code)"', 'rp'],
    ['DO_MIGRATE', '"$(_t prompt_migrate)"', 'rp'],
  ]
  it('the 22 prompt reads, in order, VAR + prompt + mode exactly as the Bridge maps them; no other read -p', () => {
    const READ_RE = /^[ \t]*read -(r?)p (.+) ([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/gm
    const found = [...SCRIPT.matchAll(READ_RE)].map((m) => [m[3], m[2], m[1] === 'r' ? 'rp' : 'p'])
    expect(found).toEqual(PINNED)
    const stray = SCRIPT.split('\n').filter((l) => /^\s*read\b[^#]*\s-\w*p\b/.test(l))
    expect(stray.length).toBe(PINNED.length)
  })
  it('the derive anchors are each still there exactly once', () => {
    const once = (s: string) => SCRIPT.split(s).length - 1
    expect(once('# shellcheck source=install-lang.sh')).toBe(1)
    expect(once('  offer_claude_fallback "$INSTALL_STEP" "$*" "${BASH_LINENO[0]}"')).toBe(1)
    expect(once('  offer_claude_fallback "$INSTALL_STEP" "Unexpected error at line $1" "$1"')).toBe(1)
    expect(once('if [ ! -f "$INSTALL_DIR/package.json" ]; then')).toBe(1)
    expect(SCRIPT.split('\n').filter((l) => l === '# Kesz!').length).toBe(1)
    expect(SCRIPT).toContain('exec bash "$TARGET_DIR/install-linux.sh"')
  })
  it('the mode never reads the Bridge\'s switch: MARVEEN_NONINTERACTIVE is on no code line of the script', () => {
    const code = SCRIPT.split('\n').filter((l) => !l.trimStart().startsWith('#'))
    expect(code.filter((l) => l.includes('MARVEEN_NONINTERACTIVE'))).toEqual([])
  })
})

describe('docs and texts', () => {
  const DOC = readFileSync(join(ROOT, 'docs', 'install-non-interactive.md'), 'utf8')
  it('every MARVEEN_* variable the mode reads or refuses is in the doc', () => {
    const block = NI_CHECK + SCRIPT.split('\n').filter((l) => /^\s*ni_answer /.test(l)).join('\n')
    const names = [...new Set(block.match(/MARVEEN_[A-Z_]+/g) ?? [])]
    expect(names.length).toBeGreaterThan(15)
    for (const n of names) expect(DOC, n).toContain(n)
    expect(DOC).toContain('MARVEEN_LANG')
  })
  it('every ni.* text has a Hungarian and an English line', () => {
    const keys = [...new Set(SCRIPT.match(/_t ni\.[a-z_]+/g) ?? [])].map((k) => k.slice(3))
    expect(keys.length).toBe(8)
    for (const lng of ['hu', 'en']) {
      for (const k of keys) {
        const out = spawnSync('bash', ['-c', `. '${LANG}'; MARVEEN_LANG=${lng}; _t ${k}`], { encoding: 'utf8' }).stdout.trim()
        expect(out, `${lng}:${k}`).not.toBe(k)
        expect(out.length).toBeGreaterThan(5)
      }
    }
  })
})
