import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Card 31a6e54d: no test may reach the LIVE vault Keychain item
// (com.marveen.vault / master-key). This file pins the in-module half of the
// fix in src/web/keychain.ts; keychain-spawn-guard.test.ts pins the global
// spawn guard. child_process is mocked here, so nothing in this file can
// spawn `security` -- and if the mock ever failed to apply, the global spawn
// guard (vitest setupFiles) would still refuse the call before it started.

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return {
    platform: 'darwin' as string,
    tmpRoot: mkdtempSync(join(tmpdir(), 'keychain-isolation-test-')),
  }
})

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'stored-key\n') }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => h.platform,
}))
vi.mock('../config.js', () => ({ PROJECT_ROOT: h.tmpRoot }))

const LIVE = 'com.marveen.vault'
const ENV_KEYS = ['VITEST', 'NODE_ENV', 'MARVEEN_KEYCHAIN_SERVICE', 'MARVEEN_KEYCHAIN_TEST_GUARD'] as const
let savedEnv: Record<string, string | undefined> = {}

const exec = vi.mocked(execFileSync)

afterAll(() => rmSync(h.tmpRoot, { recursive: true, force: true }))

async function freshKeychain() {
  vi.resetModules()
  return await import('../web/keychain.js')
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  delete process.env.MARVEEN_KEYCHAIN_SERVICE
  delete process.env.MARVEEN_KEYCHAIN_TEST_GUARD
  h.platform = 'darwin'
  exec.mockClear()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('keychain.ts: the live item is off limits in a test process', () => {
  it('the mock is in place (otherwise the rest of this file proves nothing)', () => {
    expect(vi.isMockFunction(execFileSync)).toBe(true)
  })

  it('vitest worker + default name -> keychain reported unavailable (file-key path, as on CI)', async () => {
    expect(process.env.VITEST).toBeDefined()
    const k = await freshKeychain()
    expect(k.keychainService()).toBe(LIVE)
    expect(k.isKeychainAvailable()).toBe(false)
  })

  it('store / read / delete with the live name throw KeychainTestGuardError and never spawn', async () => {
    const k = await freshKeychain()
    expect(() => k.keychainStore('would-overwrite-live-key')).toThrow(k.KeychainTestGuardError)
    expect(() => k.keychainRetrieveStatus()).toThrow(k.KeychainTestGuardError)
    expect(() => k.keychainRetrieve()).toThrow(k.KeychainTestGuardError)
    expect(() => k.keychainDelete()).toThrow(k.KeychainTestGuardError)
    expect(exec).not.toHaveBeenCalled()
  })

  it('MARVEEN_KEYCHAIN_TEST_GUARD=1 marks a non-vitest process (the shell suites), even with NODE_ENV=production', async () => {
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    process.env.MARVEEN_KEYCHAIN_TEST_GUARD = '1'
    const k = await freshKeychain()
    expect(k.isKeychainTestRuntime()).toBe(true)
    expect(k.isKeychainAvailable()).toBe(false)
    expect(() => k.keychainStore('x')).toThrow(k.KeychainTestGuardError)
    expect(exec).not.toHaveBeenCalled()
  })

  it('a test-only service name is used verbatim in the security argv', async () => {
    process.env.MARVEEN_KEYCHAIN_SERVICE = 'com.marveen.vault.test-31a6'
    const k = await freshKeychain()
    expect(k.isKeychainAvailable()).toBe(true)
    k.keychainStore('v')
    expect(exec).toHaveBeenCalledTimes(1)
    const [bin, argv] = exec.mock.calls[0] as [string, string[]]
    expect(bin).toBe('/usr/bin/security')
    expect(argv).toEqual(['add-generic-password', '-U', '-s', 'com.marveen.vault.test-31a6', '-a', 'master-key', '-w', 'v', '-A'])
    expect(argv).not.toContain(LIVE)
  })

  it('an invalid override is refused loudly, not silently mapped to some item', async () => {
    process.env.MARVEEN_KEYCHAIN_SERVICE = 'x; security delete-generic-password'
    const k = await freshKeychain()
    expect(() => k.keychainService()).toThrow(k.KeychainTestGuardError)
    expect(() => k.keychainStore('v')).toThrow(k.KeychainTestGuardError)
    expect(exec).not.toHaveBeenCalled()
  })

  it.each(['COM.MARVEEN.VAULT', 'Com.Marveen.Vault'])(
    'the live name in another case (%s) is refused too: Keychain case-sensitivity is not relied on',
    async (name) => {
      process.env.MARVEEN_KEYCHAIN_SERVICE = name
      const k = await freshKeychain()
      expect(k.keychainService()).toBe(name)
      expect(k.isKeychainAvailable()).toBe(false)
      expect(() => k.keychainStore('v')).toThrow(k.KeychainTestGuardError)
      expect(() => k.keychainRetrieveStatus()).toThrow(k.KeychainTestGuardError)
      expect(() => k.keychainDelete()).toThrow(k.KeychainTestGuardError)
      expect(exec).not.toHaveBeenCalled()
    },
  )

  it('a blank override falls back to the default name (and stays guarded)', async () => {
    process.env.MARVEEN_KEYCHAIN_SERVICE = '   '
    const k = await freshKeychain()
    expect(k.keychainService()).toBe(LIVE)
    expect(() => k.keychainStore('v')).toThrow(k.KeychainTestGuardError)
  })

  it('off darwin the keychain is unavailable regardless of the name', async () => {
    h.platform = 'linux'
    process.env.MARVEEN_KEYCHAIN_SERVICE = 'com.marveen.vault.test-31a6'
    const k = await freshKeychain()
    expect(k.isKeychainAvailable()).toBe(false)
  })
})

describe('keychain.ts: production behaviour is unchanged (mocked spawn)', () => {
  it('no test signal -> live service/account, update flag, same argv as before the fix', async () => {
    expect(vi.isMockFunction(execFileSync)).toBe(true)
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    const k = await freshKeychain()
    expect(k.isKeychainTestRuntime()).toBe(false)
    expect(k.isKeychainAvailable()).toBe(true)

    k.keychainStore('v')
    expect(exec.mock.calls[0][0]).toBe('/usr/bin/security')
    expect(exec.mock.calls[0][1]).toEqual(['add-generic-password', '-U', '-s', LIVE, '-a', 'master-key', '-w', 'v', '-A'])

    expect(k.keychainRetrieveStatus()).toEqual({ status: 'ok', value: 'stored-key' })
    expect(exec.mock.calls[1][1]).toEqual(['find-generic-password', '-s', LIVE, '-a', 'master-key', '-w'])

    expect(k.keychainDelete()).toBe(true)
    expect(exec.mock.calls[2][1]).toEqual(['delete-generic-password', '-s', LIVE, '-a', 'master-key'])
  })
})

describe('vault on a (mocked) Mac inside a test: never the Keychain', () => {
  const storeDir = join(h.tmpRoot, 'store')
  beforeEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
    mkdirSync(storeDir, { recursive: true })
  })
  afterEach(() => rmSync(storeDir, { recursive: true, force: true }))

  it('setSecret/getSecret run on the hermetic file key with the REAL keychain.ts', async () => {
    vi.resetModules()
    const vault = await import('../web/vault.js')
    vault.setSecret('probe', 'Probe', 'probe-value-31a6')
    expect(vault.getSecret('probe')).toBe('probe-value-31a6')
    expect(existsSync(join(storeDir, '.vault-key'))).toBe(true)
    expect(readFileSync(join(storeDir, '.vault-key'), 'utf-8').trim().length).toBeGreaterThan(0)
    expect(exec).not.toHaveBeenCalled()
  })
})
