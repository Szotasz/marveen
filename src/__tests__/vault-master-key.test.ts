import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

// VAULTUJKULCS822: the master-key path must FAIL CLOSED. The old code silently
// generated a REPLACEMENT master key when the keychain did not answer (locked
// keychain -> retrieve returned null -> "no key, make one"), orphaning every
// existing secret; and the file->keychain migration renamed over
// .vault-key.migrated without verifying the file key decrypts vault.json.
// 2026-08-22 this chain nearly destroyed 49 production secrets.

const here = dirname(fileURLToPath(import.meta.url))

const tmpRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return mkdtempSync(join(tmpdir(), 'vaultkey-test-'))
})

const keychainMock = vi.hoisted(() => ({
  available: true,
  readResult: { status: 'empty' as 'ok' | 'empty' | 'unavailable', value: null as string | null },
  storeCalls: [] as string[],
  storeThrows: false,
}))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => keychainMock.available,
  keychainRetrieveStatus: () => ({ ...keychainMock.readResult }),
  keychainRetrieve: () => keychainMock.readResult.value,
  keychainStore: (v: string) => {
    if (keychainMock.storeThrows) throw new Error('store failed (test)')
    keychainMock.storeCalls.push(v)
  },
  keychainDelete: () => true,
}))

const storeDir = join(tmpRoot, 'store')
const vaultPath = join(storeDir, 'vault.json')
const keyPath = join(storeDir, '.vault-key')
const migratedPath = join(storeDir, '.vault-key.migrated')

async function freshVault() {
  vi.resetModules()
  return await import('../web/vault.js')
}

function resetStore() {
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })
  keychainMock.available = true
  keychainMock.readResult = { status: 'empty', value: null }
  keychainMock.storeCalls = []
  keychainMock.storeThrows = false
}

beforeEach(resetStore)
afterEach(() => rmSync(storeDir, { recursive: true, force: true }))

// Helper: build a real vault with one secret using a known key path, then
// return the working master key material for later manipulation.
async function seedVaultWithSecret(): Promise<string> {
  // File mode (non-darwin branch) writes the key next to the vault: simplest
  // way to create a REAL encrypted entry with a REAL key.
  keychainMock.available = false
  const v = await freshVault()
  v.setSecret('probe', 'Probe secret', 'probe-value-42')
  const key = readFileSync(keyPath, 'utf-8').trim()
  expect(key.length).toBeGreaterThan(0)
  return key
}

describe('VAULTUJKULCS822: fail-closed master key handling', () => {
  it('keychain UNAVAILABLE + existing entries -> VaultKeyError, no new key, secrets untouched', async () => {
    const goodKey = await seedVaultWithSecret()
    // Move to keychain mode with the key ONLY in the (now unreachable) keychain.
    rmSync(keyPath, { force: true })
    keychainMock.available = true
    keychainMock.readResult = { status: 'unavailable', value: null }

    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/Keychain did not answer/)
    // No replacement key generated anywhere:
    expect(keychainMock.storeCalls).toHaveLength(0)
    expect(existsSync(keyPath)).toBe(false)
    // The encrypted entry is intact and still opens with the good key later:
    keychainMock.readResult = { status: 'ok', value: goodKey }
    const v2 = await freshVault()
    expect(v2.getSecret('probe')).toBe('probe-value-42')
  })

  it('keychain EMPTY (answered, no item) + existing entries -> VaultKeyError, no silent generate', async () => {
    await seedVaultWithSecret()
    rmSync(keyPath, { force: true })
    keychainMock.available = true
    keychainMock.readResult = { status: 'empty', value: null }

    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/refusing to generate a new key/)
    expect(keychainMock.storeCalls).toHaveLength(0)
  })

  it('keychain EMPTY + empty vault -> generates and stores a new key (first-run path preserved)', async () => {
    keychainMock.available = true
    keychainMock.readResult = { status: 'empty', value: null }
    const v = await freshVault()
    v.setSecret('first', 'First', 'v1')
    expect(keychainMock.storeCalls).toHaveLength(1)
  })

  it('BOGUS .vault-key + existing entries -> refuses to use/migrate; .migrated is NOT clobbered', async () => {
    await seedVaultWithSecret()
    // The real key is "safe" in .migrated (the 2026-08-22 layout)...
    const goodKey = readFileSync(keyPath, 'utf-8').trim()
    writeFileSync(migratedPath, goodKey + '\n')
    // ...and a bogus key sits in .vault-key (what the old silent path produced).
    writeFileSync(keyPath, Buffer.from('x'.repeat(64)).toString('base64') + '\n')
    keychainMock.available = true

    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/does not decrypt vault.json/)
    // The bogus key never reached the keychain and .migrated survived intact:
    expect(keychainMock.storeCalls).toHaveLength(0)
    expect(readFileSync(migratedPath, 'utf-8').trim()).toBe(goodKey)
    expect(existsSync(keyPath)).toBe(true) // no rename happened
  })

  it('CORRECT .vault-key + existing entries -> verified migration proceeds', async () => {
    await seedVaultWithSecret()
    keychainMock.available = true
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(keychainMock.storeCalls).toHaveLength(1)
    expect(existsSync(keyPath)).toBe(false)
    expect(existsSync(migratedPath)).toBe(true)
  })

  it('non-darwin file mode: missing key file + existing entries -> VaultKeyError', async () => {
    await seedVaultWithSecret()
    rmSync(keyPath, { force: true })
    keychainMock.available = false
    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/\.vault-key is missing/)
    expect(existsSync(keyPath)).toBe(false) // no silent regenerate
  })
})

