// GMAILDRAFT1116 review round 2 (E1): the fleet export/import and the reserved vault entries (the owner's
// send-capable gmail.compose grant). The export never carries one, in any spelling, also for the owner (the export
// with secrets is owner-only, so the owner's export IS the case); the import never writes one from a bundle, and keeps
// this machine's own reserved entries, re-encrypted with the bundle's master key (the import swaps the key), or drops
// one the current key cannot open, with a warn line. The vault is REAL (vault.ts, file master key, temp install); the
// Keychain is mocked away.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-reserved-fleet-'))
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'marveen', BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen', OWNER_NAME: 'Test', CHANNEL_PROVIDER: 'telegram', RESERVED_AGENT_IDS: [],
}))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainStore: () => { throw new Error('keychain must not be touched in this test') },
  keychainRetrieveStatus: () => ({ status: 'unavailable', value: null }),
  keychainRetrieve: () => null,
  keychainDelete: () => true,
}))
vi.mock('../db.js', () => ({ getDb: () => ({}), backfillEmbeddings: () => Promise.resolve(), initDatabase: () => {} }))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/mock/agents', listAgentNames: () => [], readJsonObjectForWrite: () => ({}) }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: '/mock/tasks' }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn(), readEnvFile: () => ({}) }))
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: logSpy }))

const { _exportVaultForTest, _importVaultSectionForTest } = await import('../web/fleet-transfer.js')
const vault = await import('../web/vault.js')
const { isReservedVaultId } = await import('../web/vault-reserved.js')

const STORE = join(tmpRoot, 'store')
const KEY = join(STORE, '.vault-key')
const VAULT = join(STORE, 'vault.json')
const BINDINGS = join(STORE, 'vault-bindings.json')
const KEY_A = randomBytes(64).toString('base64')
const KEY_B = randomBytes(64).toString('base64')
const RID = 'gmail-draft-compose-refresh'
const SPELLINGS = [RID, 'gmail-draft-oauth-client', 'GMAIL_DRAFT_COMPOSE_REFRESH', 'GMAIL_DRAFT_OAUTH_CLIENT', 'Gmail-Draft-X']
const TARGET_VALUE = 'TARGET-refresh-1//keep-me-4c2e'
const BUNDLE_VALUE = 'BUNDLE-refresh-1//never-written-8a1f'

function freshVault(key: string) {
  rmSync(VAULT, { force: true })
  rmSync(BINDINGS, { force: true })
  writeFileSync(KEY, key + '\n', { mode: 0o600 })
}
const ids = () => (JSON.parse(readFileSync(VAULT, 'utf8')).entries as Array<{ id: string }>).map(e => e.id)

beforeEach(() => { logSpy.warn.mockClear() })

describe('export: no reserved entry leaves the machine, the owner export included', () => {
  it('X1 exportVault (what the owner-only GET /api/fleet/export with X-Vault-Password packs) skips every spelling, and bindings on them', () => {
    freshVault(KEY_A)
    vault.setSecret('NORMAL', 'n', 'normal-value')
    for (const id of SPELLINGS) vault.reservedVaultAccess.write(id, 'r', `${TARGET_VALUE}-${id}`)
    writeFileSync(BINDINGS, JSON.stringify({ bindings: [
      { vaultSecretId: RID, envVar: 'GMAIL', targets: [] },
      { vaultSecretId: 'GMAIL_DRAFT_OAUTH_CLIENT', envVar: 'GMAIL2', targets: [] },
      { vaultSecretId: 'NORMAL', envVar: 'N', targets: [] },
    ] }))
    const out = _exportVaultForTest()!
    expect(out.vaultKey).toBe(KEY_A)
    expect(out.entries.map(e => e.id)).toEqual(['NORMAL'])
    expect(out.bindings.map(b => b.vaultSecretId)).toEqual(['NORMAL'])
    const text = JSON.stringify(out).toLowerCase().replace(/_/g, '-')
    expect(text).not.toContain('gmail-draft')
    // the source machine keeps them
    expect(vault.reservedVaultAccess.read(RID)).toBe(`${TARGET_VALUE}-${RID}`)
  })
})

