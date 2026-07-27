import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vault-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

// Disable keychain so vault falls back to file-based key (deterministic in CI)
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: vi.fn().mockReturnValue(false),
  keychainStore: vi.fn(),
  keychainRetrieve: vi.fn().mockReturnValue(null),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  MAIN_AGENT_ID: 'marveen',
}))

import { setSecret, getSecret, deleteSecret, listSecrets, getSecretsForEnv } from '../web/vault.js'

const VAULT_JSON = join(STORE_DIR, 'vault.json')
const VAULT_KEY = join(STORE_DIR, '.vault-key')

function cleanVault(): void {
  if (existsSync(VAULT_JSON)) unlinkSync(VAULT_JSON)
  if (existsSync(VAULT_KEY)) unlinkSync(VAULT_KEY)
}

beforeEach(cleanVault)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('setSecret / getSecret roundtrip', () => {
  it('stores and retrieves a secret', () => {
    setSecret('my-api-key', 'API Key', 'super-secret-value')
    const val = getSecret('my-api-key')
    expect(val).toBe('super-secret-value')
  })

  it('returns null for a nonexistent secret', () => {
    expect(getSecret('does-not-exist')).toBeNull()
  })

  it('overwrites an existing secret on second write', () => {
    setSecret('token', 'Token', 'v1')
    setSecret('token', 'Token', 'v2')
    expect(getSecret('token')).toBe('v2')
  })

  it('stores multiple independent secrets', () => {
    setSecret('a', 'A', 'aaa')
    setSecret('b', 'B', 'bbb')
    expect(getSecret('a')).toBe('aaa')
    expect(getSecret('b')).toBe('bbb')
  })

  it('preserves createdAt across updates', () => {
    setSecret('keep', 'Keep', 'original')
    const before = listSecrets().find(s => s.id === 'keep')!.createdAt
    setSecret('keep', 'Keep', 'updated')
    const after = listSecrets().find(s => s.id === 'keep')!.createdAt
    expect(after).toBe(before)
  })
})

describe('deleteSecret', () => {
  it('removes an existing secret', () => {
    setSecret('del-me', 'Del', 'gone')
    expect(deleteSecret('del-me')).toBe(true)
    expect(getSecret('del-me')).toBeNull()
  })

  it('returns false for nonexistent secret', () => {
    expect(deleteSecret('phantom')).toBe(false)
  })
})

describe('listSecrets', () => {
  it('returns empty array when vault is empty', () => {
    expect(listSecrets()).toEqual([])
  })

  it('lists stored secret metadata (no values)', () => {
    setSecret('s1', 'Secret 1', 'val1')
    setSecret('s2', 'Secret 2', 'val2')
    const list = listSecrets()
    expect(list).toHaveLength(2)
    const ids = list.map(s => s.id)
    expect(ids).toContain('s1')
    expect(ids).toContain('s2')
    expect(list.every(s => !('encrypted' in s))).toBe(true)
  })
})

describe('getSecretsForEnv', () => {
  it('resolves vault ids to env values', () => {
    setSecret('db-password', 'DB Pass', 'secret123')
    const env = getSecretsForEnv({ DB_PASS: 'db-password' })
    expect(env.DB_PASS).toBe('secret123')
  })

  it('skips missing vault ids', () => {
    const env = getSecretsForEnv({ MISSING: 'no-such-id' })
    expect(env.MISSING).toBeUndefined()
  })

  it('resolves multiple entries', () => {
    setSecret('key1', 'K1', 'v1')
    setSecret('key2', 'K2', 'v2')
    const env = getSecretsForEnv({ A: 'key1', B: 'key2', C: 'key-absent' })
    expect(env.A).toBe('v1')
    expect(env.B).toBe('v2')
    expect(env.C).toBeUndefined()
  })
})