describe('VAULTUJKULCS822: keychain.ts hardening (source scan)', () => {
  // A locked keychain makes `security` block on a GUI prompt forever; every
  // exec must carry a timeout or the dashboard freezes (measured 48 minutes).
  it('every execFileSync call in keychain.ts passes a timeout', () => {
    const src = readFileSync(join(here, '..', 'web', 'keychain.ts'), 'utf-8')
    const calls = src.split('execFileSync(').slice(1)
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) {
      // The options object of each call (up to the closing of the call) must
      // mention the shared timeout constant.
      expect(c.slice(0, 400)).toMatch(/timeout:\s*SECURITY_TIMEOUT_MS/)
    }
  })

  it('retrieve distinguishes item-not-found (exit 44) from unavailable', () => {
    const src = readFileSync(join(here, '..', 'web', 'keychain.ts'), 'utf-8')
    expect(src).toMatch(/EXIT_ITEM_NOT_FOUND = 44/)
    expect(src).toMatch(/status === EXIT_ITEM_NOT_FOUND/)
  })
})

describe('PR #1048 review: corrupt vault.json must not look like an empty vault', () => {
  it('existing but unparseable vault.json -> VaultKeyError on key decisions (no silent new key)', async () => {
    writeFileSync(vaultPath, '{ this is not json', { mode: 0o600 })
    keychainMock.available = true
    keychainMock.readResult = { status: 'empty', value: null }
    const v = await freshVault()
    expect(() => v.setSecret('x', 'X', 'v')).toThrowError(/cannot be read or parsed/)
    expect(keychainMock.storeCalls).toHaveLength(0)
  })

  it('corrupt vault.json + present .vault-key -> migration refused, .migrated untouched', async () => {
    const goodKey = await seedVaultWithSecret()
    writeFileSync(migratedPath, goodKey + '\n')
    writeFileSync(vaultPath, '###corrupt###', { mode: 0o600 })
    keychainMock.available = true
    const v = await freshVault()
    expect(() => v.setSecret('x', 'X', 'v')).toThrowError(/cannot be read or parsed/)
    expect(keychainMock.storeCalls).toHaveLength(0)
    expect(readFileSync(migratedPath, 'utf-8').trim()).toBe(goodKey)
  })

  it('MISSING vault.json stays a legitimate first run (key generation allowed)', async () => {
    keychainMock.available = true
    keychainMock.readResult = { status: 'empty', value: null }
    const v = await freshVault()
    v.setSecret('first', 'First', 'v1')
    expect(keychainMock.storeCalls).toHaveLength(1)
  })
})