describe('import: never writes a reserved id from a bundle; keeps the target\'s own', () => {
  function bundleWith(reserved: boolean) {
    freshVault(KEY_B)
    vault.setSecret('FROM_BUNDLE', 'b', 'bundle-normal')
    if (reserved) for (const id of SPELLINGS) vault.reservedVaultAccess.write(id, 'r', BUNDLE_VALUE)
    const entries = JSON.parse(readFileSync(VAULT, 'utf8')).entries
    return {
      vaultKey: KEY_B, entries,
      bindings: [{ vaultSecretId: RID, envVar: 'GMAIL', targets: [] }, { vaultSecretId: 'FROM_BUNDLE', envVar: 'B', targets: [] }],
    }
  }

  it('M1 a bundle carrying reserved ids: none is written; the target\'s own reserved entry survives, re-encrypted under the bundle key', () => {
    const bundle = bundleWith(true)
    expect(bundle.entries.filter((e: { id: string }) => isReservedVaultId(e.id))).toHaveLength(SPELLINGS.length)
    freshVault(KEY_A)
    vault.setSecret('TARGET_NORMAL', 't', 'target-normal')
    vault.reservedVaultAccess.write(RID, 'r', TARGET_VALUE)
    _importVaultSectionForTest(bundle)
    expect(readFileSync(KEY, 'utf8').trim()).toBe(KEY_B)
    // the bundle's normal secrets replace the target's (unchanged import behaviour)
    expect(vault.getSecret('FROM_BUNDLE')).toBe('bundle-normal')
    expect(vault.getSecret('TARGET_NORMAL')).toBeNull()
    // exactly one reserved entry: the target's, readable with the NEW key, with the target's value
    expect(ids().filter(isReservedVaultId)).toEqual([RID])
    expect(vault.reservedVaultAccess.read(RID)).toBe(TARGET_VALUE)
    for (const id of SPELLINGS.slice(1)) expect(vault.reservedVaultAccess.present(id), id).toBe(false)
    expect(readFileSync(VAULT, 'utf8')).not.toContain(BUNDLE_VALUE)
    // no binding on a reserved id is written
    const b = JSON.parse(readFileSync(BINDINGS, 'utf8')).bindings.map((x: { vaultSecretId: string }) => x.vaultSecretId)
    expect(b).toEqual(['FROM_BUNDLE'])
    expect(logSpy.warn.mock.calls.map(c => c[0]?.event)).toContain('fleet-import-reserved-refused')
  })

  it('M2 a target reserved entry the current key cannot open is dropped, with a warn line naming it', () => {
    const bundle = bundleWith(false)
    freshVault(KEY_A)
    vault.setSecret('TARGET_NORMAL', 't', 'target-normal')
    const v = JSON.parse(readFileSync(VAULT, 'utf8'))
    v.entries.push({ id: RID, label: 'r', encrypted: randomBytes(80).toString('base64'), createdAt: 'x', updatedAt: 'x' })
    writeFileSync(VAULT, JSON.stringify(v))
    _importVaultSectionForTest(bundle)
    expect(ids()).toEqual(['FROM_BUNDLE'])
    const row = logSpy.warn.mock.calls.map(c => c[0]).find(f => f?.event === 'fleet-import-reserved-dropped')
    expect(row).toMatchObject({ ids: [RID] })
  })

  it('M3 no reserved entry anywhere: the import is the old one', () => {
    const bundle = bundleWith(false)
    freshVault(KEY_A)
    vault.setSecret('TARGET_NORMAL', 't', 'target-normal')
    _importVaultSectionForTest(bundle)
    expect(ids()).toEqual(['FROM_BUNDLE'])
    expect(vault.getSecret('FROM_BUNDLE')).toBe('bundle-normal')
    expect(logSpy.warn.mock.calls.filter(c => String(c[0]?.event ?? '').startsWith('fleet-import-reserved'))).toHaveLength(0)
  })
})
