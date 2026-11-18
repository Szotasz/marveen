import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isKeychainAvailable, keychainStore, keychainRetrieveStatus } from './keychain.js'
import { logger } from '../logger.js'
import { isReservedVaultId } from './vault-reserved.js'

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

// Read-only master-key resolution for the fleet EXPORT. Unlike getMasterKey()
// it never migrates, renames, writes or generates anything: it returns the
// base64 key from the first source that actually opens vault.json, or null
// when no source holds a key AND the vault is empty (nothing to carry over).
//
// The sources are tried by content, not inferred from a filename: after a
// Keychain migration getMasterKey() renames .vault-key to .vault-key.migrated,
// and that file is still a valid copy of the live key (it is what carries the
// key to a new machine). A vault that holds secrets which no available key
// opens is a loud VaultKeyError, never a silent export without the key.
export function resolveMasterKeyForExport(): string | null {
  const entryCount = vaultEntryCount()
  const candidates: string[] = []
  let keychainUnavailable = false
  for (const path of [VAULT_KEY_PATH, VAULT_KEY_MIGRATED]) {
    if (existsSync(path)) candidates.push(readFileSync(path, 'utf-8').trim())
  }
  if (isKeychainAvailable()) {
    const read = keychainRetrieveStatus()
    if (read.status === 'ok' && read.value) candidates.push(read.value)
    else if (read.status === 'unavailable') keychainUnavailable = true
  }
  for (const key of candidates) {
    if (key && keyOpensVault(Buffer.from(key, 'base64'))) return key
  }
  if (entryCount === 0) return null
  throw new VaultKeyError(
    `vault.json holds ${entryCount} entr(y/ies) but no available master key opens it ` +
    `(tried store/.vault-key, store/.vault-key.migrated${isKeychainAvailable() ? ', macOS Keychain' : ''}` +
    `${keychainUnavailable ? ' -- the Keychain did not answer, unlock it and retry' : ''}). ` +
    'The export would drop every secret, so it is refused.'
  )
}

let noMigrationNoticeLogged = false

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
      // A read-only consumer must not touch the Keychain. The scripts Claude Code runs for the headersHelper and for
      // secret resolution print to STDOUT (JSON / ENV=value lines) and often run without a GUI session (a
      // LaunchDaemon), where `security` runs into its timeout on EVERY call and the failure line would corrupt that
      // stdout. They set this switch and use the file key as is; the migration belongs to the dashboard process.
      // The key check above has already run, so a wrong key still fails closed.
      if (process.env.MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION === '1') {
        // Once per process, at WARN: if this variable ever reaches the DASHBOARD process by mistake, the migration would
        // silently never happen -- a stricter operator LOG_LEVEL (warn) must not hide that. It names the variable, never a key value.
        if (!noMigrationNoticeLogged) {
          noMigrationNoticeLogged = true
          logger.warn('MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION=1: the Keychain migration of the vault master key is skipped in this process')
        }
        return fileKeyBuf
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
  return encryptWithKey(getMasterKey(), plaintext)
}

