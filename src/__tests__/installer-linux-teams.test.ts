// EE2392D3: install-linux.sh knows CHANNEL_PROVIDER=teams. The REAL blocks are sliced out of the script and run with
// bash: the menu (5 or "teams"), the three credentials (cleaned, the secret never echoed or printed), Bun on the teams
// branch, the plugin id, the install .env (no Teams key there), the channel .env and access.json (into a temp dir), and
// the machine-wide allowlist (through the real shared writer, against a temp file, sudo stubbed). Nothing here touches
// the host: every slice is checked before it runs, and the two that write are pointed at a fresh temp dir.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')
const between = (text: string, from: string, to: string): string => {
  const a = text.indexOf(from)
  const b = text.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`slice not found: ${from.slice(0, 60)}`)
  return text.slice(a, b + to.length)
}
// A slice may only name these commands (plus shell syntax); anything else is refused before it runs.
// a command word, not part of a name or path (claude-plugins-official, /etc/claude-code)
const FORBIDDEN = /(?<![-\w/.@])(dscl|launchctl|systemctl|useradd|chown|curl|wget|rm|mv|cp|ln|npm|claude|apt-get|brew|eval|exec|source)(?![-\w/.@])/
const refuse = (slice: string) => {
  const code = slice.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  const m = code.match(FORBIDDEN)
  if (m) throw new Error(`refusing to run an installer slice on the host: it names ${m[0]}`)
}
const bash = (script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
const tmp: string[] = []
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'inst-teams-')); tmp.push(d); return d }
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })
const PRELUDE = ['ok() { echo "ok: $*"; }', 'warn() { echo "warn: $*"; }', '_t() { echo "<$1>"; }', 'DIM="" NC="" BOLD="" ORANGE="" RED="" GREEN=""'].join('\n')

const APP = '11111111-2222-3333-4444-555555555555'
const TEN = '66666666-7777-8888-9999-000000000000'
const SECRET = 'S3cr3t~value.with_chars-42'

describe('install-linux.sh: the menu', () => {
  const MAP = between(SCRIPT, 'PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}\nif [ "$PROVIDER_CHOICE" = "2" ]; then', '\nfi')
  const choose = (v: string) => { refuse(MAP); return bash(`PROVIDER_CHOICE='${v}'\n${MAP}\nprintf '%s' "$CHANNEL_PROVIDER"`).stdout }
  it('5 and the name "teams" give teams; the other choices as before', () => {
    expect(choose('5')).toBe('teams')
    expect(choose('teams')).toBe('teams')
    expect(choose('4')).toBe('gromzo')
    expect(choose('2')).toBe('slack')
    expect(choose('3')).toBe('discord')
    expect(choose('1')).toBe('telegram')
    expect(choose('')).toBe('telegram')
    expect(choose('Teams')).toBe('telegram') // the name is exact, as "gromzo"
  })
  it('the menu shows option 5 and asks with the new 5-option key; the old keys still answer', () => {
    expect(SCRIPT).toContain('echo -e "  ${BOLD}5.${NC} $(_t channel_option_teams)"')
    expect(SCRIPT).toContain('read -rp "$(_t prompt_channel_select5)" PROVIDER_CHOICE')
    const t = (lng: string, key: string) => bash(`. '${join(ROOT, 'install-lang.sh')}' >/dev/null 2>&1; MARVEEN_LANG=${lng}; _t ${key}`).stdout
    expect(t('hu', 'prompt_channel_select5')).toContain('Válassz (1/2/3/4/5) [1]:')
    expect(t('en', 'prompt_channel_select5')).toContain('Choose (1/2/3/4/5) [1]:')
    expect(t('hu', 'channel_option_teams')).toContain('Microsoft Teams')
    expect(t('hu', 'prompt_channel_select4')).toContain('Válassz (1/2/3/4) [1]:')
    for (const k of ['prompt_teams_app_id', 'prompt_teams_tenant_id', 'prompt_teams_app_password', 'linux.teams_channel_configured']) {
      expect(t('hu', k).trim()).not.toBe('')
      expect(t('en', k).trim()).not.toBe('')
    }
  })
})

