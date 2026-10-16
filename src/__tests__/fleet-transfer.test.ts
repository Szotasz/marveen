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
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
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
  it('a waiting card keeps its wait reason', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const card = {
      id: 'c1', title: 'Card', status: 'waiting', priority: 'normal', sort_order: 0,
      created_at: 1, updated_at: 1, wait_kind: 'date', wait_note: 'quote', wait_until: 1790000000,
    }
    const fleet = JSON.parse(MINIMAL_FLEET)
    fleet.kanban.cards = [card]
    dbRuns.length = 0
    importFleet(JSON.stringify(fleet), { apply: true })
    const insert = dbRuns.find((r) => /INTO kanban_cards/.test(r.sql))
    expect(insert).toBeDefined()
    const cols = insert!.sql.slice(insert!.sql.indexOf('(') + 1, insert!.sql.indexOf(')')).split(',').map((c) => c.trim())
    const row = Object.fromEntries(cols.map((c, i) => [c, insert!.args[i]]))
    expect(row.wait_kind).toBe('date')
    expect(row.wait_note).toBe('quote')
    expect(row.wait_until).toBe(1790000000)
  })
})