function encryptWithKey(master: Buffer, plaintext: string): string {
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

// GMAILDRAFT1116 review B1: a reserved entry (vault-reserved.ts) is not listed, not read, not written, not relabelled
// and not deleted by the generic functions below. Its owner module uses reservedVaultAccess instead.
export function listSecrets(): Array<{ id: string, label: string, createdAt: string, updatedAt: string }> {
  return readVault().entries
    .filter(e => !isReservedVaultId(e.id))
    .map(({ id, label, createdAt, updatedAt }) => ({ id, label, createdAt, updatedAt }))
}

export function setSecret(id: string, label: string, value: string): void {
  if (isReservedVaultId(id)) throw new Error(`vault: "${id}" is a reserved entry; it is not written through the generic vault`)
  writeEntry(id, label, value)
}

function writeEntry(id: string, label: string, value: string): void {
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

// The rule for a secret's description: an empty one falls back to the id, and a NEW or CHANGED
// label is at most this many characters (after trimming). POST and PATCH /api/vault both
// enforce it, but POST lets an unchanged stored label through, because other writers (import,
// generated labels) and older data can already be longer and the edit form re-sends the label
// when it rotates a value.
export const VAULT_LABEL_MAX_LENGTH = 200

export function normalizeVaultLabel(id: string, label: string): string {
  return label.trim() || id
}

// Changes only the label (and updatedAt). The ciphertext is carried over byte
// for byte: nothing is decrypted or re-encrypted, so the master key is not even
// touched. Returns false when the id does not exist.
export function updateSecretLabel(id: string, label: string): boolean {
  if (isReservedVaultId(id)) return false
  const store = readVault()
  const entry = store.entries.find(e => e.id === id)
  if (!entry) return false
  entry.label = label
  entry.updatedAt = new Date().toISOString()
  writeVault(store)
  return true
}

export function getSecret(id: string): string | null {
  if (isReservedVaultId(id)) {
    // Not decrypted at all. A caller reaching here with a reserved id is a custom provider, a plan, a binding or a
    // resolver script naming it: that is the path review B1 closed, so it leaves a trace and gets "not there".
    logger.warn({ event: 'vault-reserved-refused', id, via: 'getSecret' }, 'vault: a reserved entry was asked for through the generic reader')
    return null
  }
  return readEntry(id)
}

function readEntry(id: string): string | null {
  const store = readVault()
  const entry = store.entries.find(e => e.id === id)
  if (!entry) return null
  return decrypt(entry.encrypted)
}

export function deleteSecret(id: string): boolean {
  if (isReservedVaultId(id)) return false
  return deleteEntry(id)
}

function deleteEntry(id: string): boolean {
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

// GMAILDRAFT1116 review B1: the ONLY way to a reserved entry, for the module that owns it, in the dashboard process.
// Every function refuses a non-reserved id, so this is not a second generic reader. A source-scan test
// (vault-reserved-entries.test.ts) pins which files import this name; adding a reader means editing that pin in a
// reviewed commit. Not an OS boundary: see vault-reserved.ts.
export const reservedVaultAccess = Object.freeze({
  read(id: string): string | null {
    if (!isReservedVaultId(id)) throw new Error('reservedVaultAccess: not a reserved id')
    return readEntry(id)
  },
  present(id: string): boolean {
    if (!isReservedVaultId(id)) throw new Error('reservedVaultAccess: not a reserved id')
    return readVault().entries.some(e => e.id === id)
  },
  write(id: string, label: string, value: string): void {
    if (!isReservedVaultId(id)) throw new Error('reservedVaultAccess: not a reserved id')
    writeEntry(id, label, value)
  },
  remove(id: string): boolean {
    if (!isReservedVaultId(id)) throw new Error('reservedVaultAccess: not a reserved id')
    return deleteEntry(id)
  },
})

// GMAILDRAFT1116 review round 2 (E1): a fleet import replaces vault.json AND the master key with the bundle's. This
// machine's reserved entries are never in a bundle (exportVault skips them), so to keep them the import carries them
// over: each one is decrypted here with the CURRENT master key and re-encrypted with the bundle's key, in this module,
// and only the ciphertext leaves it. `dropped` names the ids that could not be carried (the current key did not open
// them, or no current key is readable); the caller logs them, and the owner sets that credential again.
export function reservedEntriesReencryptedFor(newMasterKeyB64: string): { entries: Array<Record<string, unknown>>; dropped: string[] } {
  const reserved = readVault().entries.filter(e => isReservedVaultId(e.id))
  if (!reserved.length) return { entries: [], dropped: [] }
  const newMaster = Buffer.from(String(newMasterKeyB64 ?? '').trim(), 'base64')
  if (!newMaster.length) return { entries: [], dropped: reserved.map(e => e.id) }
  let current: Buffer
  try { current = getMasterKey() } catch { return { entries: [], dropped: reserved.map(e => e.id) } }
  const entries: Array<Record<string, unknown>> = []
  const dropped: string[] = []
  for (const e of reserved) {
    try {
      const plain = decryptWithKey(current, e.encrypted)
      entries.push({ ...e, encrypted: encryptWithKey(newMaster, plain) })
    } catch {
      dropped.push(e.id)
    }
  }
  return { entries, dropped }
}
