import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CHANPIDPROVIDER1123: doctor.sh judged every install as a Telegram one. On a healthy Discord install
// (discord@0.0.6, measured 2026-11-23) it failed three ways: verify-channels-health (b) read
// .claude/channels/telegram/bot.pid, which only the Telegram plugin writes, and the .env key check
// wanted TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID. These tests run the REAL blocks out of the shipped
// scripts: the (b) check, and the .env key check against a temp install.

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  if (a < 0) throw new Error(`marker not found: ${from}`)
  const b = src.indexOf(to, a)
  if (b < 0) throw new Error(`end marker not found: ${to}`)
  return src.slice(a, b)
}

function bash(script: string, cwd: string): string {
  const file = join(cwd, 'run.sh')
  writeFileSync(file, script)
  return execFileSync('/bin/bash', [file], { encoding: 'utf-8', cwd })
}

describe('verify-channels-health (b): bot.pid only for Telegram', () => {
  const block = slice(read('scripts/verify-channels-health.sh'), '# (b) bot.pid alive', '# (c) ')

  function runB(provider: string) {
    const dir = mkdtempSync(join(tmpdir(), 'vch-b-'))
    const out = bash(
      ['fail=0', 'note() { echo "$1"; }', `_vch_bp_provider=${provider}`,
        `BOT_PID_FILE=${JSON.stringify(join(dir, 'telegram', 'bot.pid'))}`, block, 'echo "fail=$fail"'].join('\n'),
      dir,
    )
    return out
  }

  it('a Discord install skips (b) instead of failing on the Telegram path', () => {
    const out = runB('discord')
    expect(out).toContain('(b) SKIP: the discord plugin writes no bot.pid')
    expect(out).not.toContain('telegram/bot.pid')
    expect(out).toContain('fail=0')
  })

  it('a Telegram install still fails when bot.pid is missing', () => {
    const out = runB('telegram')
    expect(out).toMatch(/\(b\) FAIL: .*telegram\/bot\.pid missing/)
    expect(out).toContain('fail=1')
  })

  it('the provider is kept for (b) before _vch_provider is unset', () => {
    const src = read('scripts/verify-channels-health.sh')
    const keep = src.indexOf('_vch_bp_provider="${_vch_provider:-telegram}"')
    expect(keep).toBeGreaterThan(0)
    expect(keep).toBeLessThan(src.indexOf('unset _vch_provider'))
  })
})

describe('doctor.sh .env keys follow the channel provider', () => {
  const block = slice(read('scripts/doctor.sh'), '# --- .env keys ---', '# OWNERAUTHGUESS1106')

  function runKeys(env: string, channelEnv?: { provider: string; body: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-keys-'))
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'main-channel-configured.sh'), read('scripts/main-channel-configured.sh'))
    writeFileSync(join(dir, '.env'), env)
    if (channelEnv) {
      mkdirSync(join(dir, '.claude', 'channels', channelEnv.provider), { recursive: true })
      writeFileSync(join(dir, '.claude', 'channels', channelEnv.provider, '.env'), channelEnv.body)
    }
    const provider = /^CHANNEL_PROVIDER=(.*)$/m.exec(env)?.[1] ?? 'telegram'
    return bash(
      ['ok() { echo "OK $1"; }', 'fail() { echo "FAIL $1"; }', 'BOLD=; RESET=',
        `INSTALL_DIR=${JSON.stringify(dir)}`, `HOME=${JSON.stringify(join(dir, 'home'))}`,
        `CHANNEL_PROVIDER=${provider}`, block].join('\n'),
      dir,
    )
  }

  it('Discord: no Telegram keys asked, the token is read from the channel .env', () => {
    const out = runKeys('MAIN_AGENT_ID=dojo\nBOT_NAME=dojo\nCHANNEL_PROVIDER=discord\n',
      { provider: 'discord', body: 'DISCORD_BOT_TOKEN=abc\n' })
    expect(out).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(out).not.toContain('ALLOWED_CHAT_ID')
    expect(out).toContain('OK DISCORD_BOT_TOKEN: present (channel .env)')
    expect(out).not.toContain('FAIL')
  })

  it('Discord without a token: the missing token is a failure', () => {
    const out = runKeys('MAIN_AGENT_ID=dojo\nBOT_NAME=dojo\nCHANNEL_PROVIDER=discord\n',
      { provider: 'discord', body: 'DISCORD_BOT_TOKEN=\n' })
    expect(out).toContain('FAIL DISCORD_BOT_TOKEN: MISSING (.claude/channels/discord/.env)')
  })

  it('Telegram: the Telegram keys are still checked in .env, and the channel-token line is not added', () => {
    const out = runKeys('MAIN_AGENT_ID=dojo\nBOT_NAME=dojo\nTELEGRAM_BOT_TOKEN=x\n',
      { provider: 'telegram', body: 'TELEGRAM_BOT_TOKEN=x\n' })
    expect(out).toContain('OK TELEGRAM_BOT_TOKEN: present')
    expect(out).toContain('FAIL ALLOWED_CHAT_ID: MISSING')
    expect(out).not.toContain('(channel .env)')
    expect(out.match(/TELEGRAM_BOT_TOKEN/g)).toHaveLength(1)
  })
})

