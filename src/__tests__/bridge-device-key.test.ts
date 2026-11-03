import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

// BRIDGEINSTKEY1020: the remote installer pairs its Bridge on the server
// (remote-enroll) and backfills the bundle credential later over SSH. Both
// paths handed out the SHARED dashboard token, so an installer-paired device
// was missing from the device-key list and could not be revoked from the
// dashboard. Contract under test:
//   - `remote-enroll --device-key` puts THIS device's own key into the bundle,
//     never the shared token, bound to the key line's install id;
//   - `bridge-device-key --install-id` issues the same key, only for a device
//     whose authorized_keys line exists;
//   - both go through mintBridgeDeviceKey, the dashboard pairing's own mint:
//     replace-by-id, listed, revocable;
//   - the default (no flag) keeps the shared-token behavior byte for byte.
//
// The CLIs open the install's real store/claudeclaw.db, so the device-key
// paths are driven in-process against ':memory:' (their openDb seam); only
// argv refusals that exit BEFORE any database or ~/.ssh access run as a
// subprocess.

import { initDatabase } from '../db.js'
import {
  chooseBundleToken,
  checkDeviceKeyRequest,
  defaultDeviceName,
  withCredential,
  DEVICE_KEY_BEGIN,
  DEVICE_KEY_END,
} from '../bridge-device-key.js'
import {
  mintBridgeDeviceKey,
  findDeviceKeyByInstallId,
  listDeviceKeys,
  resolveDeviceKey,
  revokeDeviceKey,
  _clearDeviceKeyCacheForTest,
} from '../web/auth-device-keys.js'
import { buildRestrictedLine, decodeBundle, validatePublicKeyLine } from '../remote-enroll-core.js'
import type { BundleTokenChoice, BundleTokenMode } from '../bridge-device-key.js'

// The CLIs live in scripts/, outside tsconfig's rootDir, so they are loaded
// dynamically (a static import would pull them into `npm run build`), the same
// way enroll-port-follows-web-port.test.ts reaches remote-access-enroll.ts.
interface EnrollCli {
  parseArgs: (argv: string[]) => { tokenMode: BundleTokenMode; name?: string; keyLine?: string }
  runEnroll: (
    args: ReturnType<EnrollCli['parseArgs']>,
    deps: { sshDir: string; obtainHostKey: () => { body: string; source: string } | null; openDb?: () => void },
  ) => Promise<{ ok: true; encoded: string } | { ok: false; reason: string }>
  bundleCredential: (
    args: { tokenMode: BundleTokenMode; name?: string },
    installId: string,
    action: string,
    openDb?: () => void,
  ) => BundleTokenChoice
}
type IssueResult =
  | { ok: true; installId: string; name: string; key: string; replaced: boolean }
  | { ok: false; reason: string }
interface IssueCli {
  parseArgs: (argv: string[]) => { installId?: string; name?: string }
  issueDeviceKey: (args: { installId?: string; name?: string }, authorizedKeys: string | null, openDb?: () => void) => IssueResult
}

const ROOT = join(__dirname, '..', '..')
let parseEnrollArgs: EnrollCli['parseArgs']
let bundleCredential: EnrollCli['bundleCredential']
let runEnroll: EnrollCli['runEnroll']
let parseIssueArgs: IssueCli['parseArgs']
let issueDeviceKey: IssueCli['issueDeviceKey']
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const SHARED = 's'.repeat(64)
const noDb = () => {}

function keyLine(installId: string = randomUUID()): { line: string; installId: string } {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, 32]), randomBytes(32),
  ])
  return { line: `ssh-ed25519 ${blob.toString('base64')} marveen-remote:${installId}`, installId }
}

