import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Card 31a6e54d, round 2: scripts/__tests__/channels-custom-provider.test.sh
// copies the checkout's dist/ and runs node on dist/web/vault.js. Its build
// check only asks whether dist/ EXISTS, so a dist built before the keychain.ts
// test guard would be copied as is and its keychain.js would spawn
// /usr/bin/security against the live vault item. The suite now (a) refuses a
// copied keychain.js without the guard before any node step and (b) replaces
// the copy with a stub anyway.
//
// Pinned here on a FAKE install: the "stale" keychain.js is a file of ours that
// only touches a marker when it is loaded. Nothing in this file can reach the
// real Keychain -- there is no `security` anywhere in it.

const SUITE = join(process.cwd(), 'scripts', '__tests__', 'channels-custom-provider.test.sh')

let install: string
let keychainMarker: string
let helperMarker: string

// keychain.js stand-in: loading it at all is what a stale dist would turn into
// a `security` spawn. `withGuardWord` puts the guard identifier in a comment, so
// the suite's belt check passes and only the stub (braces) can stop it.
function fakeKeychain(withGuardWord: boolean): string {
  return [
    withGuardWord ? '// KeychainTestGuardError (identifier only: this fake has no guard)' : '// stale keychain.js',
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(keychainMarker)}, 'loaded')`,
    'export function isKeychainAvailable() { return true }',
    "export function keychainRetrieveStatus() { return { status: 'ok', value: 'live-key' } }",
    "export function keychainRetrieve() { return 'live-key' }",
    'export function keychainStore() {}',
    'export function keychainDelete() { return true }',
    '',
  ].join('\n')
}

function buildInstall(withGuardWord: boolean): void {
  mkdirSync(join(install, 'scripts', '__tests__'), { recursive: true })
  mkdirSync(join(install, 'dist', 'web'), { recursive: true })
  copyFileSync(SUITE, join(install, 'scripts', '__tests__', 'channels-custom-provider.test.sh'))
  writeFileSync(join(install, 'dist', 'web', 'agent-process.js'), 'export {}\n')
  writeFileSync(join(install, 'dist', 'web', 'keychain.js'), fakeKeychain(withGuardWord))
  writeFileSync(
    join(install, 'dist', 'web', 'vault.js'),
    [
      "import { isKeychainAvailable, keychainRetrieveStatus, keychainStore } from './keychain.js'",
      'export function getSecret() { isKeychainAvailable(); keychainRetrieveStatus(); return null }',
      "export function setSecret() { if (isKeychainAvailable()) keychainStore('k') }",
      '',
    ].join('\n'),
  )
  // Helper stand-in: proves node steps ran, and goes through vault.js -> keychain.js.
  writeFileSync(
    join(install, 'scripts', 'main-agent-custom-provider.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(helperMarker)}, 'ran')`,
      "const { getSecret } = await import(new URL('../dist/web/vault.js', import.meta.url))",
      "getSecret('X')",
      '',
    ].join('\n'),
  )
}

function runSuite() {
  return spawnSync('bash', [join(install, 'scripts', '__tests__', 'channels-custom-provider.test.sh')], {
    encoding: 'utf-8',
    timeout: 120_000,
    cwd: install,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: install, TMPDIR: install },
  })
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'ccp-keychain-stub-'))
  keychainMarker = join(install, 'keychain-loaded')
  helperMarker = join(install, 'helper-ran')
})

afterEach(() => rmSync(install, { recursive: true, force: true }))

describe('channels-custom-provider.test.sh never runs a stale keychain.js', () => {
  it('positive control: the fake keychain.js fires when the helper runs on the fake dist directly', () => {
    buildInstall(true)
    const res = spawnSync(process.execPath, [join(install, 'scripts', 'main-agent-custom-provider.mjs')], {
      encoding: 'utf-8',
      env: { PATH: '/usr/bin:/bin', HOME: install },
    })
    expect(res.status).toBe(0)
    expect(existsSync(keychainMarker)).toBe(true)
  })

  it('belt: a copied keychain.js without the guard is a hard failure before any node step', () => {
    buildInstall(false)
    const res = runSuite()
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('predates the keychain test guard')
    expect(existsSync(helperMarker)).toBe(false)
    expect(existsSync(keychainMarker)).toBe(false)
  })

  it('braces: even a keychain.js that passes the marker check is stubbed before node runs', () => {
    buildInstall(true)
    const res = runSuite()
    expect(res.stderr).not.toContain('predates the keychain test guard')
    expect(existsSync(helperMarker)).toBe(true)
    expect(existsSync(keychainMarker)).toBe(false)
  })
})
