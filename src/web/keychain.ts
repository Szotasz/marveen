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

// VAULTKEYLOG1118: the value travels in the argument list, and a failed execFileSync puts the whole command line in
// its error message ("Command failed: ... -w <value> ..."), which the caller logs. So the error that leaves this
// function is a NEW one that names only the outcome (exit status, signal, error code); the original is not kept as
// its cause, because a logged cause is printed too.
// VAULTKEYARGV1118: the value is not in the argument list at all. `security -i` reads the command from stdin, so a
// process listing taken while it runs shows only `security -i` (measured on macOS with a throwaway keychain: the
// running argv held no value, the stored value read back equal, and a failing command still exits non-zero). The
// interactive reader splits the line on whitespace, so only a value of base64 characters is passed; every caller
// stores a base64 key, and anything else is refused before a process starts.
const STORE_VALUE_SHAPE = /^[A-Za-z0-9+/=]+$/
export function keychainStore(value: string): void {
  if (!STORE_VALUE_SHAPE.test(value)) {
    throw new Error('keychainStore: the value is not base64; refused before calling security')
  }
  try {
    execFileSync(SECURITY, ['-i'], {
      input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${value} -A\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: SECURITY_TIMEOUT_MS,
    })
  } catch (err: any) {
    const status = typeof err?.status === 'number' ? err.status : 'none'
    const signal = typeof err?.signal === 'string' ? err.signal : 'none'
    const code = typeof err?.code === 'string' ? `, ${err.code}` : ''
    throw new Error(`security add-generic-password failed (exit status ${status}, signal ${signal}${code})`)
  }
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
