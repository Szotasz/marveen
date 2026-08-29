import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isKeychainAvailable, keychainStore, keychainRetrieveStatus } from './keychain.js'
import { logger } from '../logger.js'

const VAULT_PATH = join(PROJECT_ROOT, 'store', 'vault.json')
const VAULT_KEY_PATH = join(PROJECT_ROOT, 'store', '.vault-key')
const VAULT_KEY_MIGRATED = join(PROJECT_ROOT, 'store', '.vault-key.migrated')
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32

interface VaultEntry {
  id: string
  label: string
  encrypted: string  // base64(salt + iv + tag + ciphertext)
  createdAt: string
  updatedAt: string
}

interface VaultStore {
  entries: VaultEntry[]
}

// Thrown when the master key cannot be established SAFELY. Callers surface it
// as a loud error -- generating a replacement key here would silently orphan
// every existing secret (VAULTUJKULCS822: 49 secrets nearly lost 2026-08-22).
export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultKeyError'
  }
}

// Strict loader for KEY DECISIONS: a missing vault.json is a legitimate
// first run (empty), but an EXISTING-yet-unreadable one must never be treated
// as empty -- that would re-open the silent-new-key class through a corrupted
// or permission-broken file (PR #1048 review finding).
function loadVaultEntriesForKeyCheck(): VaultEntry[] {
  if (!existsSync(VAULT_PATH)) return []
  try {
    const store = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'))
    if (!Array.isArray(store?.entries)) throw new Error('entries is not an array')
    return store.entries
  } catch (err: any) {
    throw new VaultKeyError(
      'store/vault.json exists but cannot be read or parsed -- refusing master-key decisions ' +
      `on a possibly corrupted vault (${err.message}). Repair or restore vault.json first.`
    )
  }
}

function vaultEntryCount(): number {
  return loadVaultEntriesForKeyCheck().length
}

// True iff the candidate master key decrypts the vault (trial-decrypts the
// first entry; an empty vault is opened by any key by definition).
function keyOpensVault(master: Buffer): boolean {
  const entries = loadVaultEntriesForKeyCheck()
  if (!entries.length) return true
  try {
    decryptWithKey(master, entries[0].encrypted)
    return true
  } catch {
    return false
  }
}

function getMasterKey(): Buffer {
  const entryCount = vaultEntryCount()

  if (isKeychainAvailable()) {
    if (existsSync(VAULT_KEY_PATH)) {
      const fileKey = readFileSync(VAULT_KEY_PATH, 'utf-8').trim()
      const fileKeyBuf = Buffer.from(fileKey, 'base64')
      // A wrong .vault-key (e.g. one produced by the old silent-generate path)
      // must never reach the Keychain and must never clobber .vault-key.migrated
      // -- in the 2026-08-22 incident .migrated held the ONLY good copy of the
      // real key, and this rename was one step from destroying it.
      if (!keyOpensVault(fileKeyBuf)) {
        throw new VaultKeyError(
          'store/.vault-key does not decrypt vault.json -- refusing to use or migrate it. ' +
          'Restore the correct master key (check store/.vault-key.migrated and backups).'
        )
      }
      try {
        keychainStore(fileKey)
        renameSync(VAULT_KEY_PATH, VAULT_KEY_MIGRATED)
        logger.info('Vault master key migrated from file to macOS Keychain (verified against vault.json first)')
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Keychain migration failed, keeping file-based key')
      }
      return fileKeyBuf
    }

    const read = keychainRetrieveStatus()
    if (read.status === 'ok') return Buffer.from(read.value as string, 'base64')

    if (read.status === 'unavailable') {
      // Locked keychain / timeout / auth failure: the key may well EXIST, we
      // just cannot read it. Generating a replacement here is exactly the bug
      // that nearly destroyed 49 secrets -- fail closed instead.
      throw new VaultKeyError(
        'macOS Keychain did not answer (locked keychain?) -- refusing to continue. ' +
        'Unlock the login keychain and retry. No new master key was generated.'
      )
    }

    // status === 'empty': the keychain ANSWERED and there is no item.
    if (entryCount > 0) {
      throw new VaultKeyError(
        `vault.json holds ${entryCount} entr(y/ies) but no master key exists in the Keychain or key file -- ` +
        'refusing to generate a new key (it would silently orphan every secret). Restore the key from backup.'
      )
    }

    const newKey = randomBytes(64).toString('base64')
    try {
      keychainStore(newKey)
      logger.info('New vault master key stored in macOS Keychain')
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Keychain store failed, falling back to file')
      atomicWriteFileSync(VAULT_KEY_PATH, newKey, { mode: 0o600 })
    }
    return Buffer.from(newKey, 'base64')
  }

  if (!existsSync(VAULT_KEY_PATH)) {
    if (entryCount > 0) {
      throw new VaultKeyError(
        `vault.json holds ${entryCount} entr(y/ies) but store/.vault-key is missing -- ` +
        'refusing to generate a new key. Restore the key file from backup.'
      )
    }
    const key = randomBytes(64).toString('base64')
    atomicWriteFileSync(VAULT_KEY_PATH, key, { mode: 0o600 })
  }
  return Buffer.from(readFileSync(VAULT_KEY_PATH, 'utf-8').trim(), 'base64')
}

function deriveKey(master: Buffer, salt: Buffer): Buffer {
  return scryptSync(master, salt, KEY_LENGTH)
}

function encrypt(plaintext: string): string {
  const master = getMasterKey()
  const salt = randomBytes(SALT_LENGTH)
  const key = deriveKey(master, salt)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64')
}

function decryptWithKey(master: Buffer, packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  const salt = buf.subarray(0, SALT_LENGTH)
  const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const key = deriveKey(master, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

function decrypt(packed: string): string {
  return decryptWithKey(getMasterKey(), packed)
}

function readVault(): VaultStore {
  try { return JSON.parse(readFileSync(VAULT_PATH, 'utf-8')) }
  catch { return { entries: [] } }
}

function writeVault(store: VaultStore): void {
  atomicWriteFileSync(VAULT_PATH, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

export function listSecrets(): Array<{ id: string, label: string, createdAt: string, updatedAt: string }> {
  return readVault().entries.map(({ id, label, createdAt, updatedAt }) => ({ id, label, createdAt, updatedAt }))
}

export function setSecret(id: string, label: string, value: string): void {
  const store = readVault()
  const now = new Date().toISOString()
  const idx = store.entries.findIndex(e => e.id === id)
  const entry: VaultEntry = { id, label, encrypted: encrypt(value), createdAt: now, updatedAt: now }
  if (idx >= 0) {
    entry.createdAt = store.entries[idx].createdAt
    store.entries[idx] = entry
  } else {
    store.entries.push(entry)
  }
  writeVault(store)
}

export function getSecret(id: string): string | null {
  const store = readVault()
  const entry = store.entries.find(e => e.id === id)
  if (!entry) return null
  return decrypt(entry.encrypted)
}

export function deleteSecret(id: string): boolean {
  const store = readVault()
  const before = store.entries.length
  store.entries = store.entries.filter(e => e.id !== id)
  if (store.entries.length === before) return false
  writeVault(store)
  return true
}

export function getSecretsForEnv(envMap: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, vaultId] of Object.entries(envMap)) {
    const value = getSecret(vaultId)
    if (value !== null) result[key] = value
  }
  return result
}
