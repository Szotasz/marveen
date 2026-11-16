import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const notifyOwner = vi.fn(async (_text: string) => true)
vi.mock('../notify.js', () => ({
  notifyOwner: (text: string) => notifyOwner(text),
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
}))

import { getDb, initDatabase, insertSupportConsent, listSupportConsents } from '../db.js'
import { buildSupportLine } from '../support-access-line.js'
import { writeSupportToken, SUPPORT_TOKEN_FILE } from '../support-access-token.js'
import { hasSupportState, insertConsentFromRecord, takeSupportAccessDownWith } from '../web/support-standby-runtime.js'
import { TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const OWN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH owner@laptop'

describe('the security teardown of support access (terv-v7 3.9)', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  const deps = () => ({ supportDir, sshDir, pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM } })
  const line = () =>
    buildSupportLine({ key: TEST_ONLY_KEYS[0], grantId: GRANT, consentVersion: 1, dispatchPath: '/home/x/.marveen/support/kit/support-dispatch.sh', fromCidrs: TEST_ONLY_FROM, sshd: { major: 9, minor: 6 } })

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })
  beforeEach(() => {
    getDb().exec('DELETE FROM support_consents')
    notifyOwner.mockClear()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-teardown-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n', { mode: 0o600 })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('the reconcile\'s copied consent row carries the recorded version\'s text sha256, NULL without an approved text', () => {
    const keys = TEST_ONLY_KEYS.map((k) => ({ name: k.name, fingerprint: k.fingerprint }))
    insertConsentFromRecord({ grantId: GRANT, consentVersion: 2, consentAt: '2026-11-16T08:00:00Z', keys })
    insertConsentFromRecord({ grantId: '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b', consentVersion: 1, consentAt: '2026-11-15T08:00:00Z', keys })
    const rows = listSupportConsents().map((r) => [r.grant_id, r.consent_version, r.consent_lang, r.consent_sha256, r.created_via, r.actor])
    expect(rows).toEqual(expect.arrayContaining([
      [GRANT, 2, 'hu', '1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b', 'command', 'reconcile'],
      ['9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b', 1, 'hu', null, 'command', 'reconcile'],
    ]))
    expect(rows).toHaveLength(2)
  })

  it('a machine that never had support: nothing is touched, not even a lock under .ssh', async () => {
    expect(hasSupportState(deps())).toBe(false)
    expect(await takeSupportAccessDownWith(deps(), 'password_change')).toEqual({ ok: true, removedLines: 0 })
    expect(readdirSync(sshDir)).toEqual(['authorized_keys'])
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'latin1')).toBe(OWN_LINE + '\n')
  })

  it('a machine that never had support does not even wait for the keys-file lock another writer holds', async () => {
    writeFileSync(join(sshDir, 'authorized_keys.lock'), 'held by another writer\n')
    const started = Date.now()
    expect(await takeSupportAccessDownWith(deps(), 'password_change')).toEqual({ ok: true, removedLines: 0 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(readFileSync(join(sshDir, 'authorized_keys.lock'), 'utf8')).toBe('held by another writer\n')
  })

  it('a machine without even a .ssh folder: nothing is created there', async () => {
    rmSync(sshDir, { recursive: true })
    expect(await takeSupportAccessDownWith(deps(), 'password_change')).toEqual({ ok: true, removedLines: 0 })
    expect(existsSync(sshDir)).toBe(false)
  })

  it('takes the token and the lines away, and closes the open rows with the reason', async () => {
    mkdirSync(supportDir, { recursive: true, mode: 0o700 })
    writeSupportToken(supportDir, TOKEN)
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n' + line() + '\n')
    insertSupportConsent({ grantId: GRANT, consentVersion: 1, consentSha256: null, consentLang: null, consentAt: '2026-11-15T06:10:00Z', locale: 'hu', keyNames: ['key1'], createdVia: 'button', actor: 'session:alice' })
    expect(await takeSupportAccessDownWith(deps(), 'security_reset')).toEqual({ ok: true, removedLines: 1 })
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'latin1')).toBe(OWN_LINE + '\n')
    expect(listSupportConsents().map((r) => r.revoked_via)).toEqual(['security_reset'])
  })

  it('a support line without the folder is found too (read only) and taken away', async () => {
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n' + line() + '\n')
    expect(hasSupportState(deps())).toBe(true)
    expect(await takeSupportAccessDownWith(deps(), 'user_delete')).toEqual({ ok: true, removedLines: 1 })
  })

  // Samu's review of #2786, N1: "never throws" holds when the consent rows cannot be written.
  it('a failure closing the consent rows does not throw: the machine is clean, the answer says so', async () => {
    mkdirSync(supportDir, { recursive: true, mode: 0o700 })
    writeSupportToken(supportDir, TOKEN)
    getDb().exec('ALTER TABLE support_consents RENAME TO support_consents_away')
    try {
      expect(await takeSupportAccessDownWith(deps(), 'password_change')).toEqual({ ok: true, removedLines: 0 })
    } finally {
      getDb().exec('ALTER TABLE support_consents_away RENAME TO support_consents')
    }
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
  })

  it('what cannot be taken down is told to the owner, and the rows stay open', async () => {
    mkdirSync(supportDir, { recursive: true, mode: 0o700 })
    writeSupportToken(supportDir, TOKEN)
    insertSupportConsent({ grantId: GRANT, consentVersion: 1, consentSha256: null, consentLang: null, consentAt: '2026-11-15T06:10:00Z', locale: null, keyNames: ['key1'], createdVia: 'button', actor: 'x' })
    rmSync(join(sshDir, 'authorized_keys'))
    mkdirSync(join(sshDir, 'authorized_keys'))
    expect(await takeSupportAccessDownWith(deps(), 'password_change')).toMatchObject({ ok: false, problem: 'lines_remain' })
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(listSupportConsents().map((r) => r.revoked_via)).toEqual([null])
  })
})