describe('install-linux.sh: the three Teams credentials', () => {
  const HELPERS = between(SCRIPT, "_teams_clean() {", "{12}$'; }")
  const BRANCH = between(SCRIPT, 'elif [ "$CHANNEL_PROVIDER" = "teams" ]; then\n  # EE2392D3: the three keys', '\n  fi\n')
  // `read` and `stty` are stubbed: answers come from ANS_1..3 in order, every stty call is logged.
  const run = (answers: string[]) => {
    refuse(HELPERS + BRANCH)
    const env: Record<string, string> = {}
    answers.forEach((a, i) => { env[`ANS_${i + 1}`] = a })
    return bash([
      PRELUDE,
      '_n=0; read() { local v="${@: -1}"; _n=$((_n+1)); local a="ANS_$_n"; printf -v "$v" "%s" "${!a}"; echo "asked: $v"; }',
      'stty() { echo "stty $*"; }',
      HELPERS,
      'CHANNEL_PROVIDER=teams; TEAMS_BOT_APP_ID=""; TEAMS_BOT_TENANT_ID=""; TEAMS_BOT_APP_PASSWORD=""',
      'if [ "$CHANNEL_PROVIDER" = "none" ]; then :',
      BRANCH,
      'fi',
      'printf "APP=[%s] TEN=[%s] PWLEN=[%s]\\n" "$TEAMS_BOT_APP_ID" "$TEAMS_BOT_TENANT_ID" "${#TEAMS_BOT_APP_PASSWORD}"',
      '[ "$TEAMS_BOT_APP_PASSWORD" = "$EXPECT_PW" ] && echo PW-MATCH',
    ].join('\n'), { ...env, EXPECT_PW: SECRET })
  }
  it('asks app id, tenant, secret in that order; whitespace is cut; the secret is read with echo off', () => {
    const r = run([`  ${APP} `, `${TEN}\r`, ` ${SECRET}\n`])
    expect(r.stdout).toContain(`APP=[${APP}] TEN=[${TEN}] PWLEN=[${SECRET.length}]`)
    expect(r.stdout).toContain('PW-MATCH')
    const lines = r.stdout.split('\n')
    expect(lines.filter((l) => /^(asked|stty)/.test(l))).toEqual([
      'asked: TEAMS_BOT_APP_ID', 'asked: TEAMS_BOT_TENANT_ID', 'stty -echo', 'asked: TEAMS_BOT_APP_PASSWORD', 'stty echo',
    ])
    expect(r.stdout).not.toContain('warn:')
  })
  it('the secret never reaches stdout or stderr', () => {
    const r = run([APP, TEN, SECRET])
    expect(r.stdout.replace('PW-MATCH', '')).not.toContain(SECRET)
    expect(r.stderr).not.toContain(SECRET)
  })
  it('an empty app id skips the other two (set up later), with no warning', () => {
    const r = run(['', TEN, SECRET])
    expect(r.stdout).toContain('APP=[] TEN=[] PWLEN=[0]')
    expect(r.stdout.split('\n').filter((l) => l.startsWith('asked'))).toEqual(['asked: TEAMS_BOT_APP_ID'])
  })
  it('a non-GUID id and an empty secret are warned about, not refused', () => {
    const r = run(['not-a-guid', 'nope', ''])
    expect(r.stdout).toMatch(/warn: Az App ID nem GUID/)
    expect(r.stdout).toMatch(/warn: A Tenant ID nem GUID/)
    expect(r.stdout).toMatch(/warn: A titkos kulcs ures/)
  })
  it('every Teams read stays a plain `read -rp` line, so the Bridge headless derive can wrap it', () => {
    const reads = BRANCH.split('\n').filter((l) => /^\s*read\b/.test(l))
    expect(reads).toEqual([
      '  read -rp "$(_t prompt_teams_app_id)" TEAMS_BOT_APP_ID',
      '    read -rp "$(_t prompt_teams_tenant_id)" TEAMS_BOT_TENANT_ID',
      '    read -rp "$(_t prompt_teams_app_password)" TEAMS_BOT_APP_PASSWORD',
    ])
  })
})

