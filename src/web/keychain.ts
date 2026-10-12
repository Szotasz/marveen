import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'

const SECURITY = '/usr/bin/security'
const SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

// A locked keychain makes `security` pop a GUI unlock prompt and block
// indefinitely; without a timeout that freezes the whole dashboard (measured
// 2026-08-22: 48-minute HTTP outage from exactly this, VAULTKEY822). The
// timeout turns a hung call into a loud 'unavailable' instead.
const SECURITY_TIMEOUT_MS = 5000

// errSecItemNotFound: the keychain ANSWERED and the item does not exist.
// Everything else (timeout, locked keychain, auth failure) means the keychain
// did not answer -- callers must treat that as unavailable, never as "no key".
const EXIT_ITEM_NOT_FOUND = 44

export function isKeychainAvailable(): boolean {
  // Platform gate only. Whether the keychain actually answers is decided by
  // keychainRetrieveStatus() at each decision point -- a platform check alone
  // said "available" on a locked keychain and enabled the silent key swap
  // (VAULTUJKULCS822).
  return platform() === 'darwin'
}

export type KeychainReadStatus = 'ok' | 'empty' | 'unavailable'
export interface KeychainReadResult {
  status: KeychainReadStatus
  value: string | null
}

export function keychainRetrieveStatus(): KeychainReadResult {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SECURITY_TIMEOUT_MS })
    const value = out.trim()
    return value ? { status: 'ok', value } : { status: 'empty', value: null }
  } catch (err: any) {
    if (err?.status === EXIT_ITEM_NOT_FOUND) return { status: 'empty', value: null }
    return { status: 'unavailable', value: null }
  }
}

export function keychainRetrieve(): string | null {
  return keychainRetrieveStatus().value
}

export function keychainStore(value: string): void {
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
}

export function keychainDelete(): boolean {
  try {
    execFileSync(SECURITY, [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
