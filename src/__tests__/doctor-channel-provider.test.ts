import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
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

  it('Telegram: the Telegram keys are still checked in .env', () => {
    const out = runKeys('MAIN_AGENT_ID=dojo\nBOT_NAME=dojo\nTELEGRAM_BOT_TOKEN=x\n')
    expect(out).toContain('OK TELEGRAM_BOT_TOKEN: present')
    expect(out).toContain('FAIL ALLOWED_CHAT_ID: MISSING')
  })
})
