import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInvite,
  listInvites,
  revokeInvite,
  runInviteMonitorTick,
  startInviteMonitor,
  stopInviteMonitor,
} from '../web/channel-invites.js'

// Helpers to read/write access.json and invites.json directly in tests.
function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

describe('createInvite', () => {
  let tmp: string
  let accessPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'invites-test-'))
    accessPath = join(tmp, 'telegram', 'access.json')
    mkdirSync(join(tmp, 'telegram'), { recursive: true })
    writeJson(accessPath, { dmPolicy: 'allowlist', allowFrom: [] })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('creates an invite token and returns it with expiresAt', () => {
    const before = Date.now()
    const result = createInvite(accessPath, undefined)
    expect(typeof result.token).toBe('string')
    expect(result.token.length).toBeGreaterThan(0)
    expect(result.expiresAt).toBeGreaterThan(before)
  })

  it('sets dmPolicy to pairing in access.json', () => {
    createInvite(accessPath, undefined)
    const access = readJson(accessPath)
    expect(access.dmPolicy).toBe('pairing')
  })

  it('does NOT change dmPolicy when it is already disabled', () => {
    writeJson(accessPath, { dmPolicy: 'disabled' })
    createInvite(accessPath, undefined)
    expect(readJson(accessPath).dmPolicy).toBe('disabled')
  })

  it('generates a Telegram deep link when botUsername is provided', () => {
    const result = createInvite(accessPath, 'MyBot', 'telegram')
    expect(result.deepLink).toMatch(/^https:\/\/t\.me\/MyBot\?start=invite-/)
  })

  it('strips leading @ from botUsername in deep link', () => {
    const result = createInvite(accessPath, '@MyBot', 'telegram')
    expect(result.deepLink).toMatch(/^https:\/\/t\.me\/MyBot\?start=invite-/)
  })

  it('omits deepLink for slack provider', () => {
    const result = createInvite(accessPath, 'MyBot', 'slack')
    expect(result.deepLink).toBeUndefined()
  })

  it('prunes expired tokens on create', () => {
    const invitesPath = join(tmp, 'telegram', 'invites.json')
    writeJson(invitesPath, {
      invites: {
        expiredtoken: { createdAt: Date.now() - 100000, expiresAt: Date.now() - 1, used: false },
      },
    })
    createInvite(accessPath, undefined)
    const stored = readJson(invitesPath) as { invites?: Record<string, unknown> }
    expect(stored.invites?.['expiredtoken']).toBeUndefined()
  })
})

describe('listInvites', () => {
  let tmp: string
  let accessPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'invites-list-test-'))
    accessPath = join(tmp, 'telegram', 'access.json')
    mkdirSync(join(tmp, 'telegram'), { recursive: true })
    writeJson(accessPath, { dmPolicy: 'allowlist' })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('returns empty array when no invites file exists', () => {
    expect(listInvites(accessPath)).toEqual([])
  })

  it('returns active tokens', () => {
    createInvite(accessPath, undefined, 'telegram', 60000)
    const list = listInvites(accessPath)
    expect(list.length).toBe(1)
    expect(list[0]!.used).toBe(false)
  })

  it('excludes expired tokens from the list (prunes them)', () => {
    const invitesPath = join(tmp, 'telegram', 'invites.json')
    writeJson(invitesPath, {
      invites: {
        expired1: { createdAt: Date.now() - 200000, expiresAt: Date.now() - 1, used: false },
      },
    })
    expect(listInvites(accessPath)).toEqual([])
  })
})

describe('revokeInvite', () => {
  let tmp: string
  let accessPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'invites-revoke-test-'))
    accessPath = join(tmp, 'telegram', 'access.json')
    mkdirSync(join(tmp, 'telegram'), { recursive: true })
    writeJson(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('returns false when the token does not exist', () => {
    expect(revokeInvite(accessPath, 'nonexistent')).toBe(false)
  })

  it('removes the token and returns true', () => {
    const { token } = createInvite(accessPath, undefined)
    expect(revokeInvite(accessPath, token)).toBe(true)
    expect(listInvites(accessPath)).toEqual([])
  })

  it('restores dmPolicy to allowlist when the last active invite is revoked', () => {
    writeJson(accessPath, { dmPolicy: 'pairing' })
    const { token } = createInvite(accessPath, undefined)
    revokeInvite(accessPath, token)
    expect(readJson(accessPath).dmPolicy).toBe('allowlist')
  })

  it('does NOT change dmPolicy when other active invites remain', () => {
    const r1 = createInvite(accessPath, undefined)
    createInvite(accessPath, undefined) // second invite still active
    revokeInvite(accessPath, r1.token)
    expect(readJson(accessPath).dmPolicy).toBe('pairing')
  })
})

describe('runInviteMonitorTick', () => {
  let tmp: string
  let agentsRoot: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'invite-monitor-test-'))
    agentsRoot = join(tmp, 'agents')
    mkdirSync(agentsRoot, { recursive: true })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('does nothing when there are no access.json files', () => {
    expect(() => runInviteMonitorTick('jarvis', agentsRoot)).not.toThrow()
  })

  it('auto-approves a pending entry when a live invite exists', () => {
    // Set up a main-agent telegram channel dir with access.json + invites.json
    // channel-invites reads from channelStateDir(provider) for the main agent.
    // We can't easily inject the channel dir here, so test via the agentsRoot path.
    const agentName = 'rick'
    const agentChannelDir = join(agentsRoot, agentName, '.claude', 'channels', 'telegram')
    mkdirSync(agentChannelDir, { recursive: true })
    const accessPath = join(agentChannelDir, 'access.json')
    writeJson(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: {
        code1: { senderId: 'user123', chatId: '123', createdAt: Date.now() - 1000, expiresAt: Date.now() + 60000 },
      },
    })
    const invitesPath = join(agentChannelDir, 'invites.json')
    writeJson(invitesPath, {
      invites: {
        testtoken: { createdAt: Date.now() - 100, expiresAt: Date.now() + 86400000, used: false },
      },
    })

    runInviteMonitorTick('jarvis', agentsRoot)

    const access = readJson(accessPath) as { allowFrom?: string[]; pending?: Record<string, unknown>; dmPolicy?: string }
    expect(access.allowFrom).toContain('user123')
    expect(Object.keys(access.pending || {}).length).toBe(0)
  })
})

describe('startInviteMonitor / stopInviteMonitor', () => {
  afterEach(() => stopInviteMonitor())

  it('starts and stops without errors', () => {
    const agentsRoot = mkdtempSync(join(tmpdir(), 'monitor-lifecycle-'))
    expect(() => startInviteMonitor('jarvis', agentsRoot, 999999)).not.toThrow()
    expect(() => stopInviteMonitor()).not.toThrow()
    rmSync(agentsRoot, { recursive: true, force: true })
  })

  it('does not start a second interval if already running', () => {
    const agentsRoot = mkdtempSync(join(tmpdir(), 'monitor-dedup-'))
    startInviteMonitor('jarvis', agentsRoot, 999999)
    expect(() => startInviteMonitor('jarvis', agentsRoot, 999999)).not.toThrow()
    stopInviteMonitor()
    rmSync(agentsRoot, { recursive: true, force: true })
  })
})
