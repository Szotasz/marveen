import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// VAULTKEYSTOREFILE1118: VAULT_KEY_STORE=file in .env keeps the vault master key in store/.vault-key and never
// calls the Keychain, in every process that loads vault.js. Before it, the only file-key switch
// (MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION) was read from process.env alone, which .env never reaches, so a locked
// login Keychain stopped every decrypt in the dashboard. The Keychain is a mock here: no test touches a real one.

const tmpRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vaultkeystore-test-'))
  // env.ts reads .env from here instead of the repo root (its test-only hatch, read at import time).
  process.env.CLAUDECLAW_ENV_DIR = root
  return root
})

const keychainMock = vi.hoisted(() => ({
  available: true,
  readResult: { status: 'empty' as 'ok' | 'empty' | 'unavailable', value: null as string | null },
  calls: [] as string[],
}))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => { keychainMock.calls.push('available'); return keychainMock.available },
  keychainRetrieveStatus: () => { keychainMock.calls.push('retrieve'); return { ...keychainMock.readResult } },
  keychainRetrieve: () => { keychainMock.calls.push('retrieve'); return keychainMock.readResult.value },
  keychainStore: () => { keychainMock.calls.push('store') },
  keychainDelete: () => { keychainMock.calls.push('delete'); return true },
}))

const storeDir = join(tmpRoot, 'store')
const envPath = join(tmpRoot, '.env')
const keyPath = join(storeDir, '.vault-key')
const migratedPath = join(storeDir, '.vault-key.migrated')

async function freshVault() {
  vi.resetModules()
  return await import('../web/vault.js')
}

function setEnvFile(line: string | null) {
  if (line === null) rmSync(envPath, { force: true })
  else writeFileSync(envPath, `BOT_NAME=Test\n${line}\n`)
}

// A real vault with one secret and its real key in store/.vault-key (the non-darwin file path writes it).
async function seedVaultWithSecret(): Promise<string> {
  keychainMock.available = false
  const v = await freshVault()
  v.setSecret('probe', 'Probe secret', 'probe-value-42')
  keychainMock.available = true
  keychainMock.calls = []
  return readFileSync(keyPath, 'utf-8').trim()
}

const oldProcessValue = process.env.VAULT_KEY_STORE
beforeEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })
  setEnvFile(null)
  delete process.env.VAULT_KEY_STORE
  keychainMock.available = true
  keychainMock.readResult = { status: 'empty', value: null }
  keychainMock.calls = []
})
afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  setEnvFile(null)
  if (oldProcessValue === undefined) delete process.env.VAULT_KEY_STORE
  else process.env.VAULT_KEY_STORE = oldProcessValue
})