// Review #3088: the WHOLE script from a fixture install, so the .env -> provider -> (a)/(b) wiring is pinned, not
// just the sliced blocks. A fake `tmux` on PATH names a real pane pid: a shell whose child carries the plugin's
// command line (a bun server.ts for Discord, a /slack-channel/ path for Slack).
describe('verify-channels-health.sh end to end, from a fixture install', () => {
  const kids: ChildProcess[] = []
  afterEach(() => { for (const k of kids.splice(0)) { try { process.kill(-k.pid!, 'SIGKILL') } catch { /* gone */ } } })

  function fixture(provider: string, plugin: 'bun' | 'slack' | 'none') {
    const dir = mkdtempSync(join(tmpdir(), 'vch-e2e-'))
    cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, '.env'), `MAIN_AGENT_ID=vche2e\nCHANNEL_PROVIDER=${provider}\n`)
    mkdirSync(join(dir, '.claude', 'channels', provider), { recursive: true })
    writeFileSync(join(dir, '.claude', 'channels', provider, '.env'), `${provider.toUpperCase()}_BOT_TOKEN=x\nTEAMS_BOT_APP_ID=x\n`)
    let pane = ''
    if (plugin !== 'none') {
      const argv0 = plugin === 'bun' ? 'bun server.ts' : '/fake/slack-channel/node_modules/.bin/tsx server.ts'
      const k = spawn('/bin/bash', ['-c', `/bin/bash -c "sleep 30; :" ${argv0} & wait`], { detached: true, stdio: 'ignore' })
      kids.push(k)
      pane = String(k.pid)
      spawnSync('/bin/sleep', ['0.5'])
    }
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tmux'), pane ? `#!/bin/bash\necho ${pane}\n` : '#!/bin/bash\nexit 1\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    const r = spawnSync('/bin/bash', [join(dir, 'scripts', 'verify-channels-health.sh')], {
      encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, 'home') },
    })
    return { out: r.stdout + r.stderr, code: r.status }
  }

  it('Discord with its bun bridge: (a) OK, (b) skipped, HEALTHY', () => {
    const { out, code } = fixture('discord', 'bun')
    expect(out).toMatch(/\(a\) OK: bun bridge pid=\d+/)
    expect(out).toContain('(b) SKIP: the discord plugin writes no bot.pid')
    expect(out).toContain('verify-channels-health: HEALTHY')
    expect(code).toBe(0)
  })

  it('Slack with its Node plugin: (a) OK on the /slack-channel/ child, HEALTHY', () => {
    const { out, code } = fixture('slack', 'slack')
    expect(out).toMatch(/\(a\) OK: slack-channel plugin pid=\d+/)
    expect(out).toContain('(b) SKIP: the slack plugin writes no bot.pid')
    expect(code).toBe(0)
  })

  it('Slack with only a bun process under the pane: (a) FAIL (the bun pattern is not Slack\'s)', () => {
    const { out, code } = fixture('slack', 'bun')
    expect(out).toContain('(a) FAIL: no slack-channel plugin descendant')
    expect(code).toBe(1)
  })

  it('no session: (a) fails, but (b) still follows the provider from .env', () => {
    expect(fixture('discord', 'none').out).toContain('(b) SKIP: the discord plugin writes no bot.pid')
    expect(fixture('telegram', 'none').out).toMatch(/\(b\) FAIL: .*telegram\/bot\.pid missing/)
  })
})

describe('doctor.sh: provider parsing, header, and no channel-token line on Telegram', () => {
  const doctor = read('scripts/doctor.sh')

  it('a quoted or CRLF CHANNEL_PROVIDER names the same provider as verify-channels-health.sh does', () => {
    const end = 'CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"'
    const block = slice(doctor, 'CHANNEL_PROVIDER="$(grep', end) + end
    for (const line of ["CHANNEL_PROVIDER='telegram'", 'CHANNEL_PROVIDER=telegram\r', 'CHANNEL_PROVIDER="discord"']) {
      const dir = mkdtempSync(join(tmpdir(), 'doctor-prov-'))
      writeFileSync(join(dir, '.env'), `${line}\n`)
      const out = bash(`${block}\nprintf '%s' "$CHANNEL_PROVIDER"`, dir)
      expect(out).toBe(line.includes('discord') ? 'discord' : 'telegram')
    }
  })

  it('the bridge header names the provider', () => {
    expect(doctor).toContain('echo -e "\\n${BOLD}Channel bridge ($CHANNEL_PROVIDER)${RESET}"')
    expect(doctor).not.toContain('Telegram bridge')
  })
})
