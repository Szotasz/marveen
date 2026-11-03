// updateSecretLabel(): changes only label and updatedAt; the ciphertext is carried over untouched.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-update-label-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainStore: () => {},
  keychainRetrieveStatus: () => ({ status: 'empty', value: null }),
  keychainRetrieve: () => null,
  keychainDelete: () => true,
}))

const { setSecret, getSecret, listSecrets, updateSecretLabel } = await import('../web/vault.js')
const vaultFile = () => join(tmpRoot, 'store', 'vault.json')
const rawEntries = () => JSON.parse(readFileSync(vaultFile(), 'utf-8')).entries as Array<{ id: string; label: string; encrypted: string; createdAt: string; updatedAt: string }>

describe('updateSecretLabel', () => {
  it('changes the label, keeps the encrypted blob byte-identical and createdAt', async () => {
    setSecret('K1', 'old label', 'value-1')
    setSecret('K2', 'other', 'value-2')
    const before = rawEntries().find(e => e.id === 'K1')!
    await new Promise(r => setTimeout(r, 5))
    expect(updateSecretLabel('K1', 'new label')).toBe(true)
    const after = rawEntries().find(e => e.id === 'K1')!
    expect(after.label).toBe('new label')
    expect(after.encrypted).toBe(before.encrypted)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt).not.toBe(before.updatedAt)
    expect(getSecret('K1')).toBe('value-1')
    expect(listSecrets().find(s => s.id === 'K1')?.label).toBe('new label')
  })

  it('leaves other entries untouched', () => {
    expect(rawEntries().find(e => e.id === 'K2')?.label).toBe('other')
    expect(getSecret('K2')).toBe('value-2')
  })

  it('returns false for a missing id and writes nothing', () => {
    const snapshot = readFileSync(vaultFile(), 'utf-8')
    expect(updateSecretLabel('NOPE', 'x')).toBe(false)
    expect(readFileSync(vaultFile(), 'utf-8')).toBe(snapshot)
  })
})
