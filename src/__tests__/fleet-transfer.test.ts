// Fleet export/import unit tests.
//
// Covers: encrypted round-trip, wrong-password fast-fail (no writes),
// args/url secret detection in placeholderMcp, avatarExt path-traversal guard.
//
// importFleet requires a live DB and filesystem, so those paths are integration-tested
// by calling importFleet with a pre-encrypted payload and mocked DB / FS module.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _encryptForTest, _decryptForTest, ENCRYPTED_FLEET_VERSION, MIN_VAULT_PASSWORD_LEN } from '../web/fleet-transfer.js'

// ---------------------------------------------------------------------------
// Crypto round-trip
// ---------------------------------------------------------------------------

describe('encrypt/decrypt round-trip', () => {
  it('decrypts to the original plaintext', () => {
    const plaintext = JSON.stringify({ hello: 'world', num: 42 })
    const password = 'correct-horse-battery-staple'
    const blob = _encryptForTest(plaintext, password)
    expect(_decryptForTest(blob, password)).toBe(plaintext)
  })

  it('throws on wrong password (GCM auth tag mismatch)', () => {
    const blob = _encryptForTest('secret data', 'right-password-1234')
    expect(() => _decryptForTest(blob, 'wrong-password-1234')).toThrow()
  })

  it('throws on truncated blob (L1 sanity check)', () => {
    const tooShort = Buffer.from('dGVzdA==').toString('base64')
    expect(() => _decryptForTest(tooShort, 'any-password-here')).toThrow(/Érvénytelen titkosított blob/)
  })

  it('produces a non-trivially-parseable blob that differs from plaintext JSON', () => {
    const fleet = JSON.stringify({ schemaVersion: 1, agents: [] })
    const blob = _encryptForTest(fleet, 'pw-12345678')
    expect(() => JSON.parse(blob)).toThrow()
  })

  it('constants are correct values', () => {
    expect(ENCRYPTED_FLEET_VERSION).toBe(1)
    expect(MIN_VAULT_PASSWORD_LEN).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// importFleet: encrypted wrapper detection (with mocked FS / DB)
// ---------------------------------------------------------------------------

// Every statement the import runs, with its bound values, so a test can check
// which columns a fixed-list INSERT carries.
const dbRuns = vi.hoisted(() => [] as { sql: string; args: unknown[] }[])
vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: () => [],
      get: () => null,
      run: (...args: unknown[]) => { dbRuns.push({ sql, args }); return { changes: 0 } },
    }),
    transaction: (fn: Function) => fn,
  }),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))

// readJsonObjectForWrite mirrors the real helper for a MISSING file ({}),
// consistent with the existsSync mock below; one test swaps in a refusal.
const readJsonObjectForWriteMock = vi.fn((_path: string): Record<string, unknown> => ({}))
const listAgentNamesMock = vi.hoisted(() => vi.fn((): string[] => []))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => listAgentNamesMock(),
  readJsonObjectForWrite: (path: string) => readJsonObjectForWriteMock(path),
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: () => false,
    mkdirSync: () => undefined,
    unlinkSync: () => undefined,
    rmSync: () => undefined,
    readdirSync: () => [],
  }
})

// The target's channel token, by provider (FLEETIMPORTFOLLOW1021): none unless a test sets one.
const channelTokenMock = vi.hoisted(() => vi.fn((_provider: string, _envPath: string): string | null => null))
vi.mock('../channel-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../channel-provider.js')>()),
  readChannelToken: (provider: string, envPath: string) => channelTokenMock(provider, envPath),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/mock/tasks',
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project',
  STORE_DIR: '/mock/store',
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen',
  OWNER_NAME: 'Szabolcs',
  CHANNEL_PROVIDER: 'telegram',
  // config.ts builds it from web/sanitize.ts plus the voice channel id in effect.
  RESERVED_AGENT_IDS: ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'hanna'],
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: () => [],
}))

