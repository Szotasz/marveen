// #915: the main agent's channel state dir resolution. The shared
// ~/.claude/channels/<provider>/ default let any other Claude Code session on
// the host read the bot token and take the bot over. The contract under test:
//
//   1. an explicit <PROVIDER>_STATE_DIR env override wins unconditionally --
//      it is what the running plugin itself was launched with;
//   2. the legacy shared dir is served ONLY while it still holds the .env and
//      the install-scoped dir does not (an unmigrated install, whose poller is
//      still running out of the legacy dir);
//   3. everything else -- fresh install (no .env anywhere) and migrated
//      install -- resolves install-scoped, so a first onboarding writes the
//      token there and no shared-path copy is ever born.
//
// The ordering is tested through the pure resolver, not the filesystem-backed
// wrapper, so no test ever creates files under the real home directory.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMainChannelStateDir, channelStateDir, channelStateDirEnvVar } from '../channel-provider.js'

function hasEnvIn(dirsWithEnv: Set<string>) {
  return (dir: string) => dirsWithEnv.has(dir)
}

describe('resolveMainChannelStateDir (#915 ordering)', () => {
  const installScoped = '/install/.claude/channels/telegram'
  const legacy = '/home/user/.claude/channels/telegram'

  it('env override wins over everything, even a live legacy .env', () => {
    const got = resolveMainChannelStateDir({
      envOverride: '/custom/state',
      installScoped,
      legacy,
      hasEnvFile: hasEnvIn(new Set([legacy])),
    })
    expect(got).toBe('/custom/state')
  })

  it('unmigrated install (legacy .env only) keeps resolving legacy', () => {
    const got = resolveMainChannelStateDir({
      envOverride: undefined,
      installScoped,
      legacy,
      hasEnvFile: hasEnvIn(new Set([legacy])),
    })
    expect(got).toBe(legacy)
  })

  it('migrated install (install-scoped .env) resolves install-scoped', () => {
    const got = resolveMainChannelStateDir({
      envOverride: undefined,
      installScoped,
      legacy,
      hasEnvFile: hasEnvIn(new Set([installScoped])),
    })
    expect(got).toBe(installScoped)
  })

  it('both hold a .env: install-scoped wins (the migrated copy is live)', () => {
    const got = resolveMainChannelStateDir({
      envOverride: undefined,
      installScoped,
      legacy,
      hasEnvFile: hasEnvIn(new Set([installScoped, legacy])),
    })
    expect(got).toBe(installScoped)
  })

  it('fresh install (no .env anywhere) is born install-scoped, never legacy', () => {
    const got = resolveMainChannelStateDir({
      envOverride: undefined,
      installScoped,
      legacy,
      hasEnvFile: hasEnvIn(new Set()),
    })
    expect(got).toBe(installScoped)
  })
})

describe('channelStateDir wrapper', () => {
  it('honours the per-provider env override end to end', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chanstate-'))
    try {
      const key = channelStateDirEnvVar('telegram')
      const prev = process.env[key]
      process.env[key] = tmp
      try {
        expect(channelStateDir('telegram')).toBe(tmp)
      } finally {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('an agentDir keeps its agent-scoped path untouched by the env override', () => {
    const key = channelStateDirEnvVar('telegram')
    const prev = process.env[key]
    process.env[key] = '/should/not/leak'
    try {
      expect(channelStateDir('telegram', '/agents/samu')).toBe(join('/agents/samu', '.claude', 'channels', 'telegram'))
    } finally {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
  })

  it('maps every provider to its own env var name', () => {
    expect(channelStateDirEnvVar('telegram')).toBe('TELEGRAM_STATE_DIR')
    expect(channelStateDirEnvVar('slack')).toBe('SLACK_STATE_DIR')
    expect(channelStateDirEnvVar('discord')).toBe('DISCORD_STATE_DIR')
    expect(channelStateDirEnvVar('googlechat')).toBe('GOOGLECHAT_STATE_DIR')
    expect(channelStateDirEnvVar('teams')).toBe('TEAMS_STATE_DIR')
  })
})

describe('the migration ordering the pure resolver implies', () => {
  it('a real tmp fixture: legacy-only -> legacy; after a move -> install-scoped', () => {
    // Sanity-check the hasEnvFile shape against a real filesystem, still in
    // tmp: the same predicate channelStateDir wires in.
    const base = mkdtempSync(join(tmpdir(), 'chanstate-fs-'))
    try {
      const inst = join(base, 'install', '.claude', 'channels', 'telegram')
      const legacy = join(base, 'home', '.claude', 'channels', 'telegram')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
      const hasEnvFile = (dir: string) => existsSync(join(dir, '.env'))
      const opts = { envOverride: undefined, installScoped: inst, legacy, hasEnvFile }
      expect(resolveMainChannelStateDir(opts)).toBe(legacy)
      // migrate: move the .env (the channels.sh migration moves the whole dir)
      mkdirSync(inst, { recursive: true })
      writeFileSync(join(inst, '.env'), 'TELEGRAM_BOT_TOKEN=x\n')
      rmSync(join(legacy, '.env'))
      expect(resolveMainChannelStateDir(opts)).toBe(inst)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