function enrolledAuthorizedKeys(installId: string): string {
  const other = keyLine()
  return [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorOwnKeyxxxxxxxxxxxxxxxxxxxxxxxxxx operator@laptop',
    buildRestrictedLine(validatePublicKeyLine(keyLine(installId).line)),
    buildRestrictedLine(validatePublicKeyLine(other.line)),
    '',
  ].join('\n')
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const enroll = (await import(join(ROOT, 'scripts', 'remote-access-enroll.ts'))) as EnrollCli
  const issue = (await import(join(ROOT, 'scripts', 'bridge-device-key.ts'))) as IssueCli
  parseEnrollArgs = enroll.parseArgs
  bundleCredential = enroll.bundleCredential
  runEnroll = enroll.runEnroll
  parseIssueArgs = issue.parseArgs
  issueDeviceKey = issue.issueDeviceKey
})

let savedToken: string | undefined
beforeEach(() => {
  savedToken = process.env.DASHBOARD_TOKEN
  process.env.DASHBOARD_TOKEN = SHARED
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.DASHBOARD_TOKEN
  else process.env.DASHBOARD_TOKEN = savedToken
})

describe('remote-enroll --device-key: the bundle carries the device key, not the shared token', () => {
  it('argv maps to the token mode; the default stays the shared token', () => {
    const { line } = keyLine()
    expect(parseEnrollArgs([line]).tokenMode).toBe('shared')
    expect(parseEnrollArgs(['--no-dashboard-token', line]).tokenMode).toBe('none')
    expect(parseEnrollArgs(['--device-key', line]).tokenMode).toBe('device')
    expect(parseEnrollArgs(['--device-key', '--name', 'Nova MacBook', line])).toMatchObject({ tokenMode: 'device', name: 'Nova MacBook' })
  })

  it('mints a listed, revocable key bound to the install id, and never hands out the shared token', () => {
    const { installId } = keyLine()
    const choice = bundleCredential({ tokenMode: 'device', name: 'Nova MacBook' }, installId, 'added', noDb)
    expect(choice.ok && choice.source).toBe('device')
    if (!choice.ok || choice.source !== 'device') throw new Error('unreachable')
    expect(choice.token).not.toBe(SHARED)
    expect(choice.replaced).toBe(false)

    const row = findDeviceKeyByInstallId(installId)
    expect(row).toMatchObject({ id: choice.deviceKeyId, name: 'Nova MacBook', installId })
    expect(listDeviceKeys().some((k) => k.installId === installId)).toBe(true)

    // It authenticates as that device after a process restart (DB rehydrate)...
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(choice.token)).toMatchObject({ id: choice.deviceKeyId })
    // ...and the dashboard's revoke kills it.
    expect(revokeDeviceKey(choice.deviceKeyId)).toBe(true)
    expect(resolveDeviceKey(choice.token)).toBeNull()
  })

  it('re-enrolling the same device replaces its key instead of adding a second one', () => {
    const { installId } = keyLine()
    const first = bundleCredential({ tokenMode: 'device' }, installId, 'added', noDb)
    const second = bundleCredential({ tokenMode: 'device' }, installId, 'replaced', noDb)
    if (!first.ok || first.source !== 'device' || !second.ok || second.source !== 'device') throw new Error('expected device keys')
    expect(second.replaced).toBe(true)
    expect(resolveDeviceKey(first.token)).toBeNull()
    expect(resolveDeviceKey(second.token)).not.toBeNull()
    expect(listDeviceKeys().filter((k) => k.installId === installId)).toHaveLength(1)
    expect(findDeviceKeyByInstallId(installId)?.name).toBe(defaultDeviceName(installId))
  })

  it('the device mode never even reads the shared token', () => {
    const readSharedToken = vi.fn(() => SHARED)
    const { installId } = keyLine()
    const choice = chooseBundleToken('device', {
      readSharedToken,
      mintDeviceKey: () => mintBridgeDeviceKey('probe', installId),
    })
    expect(readSharedToken).not.toHaveBeenCalled()
    expect(choice.ok && choice.source).toBe('device')
  })

  it('without the flag the shared-token behavior is unchanged (and nothing is minted)', () => {
    const { installId } = keyLine()
    expect(bundleCredential({ tokenMode: 'shared' }, installId, 'added', noDb)).toEqual({ ok: true, source: 'shared', token: SHARED })
    expect(bundleCredential({ tokenMode: 'none' }, installId, 'added', noDb)).toEqual({ ok: true, source: 'none' })
    delete process.env.DASHBOARD_TOKEN
    const missing = chooseBundleToken('shared', { readSharedToken: () => null, mintDeviceKey: () => { throw new Error('must not mint') } })
    expect(missing.ok).toBe(false)
    expect(findDeviceKeyByInstallId(installId)).toBeNull()
  })

  it('refuses contradictory flags before touching ~/.ssh or the database', () => {
    const { line } = keyLine()
    for (const [argv, msg] of [
      [['--device-key', '--no-dashboard-token', line], 'mutually exclusive'],
      [['--name', 'X', line], '--name only applies with --device-key'],
      [['--device-key', '--name', 'bad/name', line], '--name must be'],
    ] as const) {
      let stderr = ''
      let status = 0
      try {
        execFileSync(TSX, [join(ROOT, 'scripts', 'remote-access-enroll.ts'), ...argv], { encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' })
      } catch (err) {
        const e = err as { status: number; stderr: string }
        status = e.status
        stderr = e.stderr
      }
      expect(status).toBe(1)
      expect(stderr).toContain(msg)
    }
  })
})

const HOST_KEY_B64 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519', 'utf8'),
  Buffer.from([0, 0, 0, 32]), randomBytes(32),
]).toString('base64')