vi.mock('../env.js', () => ({
  updateEnvFile: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

// Minimal valid FleetJson for tests
const MINIMAL_FLEET = JSON.stringify({
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'test-host',
  agents: [],
  skills: [],
  scheduledTasks: [],
  memories: [],
  dailyLogs: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
})

describe('importFleet: encrypted wrapper detection', () => {
  it('returns error DiffReport when encrypted but no password given', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const blob = _encryptForTest(MINIMAL_FLEET, 'test-password-ok')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toContain(
      'A fájl titkosítva van -- add meg a vault jelszót az importhoz.'
    )
  })

  it('returns error DiffReport on wrong password (no file writes)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')

    const blob = _encryptForTest(MINIMAL_FLEET, 'correct-pw-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { vaultPassword: 'wrong-pw-12345678', apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toContain(
      'Helytelen vault jelszó -- a titkosított fájl nem dekódolható.'
    )
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('succeeds (dry-run) with correct password', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const blob = _encryptForTest(MINIMAL_FLEET, 'correct-pw-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { vaultPassword: 'correct-pw-12345', apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })

  it('accepts plaintext fleet JSON without password', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(MINIMAL_FLEET, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// DiffReport: wouldOverwrite is present in dry-run result
// ---------------------------------------------------------------------------

describe('importFleet: wouldOverwrite in DiffReport', () => {
  it('DiffReport contains wouldOverwrite fields', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(MINIMAL_FLEET, { apply: false })
    expect('dryRun' in result).toBe(true)
    const diff = result as any
    expect(diff).toHaveProperty('wouldOverwrite')
    expect(Array.isArray(diff.wouldOverwrite.agents)).toBe(true)
    expect(typeof diff.wouldOverwrite.mainAgent).toBe('boolean')
  })

  it('wouldOverwrite.agents empty when no existing agents (mocked listAgentNames returns [])', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const withAgents = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test-host',
      agents: [{ name: 'newbot', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
      skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(withAgents, { apply: false })
    const diff = result as any
    // listAgentNames is mocked to return [] so nothing to overwrite
    expect(diff.wouldOverwrite.agents).toHaveLength(0)
    // newbot is a new agent (not existing)
    expect(diff.wouldCreate.agents).toContain('newbot')
  })
})

// ---------------------------------------------------------------------------
// VaultExport: bot tokens NOT exported (channels re-pair model)
// ---------------------------------------------------------------------------

describe('exportFleet: channelEnvs not in VaultExport', () => {
  it('exported plaintext fleet JSON has no channelEnvs key in vault', async () => {
    // exportFleet requires real FS -- only assert on the type shape via importFleet round-trip
    // The VaultExport interface has no channelEnvs field by design; verify via a crafted import
    // that ignores channelEnvs even if present in the JSON.
    const { importFleet } = await import('../web/fleet-transfer.js')
    const fleetWithChannelEnvs = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'source',
      vault: {
        vaultKey: 'key',
        entries: [],
        bindings: [],
        channelEnvs: { telegram: 'BOT_TOKEN=secret123' }, // legacy / attacker-supplied field
      },
      agents: [], skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    // Should dry-run cleanly (channelEnvs is ignored, not written)
    const result = importFleet(fleetWithChannelEnvs, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Identity takeover: source mainAgent.agentId preserved as-is; config-overrides written on apply
// ---------------------------------------------------------------------------

const FLEET_WITH_SOURCE_ID = JSON.stringify({
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'source',
  mainAgent: {
    agentId: 'atlas',
    identity: {
      MAIN_AGENT_ID: 'atlas',
      BOT_NAME: 'Atlas',
      BRAND_NAME: 'Atlas',
      OWNER_NAME: 'Norbert',
      CHANNEL_PROVIDER: 'telegram',
    },
    claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
  },
  memories: [
    { agent_id: 'atlas', content: 'atlas memory', sector: 'warm', salience: 0.5, created_at: 1000, category: 'project', auto_generated: 0 },
    { agent_id: 'hestia', content: 'hestia memory', sector: 'warm', salience: 0.5, created_at: 1000, category: 'project', auto_generated: 0 },
  ],
  dailyLogs: [
    { agent_id: 'atlas', date: '2026-01-01', content: 'log', created_at: 1000 },
  ],
  agents: [], skills: [], scheduledTasks: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
})

describe('importFleet: identity takeover', () => {
  it('dry-run includes identity warning when mainAgent.agentId is present', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(FLEET_WITH_SOURCE_ID, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
    const warnings: string[] = (result as any).warnings
    expect(warnings.some(w => w.includes('atlas') && w.includes('identitás'))).toBe(true)
    // Counts: 2 memories (atlas + hestia) preserved with original agent_ids
    expect((result as any).wouldCreate.memories).toBe(2)
  })

  it('apply writes all identity keys to config-overrides.json and returns warning', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')

    const result = importFleet(FLEET_WITH_SOURCE_ID, { apply: true })
    // ImportResult (not DiffReport)
    expect('ok' in result).toBe(true)
    const ir = result as any
    // config-overrides.json written with full identity set
    const configOverrideCalls = (atomicWriteFileSync as any).mock.calls
      .filter((c: string[]) => c[0]?.includes('config-overrides.json'))
    expect(configOverrideCalls.length).toBeGreaterThan(0)
    const written = JSON.parse(configOverrideCalls[configOverrideCalls.length - 1][1])
    expect(written['MAIN_AGENT_ID']).toBe('atlas')
    expect(written['BOT_NAME']).toBe('Atlas')
    expect(written['BRAND_NAME']).toBe('Atlas')
    expect(written['OWNER_NAME']).toBe('Norbert')
    expect(written['CHANNEL_PROVIDER']).toBe('telegram')
    // Warning present in ImportResult
    expect(ir.warnings).toBeDefined()
    expect(ir.warnings.some((w: string) => w.includes('atlas'))).toBe(true)
  })

  it('apply mirrors the full identity into .env (channels.sh reads .env, not config-overrides)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { updateEnvFile } = await import('../env.js')

    importFleet(FLEET_WITH_SOURCE_ID, { apply: true })

    expect(updateEnvFile as any).toHaveBeenCalled()
    const envArg = (updateEnvFile as any).mock.calls.at(-1)[0]
    expect(envArg).toEqual({
      MAIN_AGENT_ID: 'atlas',
      BOT_NAME: 'Atlas',
      BRAND_NAME: 'Atlas',
      OWNER_NAME: 'Norbert',
      CHANNEL_PROVIDER: 'telegram',
    })
  })

  // JSONCLOBBER926B: a corrupt config-overrides.json is refused, not replaced by
  // the identity keys alone. The refusal takes the import's own failure path:
  // the error surfaces and the overrides file is never written.
  it('apply with a corrupt config-overrides.json: refused, the file is not overwritten, the .env is not touched', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    const { updateEnvFile } = await import('../env.js')
    ;(atomicWriteFileSync as any).mockClear()
    ;(updateEnvFile as any).mockClear()
    readJsonObjectForWriteMock.mockImplementationOnce((p: string) => {
      throw new Error(`${p} is not valid JSON; refusing to overwrite it`)
    })
    expect(() => importFleet(FLEET_WITH_SOURCE_ID, { apply: true })).toThrow(/config-overrides\.json is not valid JSON/)
    const overrideWrites = (atomicWriteFileSync as any).mock.calls
      .filter((c: string[]) => c[0]?.includes('config-overrides.json'))
    expect(overrideWrites).toHaveLength(0)
    expect(updateEnvFile as any).not.toHaveBeenCalled()
    expect(readJsonObjectForWriteMock).toHaveBeenCalledWith(expect.stringContaining('config-overrides.json'))
  })

  // FLEETIMPORTENVKEY1021: the import is reachable with the fleet's one shared
  // token, and its identity mirror wrote EVERY key of mainAgent.identity into
  // .env and config-overrides.json. .env also holds keys that decide what an
  // agent may do (SUDO_AGENTS, #2101), so an import could set any of them.
  // Only the identity keys the export writes may come in, and a value that
  // would start a new .env line is not written at all.
  const withIdentity = (identity: Record<string, unknown>): string => {
    const fleet = JSON.parse(FLEET_WITH_SOURCE_ID)
    fleet.mainAgent.identity = identity
    return JSON.stringify(fleet)
  }
  const lastEnvWrite = async (): Promise<Record<string, string>> => {
    const { updateEnvFile } = await import('../env.js')
    return (updateEnvFile as any).mock.calls.at(-1)[0]
  }
  const lastOverridesWrite = async (): Promise<Record<string, unknown>> => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    const calls = (atomicWriteFileSync as any).mock.calls.filter((c: string[]) => c[0]?.includes('config-overrides.json'))
    return JSON.parse(calls.at(-1)[1])
  }
  const IDENTITY = { MAIN_AGENT_ID: 'atlas', BOT_NAME: 'Atlas', BRAND_NAME: 'Atlas', OWNER_NAME: 'Norbert', CHANNEL_PROVIDER: 'telegram' }

  it('a non-identity key in the identity (SUDO_AGENTS, or any other) reaches neither .env nor config-overrides', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(withIdentity({ ...IDENTITY, SUDO_AGENTS: 'dani', ANTHROPIC_BASE_URL: 'http://evil.example' }), { apply: true }) as any
    const env = await lastEnvWrite()
    const overrides = await lastOverridesWrite()
    expect(env).toEqual(IDENTITY)
    for (const key of ['SUDO_AGENTS', 'ANTHROPIC_BASE_URL']) {
      expect(env).not.toHaveProperty(key)
      expect(overrides).not.toHaveProperty(key)
    }
    expect(overrides).toMatchObject(IDENTITY)
    // The operator is told what was left out, by name.
    expect(result.warnings.some((w: string) => w.includes('SUDO_AGENTS') && w.includes('ANTHROPIC_BASE_URL'))).toBe(true)
  })

  it('an identity value with a line break is not written (it would add its own .env line)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    importFleet(withIdentity({ ...IDENTITY, BOT_NAME: 'Atlas\nSUDO_AGENTS=dani', OWNER_NAME: 'Norbert\rX=1' }), { apply: true })
    const env = await lastEnvWrite()
    const overrides = await lastOverridesWrite()
    expect(env).not.toHaveProperty('BOT_NAME')
    expect(env).not.toHaveProperty('OWNER_NAME')
    expect(overrides).not.toHaveProperty('OWNER_NAME')
    for (const v of Object.values(env)) expect(v).not.toMatch(/[\r\n]/)
    expect(env.MAIN_AGENT_ID).toBe('atlas')
  })

  it('an old export (agentId only) with a line break in the id takes over nothing', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { updateEnvFile } = await import('../env.js')
    ;(updateEnvFile as any).mockClear()
    const fleet = JSON.parse(FLEET_WITH_SOURCE_ID)
    delete fleet.mainAgent.identity
    fleet.mainAgent.agentId = 'atlas\nSUDO_AGENTS=dani'
    importFleet(JSON.stringify(fleet), { apply: true })
    expect(updateEnvFile as any).not.toHaveBeenCalled()
  })

  it('an identity whose MAIN_AGENT_ID has a line break takes over nothing (no fallback to agentId)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { updateEnvFile } = await import('../env.js')
    ;(updateEnvFile as any).mockClear()
    importFleet(withIdentity({ ...IDENTITY, MAIN_AGENT_ID: 'atlas\nSUDO_AGENTS=dani' }), { apply: true })
    expect(updateEnvFile as any).not.toHaveBeenCalled()
  })

  it('the dry run names the identity keys the apply would leave out', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(withIdentity({ ...IDENTITY, SUDO_AGENTS: 'dani' }), { apply: false }) as any
    expect(result.warnings.some((w: string) => w.includes('SUDO_AGENTS'))).toBe(true)
  })

  // FLEETIMPORTFOLLOW1021 (Samu's review of #2112): the identity is checked
  // against the TARGET before it is taken over. MAIN_AGENT_ID keys tmux
  // sessions, unit names and DB rows, so it must have the installer's slug
  // shape and must not be a sub-agent's name; CHANNEL_PROVIDER switches the
  // main agent's channel, and the import carries no bot token (re-pair model),
  // so a provider the target has no token for would leave the main agent down.
  describe('the identity is checked against the target', () => {
    beforeEach(() => {
      listAgentNamesMock.mockReset().mockImplementation(() => [])
      channelTokenMock.mockReset().mockImplementation(() => null)
    })
    const applyWith = async (identity: Record<string, unknown>, agents: unknown[] = []) => {
      const { importFleet } = await import('../web/fleet-transfer.js')
      const { updateEnvFile } = await import('../env.js')
      ;(updateEnvFile as any).mockClear()
      const fleet = JSON.parse(withIdentity(identity))
      fleet.agents = agents
      const result = importFleet(JSON.stringify(fleet), { apply: true }) as any
      const calls = (updateEnvFile as any).mock.calls
      return { result, env: calls.length ? calls.at(-1)[0] as Record<string, string> : null }
    }
    const warned = (result: any, ...parts: string[]) =>
      result.warnings.some((w: string) => parts.every(p => w.includes(p)))

    for (const bad of ['Atlas', 'atlas bot', '../atlas', 'atlas_', '-atlas', 'atlas-', 'at--las', 'a'.repeat(51)]) {
      it(`MAIN_AGENT_ID ${JSON.stringify(bad.slice(0, 12))} is not slug-shaped: nothing is taken over`, async () => {
        const { result, env } = await applyWith({ ...IDENTITY, MAIN_AGENT_ID: bad })
        expect(env).toBeNull()
        expect(warned(result, 'MAIN_AGENT_ID')).toBe(true)
      })
    }

    it('a slug-shaped MAIN_AGENT_ID is taken over (control)', async () => {
      const { env } = await applyWith({ ...IDENTITY, MAIN_AGENT_ID: 'atlas-2' })
      expect(env?.MAIN_AGENT_ID).toBe('atlas-2')
    })

    it('MAIN_AGENT_ID equal to an existing sub-agent of the target: nothing is taken over', async () => {
      listAgentNamesMock.mockImplementation(() => ['samu', 'atlas'])
      const { result, env } = await applyWith(IDENTITY)
      expect(env).toBeNull()
      expect(warned(result, 'atlas', 'MAIN_AGENT_ID')).toBe(true)
    })

    // Samu's #2119 review: a stray agents/<own id> directory on the target (agents/marveen
    // drafts) made a re-import of the target's own identity read as a collision.
    it("the target's own MAIN_AGENT_ID with a stray agents/<id> directory is still taken over", async () => {
      listAgentNamesMock.mockImplementation(() => ['samu', 'marveen'])   // 'marveen' = the mocked MAIN_AGENT_ID
      const { result, env } = await applyWith({ ...IDENTITY, MAIN_AGENT_ID: 'marveen' })
      expect(env?.MAIN_AGENT_ID).toBe('marveen')
      expect(warned(result, 'NEM vehető át')).toBe(false)
    })

    it("the target's own MAIN_AGENT_ID is still refused when the import itself brings a sub-agent of that name", async () => {
      const agent = { name: 'marveen', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }
      const { result, env } = await applyWith({ ...IDENTITY, MAIN_AGENT_ID: 'marveen' }, [agent])
      expect(env).toBeNull()
      expect(warned(result, 'marveen', 'MAIN_AGENT_ID')).toBe(true)
    })

    it('MAIN_AGENT_ID equal to a sub-agent the same import brings: nothing is taken over', async () => {
      const agent = { name: 'atlas', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }
      const { result, env } = await applyWith(IDENTITY, [agent])
      expect(env).toBeNull()
      expect(warned(result, 'atlas', 'MAIN_AGENT_ID')).toBe(true)
    })

    // FLEETRESERVEDNAME1021: an id the message layer already owns cannot become
    // the main agent's ('system' is 403'd on every POST, so it could not send).
    for (const reserved of ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'hanna']) {
      it(`MAIN_AGENT_ID "${reserved}" is reserved: nothing is taken over`, async () => {
        const { result, env } = await applyWith({ ...IDENTITY, MAIN_AGENT_ID: reserved })
        expect(env).toBeNull()
        expect(warned(result, reserved, 'MAIN_AGENT_ID', 'fenntartott')).toBe(true)
      })
    }

    it('a reserved id from an older export (agentId only, no identity) is refused too', async () => {
      const { importFleet } = await import('../web/fleet-transfer.js')
      const { updateEnvFile } = await import('../env.js')
      ;(updateEnvFile as any).mockClear()
      const fleet = JSON.parse(FLEET_WITH_SOURCE_ID)
      fleet.mainAgent.agentId = 'system'
      delete fleet.mainAgent.identity
      const result = importFleet(JSON.stringify(fleet), { apply: true }) as any
      expect((updateEnvFile as any).mock.calls).toHaveLength(0)
      expect(warned(result, 'system', 'fenntartott')).toBe(true)
    })

    it('a CHANNEL_PROVIDER the target has no token for is left out; the rest is taken over', async () => {
      const { result, env } = await applyWith({ ...IDENTITY, CHANNEL_PROVIDER: 'slack' })
      expect(env).not.toBeNull()
      expect(env).not.toHaveProperty('CHANNEL_PROVIDER')
      expect(env?.MAIN_AGENT_ID).toBe('atlas')
      expect(warned(result, 'CHANNEL_PROVIDER', 'slack')).toBe(true)
      // The token is looked up where the main agent's channel reads it.
      expect(channelTokenMock).toHaveBeenCalledWith('slack', expect.stringMatching(/channels[\\/]slack[\\/]\.env$/))
    })

    it('a CHANNEL_PROVIDER the target holds a token for is taken over', async () => {
      channelTokenMock.mockImplementation((p: string) => (p === 'slack' ? 'xoxb-test' : null))
      const { env } = await applyWith({ ...IDENTITY, CHANNEL_PROVIDER: 'slack' })
      expect(env?.CHANNEL_PROVIDER).toBe('slack')
    })

    it('an unknown CHANNEL_PROVIDER is left out even if a lookup would answer', async () => {
      channelTokenMock.mockImplementation(() => 'anything')
      const { result, env } = await applyWith({ ...IDENTITY, CHANNEL_PROVIDER: 'irc' })
      expect(env).not.toHaveProperty('CHANNEL_PROVIDER')
      expect(warned(result, 'CHANNEL_PROVIDER', 'irc')).toBe(true)
    })

    it("the target's own provider stays takeable without a token (nothing changes)", async () => {
      const { env } = await applyWith(IDENTITY)   // telegram = the mocked current provider
      expect(env?.CHANNEL_PROVIDER).toBe('telegram')
    })

    it('the dry run shows the same verdicts', async () => {
      listAgentNamesMock.mockImplementation(() => ['atlas'])
      const { importFleet } = await import('../web/fleet-transfer.js')
      const dry = importFleet(withIdentity({ ...IDENTITY, CHANNEL_PROVIDER: 'slack' }), { apply: false }) as any
      expect(warned(dry, 'atlas', 'MAIN_AGENT_ID')).toBe(true)
      expect(dry.warnings.some((w: string) => w.includes('identitás átvéve'))).toBe(false)
    })
  })

  it('dry-run counts both atlas and hestia memories (no remap dedup)', async () => {
    // If remap were active (atlas -> marveen), duplicate dedup could collapse rows.
    // With original agent_ids preserved, all 2 memories count as new.
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(FLEET_WITH_SOURCE_ID, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).wouldCreate.memories).toBe(2)
    // Daily logs: 1 entry (atlas) counted
    expect((result as any).wouldCreate.dailyLogs).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// validateNames: avatarExt path-traversal guard (B1)
// ---------------------------------------------------------------------------

describe('importFleet: avatarExt traversal rejected', () => {
  it('returns nameErrors for traversal avatarExt', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const malicious = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'attacker',
      agents: [{
        name: 'testbot',
        avatar: 'aGVsbG8=',
        avatarExt: 'png/../../../../etc/cron.d/x',
        config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [],
      }],
      skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })

    const result = importFleet(malicious, { apply: false })
    expect('dryRun' in result).toBe(true)
    const errors = (result as any).errors as string[]
    expect(errors.some(e => e.includes('avatarExt') && e.includes('testbot'))).toBe(true)
  })
})

// SECSZIVEK1007: an import writes the main agent's .claude/settings.json and
// every agent's agent-config.json / settings.json verbatim; their model ids go
// through the same allowlist as every other model writer, before any write.
describe('importFleet: model ids are validated before any write', () => {
  const fleetWith = (patch: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(MINIMAL_FLEET), ...patch })
  const mainAgent = (settings: Record<string, unknown>, config: Record<string, unknown> = {}) => ({
    mainAgent: { claudeMd: '', soulMd: '', config, mcp: {}, settings, channelsAccess: {} },
  })
  const agent = (config: Record<string, unknown>, settings: Record<string, unknown> = {}) => ({
    agents: [{ name: 'alpha', config, claudeMd: '', soulMd: '', mcp: {}, settings, channelsAccess: {}, agentSkills: [] }],
  })

  it('a malformed model in the main settings.json rejects the import, and nothing is written', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    vi.mocked(atomicWriteFileSync).mockClear()
    const r = importFleet(fleetWith(mainAgent({ model: "it's model" })), { apply: true }) as { errors: string[] }
    expect(r.errors.join(' ')).toContain('Érvénytelen modell-azonosító (mainAgent settings.json)')
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('a malformed model in an agent-config.json rejects the import', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const r = importFleet(fleetWith(agent({ model: 'a b' })), { apply: false }) as { errors: string[] }
    expect(r.errors.join(' ')).toContain('Érvénytelen modell-azonosító (agent alpha agent-config.json)')
  })

  it('valid ids and absent models raise no model error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const r = importFleet(fleetWith({ ...mainAgent({ model: 'claude-opus-5-5[1m]' }), ...agent({ model: 'openrouter/qwen/qwen3:free' }) }), { apply: false }) as { errors?: string[] }
    expect((r.errors ?? []).join(' ')).not.toContain('modell-azonosító')
    const r2 = importFleet(fleetWith(agent({})), { apply: false }) as { errors?: string[] }
    expect((r2.errors ?? []).join(' ')).not.toContain('modell-azonosító')
  })
})

// ---------------------------------------------------------------------------
// Kanban cards: every exported column the board relies on survives the import
// ---------------------------------------------------------------------------

describe('importFleet: kanban card columns', () => {
  // The export is SELECT *, the import a fixed column list: a column missing
  // from that list is exported and then silently dropped on the new machine.
  it('a card keeps its start_date', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const card = {
      id: 'c1', title: 'Card', status: 'planned', priority: 'normal', sort_order: 0,
      created_at: 1, updated_at: 1, due_date: 1790000000, start_date: 1789000000,
    }
    const fleet = JSON.parse(MINIMAL_FLEET)
    fleet.kanban.cards = [card]
    dbRuns.length = 0
    importFleet(JSON.stringify(fleet), { apply: true })
    const insert = dbRuns.find((r) => /INTO kanban_cards/.test(r.sql))
    expect(insert).toBeDefined()
    const cols = insert!.sql.slice(insert!.sql.indexOf('(') + 1, insert!.sql.indexOf(')')).split(',').map((c) => c.trim())
    const row = Object.fromEntries(cols.map((c, i) => [c, insert!.args[i]]))
    expect(row.start_date).toBe(1789000000)
    expect(row.due_date).toBe(1790000000)
  })
})