describe('install-linux.sh: Bun, plugin id, install .env', () => {
  it('the teams branch fetches Bun (the plugin starts with `bun run`)', () => {
    const STEP = between(SCRIPT, 'INSTALL_STEP="bun-install"\n', '\nesac')
    refuse(STEP.replace(/_install_bun|pkg_install_noninteractive|ensure_in_rc/g, ''))
    const r = bash([PRELUDE, 'ensure_in_rc() { :; }', 'pkg_install_noninteractive() { :; }', '_install_bun() { echo BUN-INSTALL-CALLED; }',
      'command() { if [ "$1" = "-v" ] && [ "$2" = "bun" ]; then return 1; fi; builtin command "$@"; }', 'CHANNEL_PROVIDER=teams', STEP].join('\n'))
    expect(r.stdout).toContain('BUN-INSTALL-CALLED')
  })
  it('the plugin is teams@marveen-marketplace from Szotasz/marveen-marketplace', () => {
    const CHAIN = between(SCRIPT, 'elif [ "$CHANNEL_PROVIDER" = "telegram" ]; then\n  PLUGIN_MARKETPLACE=', '\nfi')
    refuse(CHAIN)
    const r = bash(`CHANNEL_PROVIDER=teams\nif false; then :\n${CHAIN}\nprintf '%s %s' "$PLUGIN_ID" "$PLUGIN_MARKETPLACE"`)
    expect(r.stdout).toBe('teams@marveen-marketplace Szotasz/marveen-marketplace')
  })
  it('no Teams key is written to the install .env (the channel .env is the one file)', () => {
    const BLOCK = between(SCRIPT, 'if [ "$CHANNEL_PROVIDER" = "telegram" ]; then\n  env_keep_or_set TELEGRAM_BOT_TOKEN', '\nfi\n')
    refuse(BLOCK)
    const r = bash(['env_keep_or_set() { echo "SET $1"; }', 'env_merge_key() { echo "MERGE $1"; }', 'INSTALL_DIR=/nonexistent CHAT_ID=0',
      'CHANNEL_PROVIDER=teams', BLOCK].join('\n'))
    expect(r.stdout).toBe('')
  })
})

describe('install-linux.sh: the channel .env and access.json', () => {
  const BLOCK = between(SCRIPT, 'elif [ "$CHANNEL_PROVIDER" = "teams" ] && [ -n "$TEAMS_BOT_APP_ID" ]; then', '  ok "$(_t linux.teams_channel_configured)"')
  const run = (dir: string) => {
    refuse(BLOCK.replace(/chmod 600 "\$CHANNEL_DIR\/\.env"/, ''))
    // every write target in the slice is under $CHANNEL_DIR
    for (const m of BLOCK.matchAll(/>\s*"([^"]+)"/g)) expect(m[1].startsWith('$CHANNEL_DIR/')).toBe(true)
    return bash([PRELUDE, `CHANNEL_DIR='${dir}'`, `TEAMS_BOT_APP_ID='${APP}' TEAMS_BOT_TENANT_ID='${TEN}' TEAMS_BOT_APP_PASSWORD='${SECRET}'`,
      'CHANNEL_PROVIDER=teams', 'if false; then :', BLOCK, 'fi'].join('\n'))
  }
  it('writes the plugin keys at 0600 and a pairing access.json; the secret is not printed', () => {
    const dir = tempDir()
    const r = run(dir)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(
      `TEAMS_BOT_APP_ID=${APP}\nTEAMS_BOT_APP_PASSWORD=${SECRET}\nTEAMS_BOT_TENANT_ID=${TEN}\nTEAMS_BOT_APP_TYPE=SingleTenant\n`)
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'))).toEqual({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })
  it('a re-run keeps an existing pairing (access.json is not overwritten)', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'access.json'), '{"dmPolicy":"allowlist","allowFrom":["x"],"groups":{},"pending":{}}')
    run(dir)
    expect(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')).allowFrom).toEqual(['x'])
  })
})

