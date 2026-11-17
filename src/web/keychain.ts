import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { isTestRun } from '../test-run-marker.js'

const SECURITY = '/usr/bin/security'
// The LIVE install's Keychain item. Never change this default: every existing
// install keeps its vault master key under exactly this service/account pair,
// and a different name would read as "no key" (the vault then fails closed).
export const DEFAULT_KEYCHAIN_SERVICE = 'com.marveen.vault'
const ACCOUNT = 'master-key'

// Optional override of the service name (card 31a6e54d). Unset in production,
// so the live item above is used unchanged. A test that genuinely wants a
// Keychain item must name its OWN item through this variable.
export const KEYCHAIN_SERVICE_ENV = 'MARVEEN_KEYCHAIN_SERVICE'
// Marks a non-vitest test process (shell suites that spawn node on dist/):
// vitest workers are recognised by isTestRun() already, but a shell test may
// legitimately run a step with NODE_ENV=production and still be a test.
export const KEYCHAIN_TEST_GUARD_ENV = 'MARVEEN_KEYCHAIN_TEST_GUARD'

// A locked keychain makes `security` pop a GUI unlock prompt and block
// indefinitely; without a timeout that freezes the whole dashboard (measured
// 2026-08-22: 48-minute HTTP outage from exactly this, VAULTKEY822). The
// timeout turns a hung call into a loud 'unavailable' instead.
const SECURITY_TIMEOUT_MS = 5000

// errSecItemNotFound: the keychain ANSWERED and the item does not exist.
// Everything else (timeout, locked keychain, auth failure) means the keychain
// did not answer -- callers must treat that as unavailable, never as "no key".
const EXIT_ITEM_NOT_FOUND = 44

// Thrown BEFORE any `security` process is spawned when a test process tries to
// reach the live item. Never swallowed by the read/delete helpers below: a
// test that hits it must go red, not quietly read as "keychain unavailable".
export class KeychainTestGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeychainTestGuardError'
  }
}

export function isKeychainTestRuntime(): boolean {
  return isTestRun() || process.env[KEYCHAIN_TEST_GUARD_ENV] === '1'
}

export function keychainService(): string {
  const raw = process.env[KEYCHAIN_SERVICE_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_KEYCHAIN_SERVICE
  const name = raw.trim()
  // The name goes into an argv slot (no shell), but a stray value must still
  // not silently address some other item: refuse anything unusual, loudly.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new KeychainTestGuardError(`${KEYCHAIN_SERVICE_ENV} holds an invalid service name -- refusing to use the Keychain`)
  }
  return name
}

// Keychain service-name matching case-sensitivity is unmeasured, so in a test
// process any spelling of the live name (COM.MARVEEN.VAULT, ...) counts as the
// live item. Production compares nothing here: it always uses the name as given.
function isLiveService(service: string): boolean {
  return service.toLowerCase() === DEFAULT_KEYCHAIN_SERVICE
}

// The single choke point every `security` call goes through. In a test process
// the live item is off limits, whatever the test meant to do (card 31a6e54d: a
// full-suite run outside the sandbox could otherwise overwrite the live vault
// master key via `add-generic-password -U`).
function assertKeychainTargetAllowed(service: string): void {
  if (isKeychainTestRuntime() && isLiveService(service)) {
    throw new KeychainTestGuardError(
      `test process tried to reach the LIVE Keychain item (${DEFAULT_KEYCHAIN_SERVICE}) -- refused before spawning security. ` +
      `Mock ../web/keychain.js, or set ${KEYCHAIN_SERVICE_ENV} to a test-only name.`,
    )
  }
}

export function isKeychainAvailable(): boolean {
  // Platform gate only. Whether the keychain actually answers is decided by
  // keychainRetrieveStatus() at each decision point -- a platform check alone
  // said "available" on a locked keychain and enabled the silent key swap
  // (VAULTUJKULCS822).
  // A test process addressing the live name runs the file-key path instead,
  // exactly as on a non-darwin CI runner: the suite never touches the Keychain.
  if (platform() !== 'darwin') return false
  return !(isKeychainTestRuntime() && isLiveService(keychainService()))
}

export type KeychainReadStatus = 'ok' | 'empty' | 'unavailable'
export interface KeychainReadResult {
  status: KeychainReadStatus
  value: string | null
}

export function keychainRetrieveStatus(): KeychainReadResult {
  const service = keychainService()
  assertKeychainTargetAllowed(service)
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', service,
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
  const service = keychainService()
  assertKeychainTargetAllowed(service)
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', service,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
}

export function keychainDelete(): boolean {
  const service = keychainService()
  assertKeychainTargetAllowed(service)
  try {
    execFileSync(SECURITY, [
      'delete-generic-password',
      '-s', service,
      '-a', ACCOUNT,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: SECURITY_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