describe('remote-enroll end to end: the bundle that leaves the CLI carries the right credential', () => {
  // Dani's review mutant on #2083: `readDashboardToken() ?? choice.token` at the
  // step that writes the choice into the bundle stayed green while the real CLI
  // shipped the SHARED token with --device-key. runEnroll is that real chain
  // (authorized_keys write, host key, choice, bundle); only argv and stdout stay
  // in main(). DASHBOARD_TOKEN is set (beforeEach), so any shared-token leak
  // into a --device-key bundle is visible here.
  let sshDir: string
  beforeEach(() => { sshDir = mkdtempSync(join(tmpdir(), 'bik-enroll-ssh-')) })
  afterEach(() => { rmSync(sshDir, { recursive: true, force: true }) })
  const deps = () => ({ sshDir, obtainHostKey: () => ({ body: HOST_KEY_B64, source: 'test' }), openDb: noDb })

  it('--device-key: the decoded bundle holds the minted device key, never the shared token', async () => {
    const { line, installId } = keyLine()
    const out = await runEnroll(parseEnrollArgs(['--device-key', '--name', 'Nova MacBook', line]), deps())
    if (!out.ok) throw new Error(out.reason)
    const token = decodeBundle(out.encoded).dashboardToken
    expect(token).toBeDefined()
    expect(token).not.toBe(SHARED)
    const row = findDeviceKeyByInstallId(installId)
    expect(row).toMatchObject({ name: 'Nova MacBook', installId })
    expect(resolveDeviceKey(token!)).toMatchObject({ id: row!.id })
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'utf8')).toContain(`marveen-remote:${installId}`)
  })

  it('without the flag the bundle still carries the shared token, and nothing is minted', async () => {
    const { line, installId } = keyLine()
    const out = await runEnroll(parseEnrollArgs([line]), deps())
    if (!out.ok) throw new Error(out.reason)
    expect(decodeBundle(out.encoded).dashboardToken).toBe(SHARED)
    expect(findDeviceKeyByInstallId(installId)).toBeNull()
  })

  it('--no-dashboard-token: no credential in the bundle', async () => {
    const { line } = keyLine()
    const out = await runEnroll(parseEnrollArgs(['--no-dashboard-token', line]), deps())
    if (!out.ok) throw new Error(out.reason)
    expect(decodeBundle(out.encoded).dashboardToken).toBeUndefined()
  })

  it('withCredential writes exactly the chosen token and drops any stale one', () => {
    const base = { host: 'h', dashboardToken: SHARED }
    expect(withCredential(base, { ok: true, source: 'device', token: 'mvk_x', deviceKeyId: 1, replaced: false }).dashboardToken).toBe('mvk_x')
    expect(withCredential(base, { ok: true, source: 'shared', token: 'tok' }).dashboardToken).toBe('tok')
    expect('dashboardToken' in withCredential(base, { ok: true, source: 'none' })).toBe(false)
  })
})