describe('VAULTKEYSTOREFILE1118: VAULT_KEY_STORE=file in .env', () => {
  it('a locked Keychain no longer matters: the secret opens from the key file, the Keychain is never called, nothing is renamed', async () => {
    await seedVaultWithSecret()
    keychainMock.readResult = { status: 'unavailable', value: null }
    setEnvFile('VAULT_KEY_STORE=file')
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    v.setSecret('second', 'Second', 'v2')
    expect(v.getSecret('second')).toBe('v2')
    expect(keychainMock.calls).toEqual([])
    expect(existsSync(keyPath)).toBe(true)
    expect(existsSync(migratedPath)).toBe(false)
  })

  it('control: the same setup without the setting migrates the key to the Keychain (today\'s default is unchanged)', async () => {
    await seedVaultWithSecret()
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(keychainMock.calls).toContain('store')
    expect(existsSync(keyPath)).toBe(false)
    expect(existsSync(migratedPath)).toBe(true)
  })

  it('the value is matched case-insensitively and trimmed; any other value keeps the Keychain store', async () => {
    for (const [line, fileMode] of [
      ['VAULT_KEY_STORE=FILE', true], ['VAULT_KEY_STORE= file ', true],
      ['VAULT_KEY_STORE=keychain', false], ['VAULT_KEY_STORE=', false], ['VAULT_KEY_STORE=files', false],
    ] as const) {
      rmSync(storeDir, { recursive: true, force: true })
      mkdirSync(storeDir, { recursive: true })
      await seedVaultWithSecret()
      setEnvFile(line)
      const v = await freshVault()
      expect(v.getSecret('probe'), line).toBe('probe-value-42')
      expect(keychainMock.calls.length === 0, line).toBe(fileMode)
      expect(existsSync(keyPath), line).toBe(fileMode)
    }
  })

  it('the process environment wins over .env, in both directions', async () => {
    await seedVaultWithSecret()
    setEnvFile('VAULT_KEY_STORE=keychain')
    process.env.VAULT_KEY_STORE = 'file'
    let v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(keychainMock.calls).toEqual([])

    setEnvFile('VAULT_KEY_STORE=file')
    process.env.VAULT_KEY_STORE = 'keychain'
    v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(keychainMock.calls).toContain('store')
  })

  it('it is read on every key request: a change in .env takes effect without reloading the module', async () => {
    await seedVaultWithSecret()
    keychainMock.readResult = { status: 'unavailable', value: null }
    setEnvFile('VAULT_KEY_STORE=file')
    const v = await freshVault()
    expect(v.getSecret('probe')).toBe('probe-value-42')
    expect(keychainMock.calls).toEqual([])
    setEnvFile(null)
    v.getSecret('probe')
    expect(keychainMock.calls).toContain('available')
  })

  it('migrated layout (only .vault-key.migrated): a loud VaultKeyError that names the copy step; no key is generated, the Keychain is not read', async () => {
    const goodKey = await seedVaultWithSecret()
    writeFileSync(migratedPath, goodKey + '\n')
    rmSync(keyPath)
    keychainMock.readResult = { status: 'ok', value: goodKey }
    setEnvFile('VAULT_KEY_STORE=file')
    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/VAULT_KEY_STORE=file, but store\/\.vault-key is missing.*\.vault-key\.migrated/)
    expect(existsSync(keyPath)).toBe(false)
    expect(readFileSync(migratedPath, 'utf-8').trim()).toBe(goodKey)
    expect(keychainMock.calls).toEqual([])
  })

  it('a key file that does not open vault.json fails closed (VAULTUJKULCS822), and .migrated is untouched', async () => {
    const goodKey = await seedVaultWithSecret()
    writeFileSync(migratedPath, goodKey + '\n')
    writeFileSync(keyPath, Buffer.from('x'.repeat(64)).toString('base64') + '\n')
    setEnvFile('VAULT_KEY_STORE=file')
    const v = await freshVault()
    expect(() => v.getSecret('probe')).toThrowError(/does not decrypt vault.json/)
    expect(readFileSync(migratedPath, 'utf-8').trim()).toBe(goodKey)
    expect(keychainMock.calls).toEqual([])
  })

  it('first run (empty vault, no key): a new key file at mode 600, never a Keychain store', async () => {
    setEnvFile('VAULT_KEY_STORE=file')
    const v = await freshVault()
    v.setSecret('first', 'First', 'v1')
    expect(v.getSecret('first')).toBe('v1')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(keychainMock.calls).toEqual([])
  })

  it('the fleet export resolves from the key files without asking the Keychain, and its error names no Keychain', async () => {
    const goodKey = await seedVaultWithSecret()
    keychainMock.readResult = { status: 'unavailable', value: null }
    setEnvFile('VAULT_KEY_STORE=file')
    let v = await freshVault()
    expect(v.resolveMasterKeyForExport()).toBe(goodKey)
    expect(keychainMock.calls).toEqual([])

    writeFileSync(keyPath, Buffer.from('x'.repeat(64)).toString('base64') + '\n')
    v = await freshVault()
    let msg = ''
    try { v.resolveMasterKeyForExport() } catch (err: any) { msg = err.message }
    expect(msg).toMatch(/no available master key opens it/)
    expect(msg).not.toMatch(/Keychain/)
    expect(keychainMock.calls).toEqual([])
  })
})