describe('install-linux.sh: the machine-wide allowlist on a teams install', () => {
  const BLOCK = between(SCRIPT, 'TEAMS_ALLOWLIST_PLUGINS=', '    unset _ms_priv _ms_args _p\n  fi\nfi')
  const FOUR = ['slack-channel@marveen-marketplace', 'telegram@claude-plugins-official', 'teams@marveen-marketplace', 'discord@claude-plugins-official']
  const run = (file: string) => {
    const fixed = '"/etc/claude-code/managed-settings.json"'
    expect(BLOCK).toContain(`TEAMS_MANAGED_FILE=${fixed}`)
    const slice = BLOCK.replace(`TEAMS_MANAGED_FILE=${fixed}`, `TEAMS_MANAGED_FILE='${file}'`)
    refuse(slice)
    return bash([PRELUDE, 'managed_settings_notice() { echo NOTICE; }', 'sudo() { echo "SUDO $1" >&2; "$@"; }',
      `INSTALL_DIR='${ROOT}'`, 'CHANNEL_PROVIDER=teams', slice].join('\n'))
  }
  const listed = (file: string) => (JSON.parse(readFileSync(file, 'utf8')).allowedChannelPlugins as { plugin: string; marketplace: string }[])
    .map((p) => `${p.plugin}@${p.marketplace}`)
  it('no file: created through the shared writer with all four channel plugins, 0644', () => {
    const f = join(tempDir(), 'claude-code', 'managed-settings.json')
    const r = run(f)
    expect(r.status).toBe(0)
    expect(listed(f).sort()).toEqual([...FOUR].sort())
    expect(statSync(f).mode & 0o777).toBe(0o644)
    expect(r.stdout).toContain('ok: Teams engedelyezve')
  })
  it('an existing file: merged, every other key kept', () => {
    const f = join(tempDir(), 'managed-settings.json')
    writeFileSync(f, JSON.stringify({ channelsEnabled: true, other: 1, allowedChannelPlugins: [{ plugin: 'telegram', marketplace: 'claude-plugins-official' }] }))
    run(f)
    const d = JSON.parse(readFileSync(f, 'utf8'))
    expect(d.channelsEnabled).toBe(true)
    expect(d.other).toBe(1)
    expect(listed(f).sort()).toEqual([...FOUR].sort())
  })
  it('a file that already allows all four is not written, and no privilege is asked', () => {
    const f = join(tempDir(), 'managed-settings.json')
    writeFileSync(f, JSON.stringify({ allowedChannelPlugins: FOUR.map((x) => ({ plugin: x.split('@')[0], marketplace: x.split('@')[1] })) }))
    const before = readFileSync(f, 'utf8')
    const r = run(f)
    expect(readFileSync(f, 'utf8')).toBe(before)
    expect(r.stderr).not.toContain('SUDO')
    expect(r.stdout).not.toContain('NOTICE')
  })
  it('an unparseable file is left untouched and the manual root step is printed', () => {
    const f = join(tempDir(), 'managed-settings.json')
    writeFileSync(f, '{not json')
    const r = run(f)
    expect(readFileSync(f, 'utf8')).toBe('{not json')
    expect(r.stdout).toMatch(/warn: A managed-settings allowlist nem volt frissitheto/)
    expect(r.stdout).toContain('--add-plugin teams@marveen-marketplace')
  })
  it('a non-teams install never touches it', () => {
    const f = join(tempDir(), 'managed-settings.json')
    const slice = BLOCK.replace('TEAMS_MANAGED_FILE="/etc/claude-code/managed-settings.json"', `TEAMS_MANAGED_FILE='${f}'`)
    refuse(slice)
    bash([PRELUDE, 'sudo() { "$@"; }', `INSTALL_DIR='${ROOT}'`, 'CHANNEL_PROVIDER=slack', slice].join('\n'))
    expect(existsSync(f)).toBe(false)
  })
})