describe('bridge-device-key: the installer backfill issues the device key, not the shared token', () => {
  it('issues a key only for an enrolled device, through the shared mint', () => {
    const { installId } = keyLine()
    const issued = issueDeviceKey({ installId, name: 'Nova MacBook' }, enrolledAuthorizedKeys(installId), noDb)
    if (!issued.ok) throw new Error(issued.reason)
    expect(issued.key).not.toBe(SHARED)
    expect(findDeviceKeyByInstallId(installId)).toMatchObject({ name: 'Nova MacBook', installId })
    expect(resolveDeviceKey(issued.key)).not.toBeNull()

    const again = issueDeviceKey({ installId }, enrolledAuthorizedKeys(installId), noDb)
    if (!again.ok) throw new Error(again.reason)
    expect(again.replaced).toBe(true)
    expect(resolveDeviceKey(issued.key)).toBeNull()
  })

  it('refuses an unknown or malformed install id and a bad name, and never opens the database then', () => {
    const { installId } = keyLine()
    const openDb = vi.fn()
    expect(issueDeviceKey({ installId }, enrolledAuthorizedKeys(randomUUID()), openDb)).toMatchObject({ ok: false })
    expect(issueDeviceKey({ installId }, null, openDb)).toMatchObject({ ok: false })
    expect(issueDeviceKey({ installId: 'not-a-uuid' }, enrolledAuthorizedKeys(installId), openDb)).toMatchObject({ ok: false })
    expect(issueDeviceKey({ installId, name: 'x'.repeat(65) }, enrolledAuthorizedKeys(installId), openDb)).toMatchObject({ ok: false })
    expect(openDb).not.toHaveBeenCalled()
    expect(findDeviceKeyByInstallId(installId)).toBeNull()
  })

  it('an id that appears only inside ANOTHER line does not count as enrolled', () => {
    const { installId } = keyLine()
    const lookalike = `ssh-ed25519 AAAA operator note marveen-remote:${installId}-old\n`
    expect(checkDeviceKeyRequest(installId, undefined, lookalike).ok).toBe(false)
  })

  it('parses its argv', () => {
    const id = randomUUID()
    expect(parseIssueArgs(['--install-id', id, '--name', 'Nova'])).toEqual({ installId: id, name: 'Nova' })
  })

  it('a refused request exits 1 with no key on stdout (subprocess, sandboxed ~/.ssh)', () => {
    const sshDir = mkdtempSync(join(tmpdir(), 'bik-ssh-'))
    try {
      writeFileSync(join(sshDir, 'authorized_keys'), enrolledAuthorizedKeys(randomUUID()), { mode: 0o600 })
      let out = ''
      let status = 0
      let stderr = ''
      try {
        out = execFileSync(TSX, [join(ROOT, 'scripts', 'bridge-device-key.ts'), '--install-id', randomUUID()], {
          encoding: 'utf-8', timeout: 30_000, stdio: 'pipe', env: { ...process.env, MARVEEN_SSH_DIR: sshDir },
        })
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string }
        status = e.status
        out = e.stdout
        stderr = e.stderr
      }
      expect(status).toBe(1)
      expect(stderr).toContain('no enrolled Bridge device')
      expect(out).not.toContain(DEVICE_KEY_BEGIN)
      expect(out).not.toContain(DEVICE_KEY_END)
    } finally {
      rmSync(sshDir, { recursive: true, force: true })
    }
  })
})
