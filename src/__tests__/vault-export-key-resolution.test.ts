// exportVault() must resolve the vault master key from whichever source holds
// it (.vault-key, .vault-key.migrated or the Keychain), verified against
// vault.json, instead of inferring validity from which filename exists.
//
// Before this fix the mere presence of .vault-key.migrated (with no .vault-key)
// made exportVault() throw "the key was migrated to the Keychain, give a vault
// password" -- on an export that was already password-protected. getMasterKey()
// itself leaves that file behind after a Keychain migration, and it is a valid
// copy of the live key. A Keychain-only install (no key file at all) returned
// null, i.e. the secret-bearing export silently carried no vault.
//
// The vault entries here are REAL ciphertexts produced by vault.ts with a known
// key, so "opens the vault" is measured by an actual decrypt, not assumed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-export-keyres-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: join(tmpRoot, 'store'),
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen',
  OWNER_NAME: 'Test',
  CHANNEL_PROVIDER: 'telegram',
}))

// Keychain is driven per test. Default: not on macOS, so vault.ts runs its
// plain file-key path and the setup below can write real ciphertexts.
let keychainAvail = false
let keychainRead: { status: 'ok' | 'empty' | 'unavailable'; value: string | null } = { status: 'empty', value: null }
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => keychainAvail,
  keychainStore: () => {},
  keychainRetrieveStatus: () => keychainRead,
  keychainRetrieve: () => keychainRead.value,
  keychainDelete: () => true,
}))

// Heavy deps fleet-transfer imports but exportVault does not exercise.
vi.mock('../db.js', () => ({
  getDb: () => ({}),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))
vi.mock('../web/vault-bindings.js', () => ({ getBindings: () => [] }))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
  readJsonObjectForWrite: () => ({}),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({ SCHEDULED_TASKS_DIR: '/mock/tasks' }))
vi.mock('../env.js', () => ({ updateEnvFile: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

const { _exportVaultForTest } = await import('../web/fleet-transfer.js')
const { setSecret } = await import('../web/vault.js')

const STORE = join(tmpRoot, 'store')
const KEY = join(STORE, '.vault-key')
const MIGRATED = join(STORE, '.vault-key.migrated')
const VAULT = join(STORE, 'vault.json')

const LIVE_KEY = randomBytes(64).toString('base64')
const OTHER_KEY = randomBytes(64).toString('base64')

// Write `n` real secrets encrypted under LIVE_KEY, then remove the key file so
// each test places the key exactly where it wants it.
function seedVault(n: number): void {
  keychainAvail = false
  writeFileSync(KEY, LIVE_KEY + '\n', { mode: 0o600 })
  for (let i = 0; i < n; i++) setSecret(`s${i}`, `label ${i}`, `value-${i}`)
  rmSync(KEY)
}

beforeEach(() => {
  for (const f of [KEY, MIGRATED, VAULT]) if (existsSync(f)) rmSync(f)
  keychainAvail = false
  keychainRead = { status: 'empty', value: null }
})

describe('exportVault master-key source resolution', () => {
  it('exports with the key from .vault-key.migrated when .vault-key is gone (post-migration state)', () => {
    seedVault(2)
    writeFileSync(MIGRATED, LIVE_KEY + '\n')
    const out = _exportVaultForTest()
    expect(out).not.toBeNull()
    expect(out!.vaultKey).toBe(LIVE_KEY)
    expect(out!.entries).toHaveLength(2)
  })

  it('exports with the Keychain key when no key file exists (Keychain-only install)', () => {
    seedVault(1)
    keychainAvail = true
    keychainRead = { status: 'ok', value: LIVE_KEY }
    expect(_exportVaultForTest()!.vaultKey).toBe(LIVE_KEY)
  })

  it('skips a key file that does not open the vault and uses the source that does', () => {
    seedVault(1)
    writeFileSync(KEY, OTHER_KEY + '\n')
    writeFileSync(MIGRATED, LIVE_KEY + '\n')
    expect(_exportVaultForTest()!.vaultKey).toBe(LIVE_KEY)
  })

  it('still exports from a plain .vault-key (pre-migration install, unchanged behaviour)', () => {
    seedVault(1)
    writeFileSync(KEY, LIVE_KEY + '\n')
    expect(_exportVaultForTest()!.vaultKey).toBe(LIVE_KEY)
  })

  it('throws when the vault has secrets but no available key opens it', () => {
    seedVault(3)
    writeFileSync(MIGRATED, OTHER_KEY + '\n')
    expect(() => _exportVaultForTest()).toThrow(/no available master key opens it/)
  })

  it('names a locked Keychain in the error instead of blaming a missing key', () => {
    seedVault(1)
    keychainAvail = true
    keychainRead = { status: 'unavailable', value: null }
    expect(() => _exportVaultForTest()).toThrow(/Keychain did not answer/)
  })

  it('returns null (no-op) when there is no key and the vault is empty', () => {
    expect(_exportVaultForTest()).toBeNull()
  })

  it('never renames or creates key files while exporting (read-only)', () => {
    seedVault(1)
    writeFileSync(MIGRATED, LIVE_KEY + '\n')
    keychainAvail = true
    keychainRead = { status: 'ok', value: LIVE_KEY }
    _exportVaultForTest()
    expect(existsSync(MIGRATED)).toBe(true)
    expect(existsSync(KEY)).toBe(false)
  })
})

