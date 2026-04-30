import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isKeychainAvailable, keychainStore, keychainRetrieve } from './keychain.js'
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

function getMasterKey(): Buffer {
  if (isKeychainAvailable()) {
    if (existsSync(VAULT_KEY_PATH)) {
      const fileKey = readFileSync(VAULT_KEY_PATH, 'utf-8').trim()
      try {
        keychainStore(fileKey)
        renameSync(VAULT_KEY_PATH, VAULT_KEY_MIGRATED)
        logger.info('Vault master key migrated from file to macOS Keychain')
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Keychain migration failed, keeping file-based key')
      }
      return Buffer.from(fileKey, 'base64')
    }

    const existing = keychainRetrieve()
    if (existing) return Buffer.from(existing, 'base64')

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

function decrypt(packed: string): string {
  const master = getMasterKey()
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
