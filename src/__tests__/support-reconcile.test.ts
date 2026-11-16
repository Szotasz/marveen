import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countSupportLines, buildSupportLine } from '../support-access-line.js'
import type { RedeemTransport } from '../support-access-redeem.js'
import { TOKEN_REVOKED_BODY } from '../support-access-check.js'
import { SUPPORT_HOST_KEY_PATH, type OwnHostKey } from '../support-access-hostkey.js'
import type { SshdAssessment } from '../support-access-sshd.js'
import { readSupportToken, SUPPORT_TOKEN_FILE, writeSupportToken } from '../support-access-token.js'
import { readGroupRecord, SUPPORT_GROUP_RECORD_FILE, writeGroupRecord, type SupportGroupRecord } from '../support-group-record.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { reconcileSupportStandby, type ReconcileDeps, type ReconcileRevokedVia } from '../support-reconcile.js'
import { enableSupportStandby, SUPPORT_CONSENT_VERSION, type StandbyDeps } from '../support-standby-enable.js'
import { TEST_ONLY_BLOBS, TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// TEST ONLY values: a code and tokens of the right shape, issued by nobody.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const TOKEN2 = 'mst_' + 'TESTONLY'.repeat(5) + '_-1'
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OWN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH owner@laptop'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
// TEST ONLY host key: the right shape, 32 bytes of 0x09.
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ'
const OK_SSHD: SshdAssessment = { ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'], listenPorts: [22], hostKeyFiles: [] }

describe('the support reconcile (terv-v7 3.8; Dani 32056 G1-G6)', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  let sshd: SshdAssessment
  let probeAnswer: { status: number; body: string } | 'throw'
  let onProbe: () => void
  let ownHostKey: OwnHostKey
  let hostKeyAsked: { listenPorts: readonly number[]; hostKeyFiles: readonly string[] }[]
  let hostKeySends: { body: string; bearer: string | undefined }[]
  let hostKeyAnswer: { status: number; body: string } | 'throw'
  let logged: string[]
  let rows: { has: Set<string>; inserted: SupportGroupRecord[]; revoked: ReconcileRevokedVia[] }
  let notices: string[]
  let events: string[]

  const standby = (over: Partial<StandbyDeps> = {}): StandbyDeps => ({
    supportDir,
    sshDir,
    pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
    probeSshd: async () => sshd,
    readHostKey: async (s) => {
      hostKeyAsked.push({ listenPorts: s.listenPorts, hostKeyFiles: s.hostKeyFiles })
      return ownHostKey
    },
    redeemTransport: async () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) }),
    now: () => new Date('2026-11-15T06:10:00Z'),
    newGrantId: () => GRANT,
    startedFromKit: true,
    ...over,
  })
  const transport: RedeemTransport = async (req) => {
    if (req.path === SUPPORT_HOST_KEY_PATH) {
      hostKeySends.push({ body: req.body, bearer: req.bearer })
      if (hostKeyAnswer === 'throw') throw new Error('timeout')
      return hostKeyAnswer
    }
    onProbe()
    if (probeAnswer === 'throw') throw new Error('timeout')
    return probeAnswer
  }
  const deps = (over: Partial<StandbyDeps> = {}): ReconcileDeps => ({
    standby: standby(over),
    transport,
    consents: {
      has: (id) => rows.has.has(id),
      insertFromRecord: (r) => {
        rows.inserted.push(r)
        rows.has.add(r.grantId)
      },
      revokeOpen: (via) => {
        rows.revoked.push(via)
      },
    },
    notifyOwner: (text) => notices.push(text),
    log: (event, fields) => {
      events.push(event)
      logged.push(JSON.stringify({ event, ...(fields ?? {}) }))
    },
  })
  const keysText = (): string => readFileSync(join(sshDir, 'authorized_keys'), 'latin1')
  const supportLines = (): number => countSupportLines(keysText(), TEST_ONLY_BLOBS)
  const allGone = (): void => {
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
    expect(supportLines()).toBe(0)
    expect(keysText()).toBe(OWN_LINE + '\n')
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-reconcile-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n', { mode: 0o600 })
    sshd = OK_SSHD
    probeAnswer = { status: 401, body: '{"error":"invalid_status_token"}' }
    onProbe = () => {}
    ownHostKey = { kind: 'ok', key: HOST_KEY }
    hostKeyAsked = []
    hostKeySends = []
    hostKeyAnswer = { status: 200, body: '{"stored":true}' }
    logged = []
    rows = { has: new Set([GRANT]), inserted: [], revoked: [] }
    notices = []
    events = []
    const dispatcher = Buffer.from('#!/bin/sh\nexit 1\n')
    const routine = Buffer.from('export async function main() { return 0 }\n')
    await writeKit({
      supportDir,
      files: [
        { name: KIT_DISPATCHER_NAME, content: dispatcher, sha256: sha(dispatcher), executable: false },
        { name: KIT_ROUTINE_NAME, content: routine, sha256: sha(routine), executable: false },
      ],
      installRoot: '/opt/marveen',
      nodePath: '/usr/bin/node',
      nodeMin: 20,
      release: '37c85a884',
      sleep: async () => {},
    })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const enable = async (): Promise<void> => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, standby())).toMatchObject({ ok: true })
    expect(supportLines()).toBe(2)
  }

  it('keeps an intact standby: the lines stay, the token stays, nothing is told', async () => {
    await enable()
    expect(await reconcileSupportStandby(deps())).toBe('kept')
    expect(supportLines()).toBe(2)
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
    expect([rows.revoked, notices, rows.inserted]).toEqual([[], [], []])
  })

  it('off: takes a support line left behind out, and touches nothing else', async () => {
    await enable()
    rmSync(join(supportDir, SUPPORT_TOKEN_FILE))
    rmSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))
    expect(await reconcileSupportStandby(deps())).toBe('off')
    allGone()
    expect(notices).toEqual([])
  })

  it.each<[string, () => void]>([
    ['only the token', () => rmSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))],
    ['only the record', () => rmSync(join(supportDir, SUPPORT_TOKEN_FILE))],
    ['a record that is not ours', () => writeFileSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE), 'x\n', { mode: 0o600 })],
  ])('a half state (%s) goes as a whole, tampered, and the owner is told', async (_label, damage) => {
    await enable()
    damage()
    expect(await reconcileSupportStandby(deps())).toBe('removed_half_state')
    allGone()
    expect(rows.revoked).toEqual(['tampered'])
    expect(notices).toHaveLength(1)
  })

  it('a setting that changed since the enabling (sshd no longer ok) takes the standby down, tampered', async () => {
    await enable()
    sshd = { ok: false, problem: 'tunnel_permitted', version: { major: 9, minor: 6 } }
    expect(await reconcileSupportStandby(deps())).toBe('removed_sshd')
    allGone()
    expect(rows.revoked).toEqual(['tampered'])
    expect(notices).toHaveLength(1)
  })

  it('a kit that no longer verifies, or binds another dispatcher, takes the standby down', async () => {
    await enable()
    rmSync(join(supportDir, 'kit'), { recursive: true })
    expect(await reconcileSupportStandby(deps())).toBe('removed_kit')
    allGone()
  })

  // Dani's review of #2786, T1: the lines must never bind a path where no verified kit stands.
  it('a record that binds another dispatcher than the verified kit\'s takes the standby down', async () => {
    await enable()
    const record = readGroupRecord(supportDir)
    if (record.kind !== 'ok') throw new Error('no record')
    writeGroupRecord(supportDir, { ...record.record, dispatchPath: join(root, 'elsewhere', 'support-dispatch.sh') })
    expect(await reconcileSupportStandby(deps())).toBe('removed_kit')
    allGone()
  })

  it('keys this release no longer pins: their lines go; none left takes the standby down, replaced', async () => {
    await enable()
    expect(await reconcileSupportStandby(deps({ pins: { keys: [TEST_ONLY_KEYS[0]], fromCidrs: TEST_ONLY_FROM } }))).toBe('kept')
    expect(keysText()).not.toContain(TEST_ONLY_KEYS[1].pub)
    expect(keysText()).toContain(TEST_ONLY_KEYS[0].pub)
    const other = { ...TEST_ONLY_KEYS[1], name: 'other' }
    expect(await reconcileSupportStandby(deps({ pins: { keys: [other], fromCidrs: TEST_ONLY_FROM } }))).toBe('removed_unpinned')
    expect(rows.revoked).toEqual(['replaced'])
  })

  it('a key pinned again under the same name with another blob is not the recorded key: unpinned', async () => {
    await enable()
    const rotated = { ...TEST_ONLY_KEYS[1], name: TEST_ONLY_KEYS[0].name }
    expect(await reconcileSupportStandby(deps({ pins: { keys: [rotated], fromCidrs: TEST_ONLY_FROM } }))).toBe('removed_unpinned')
  })

  it('a deviant support line goes; a missing one is not written back', async () => {
    await enable()
    const record = readGroupRecord(supportDir)
    if (record.kind !== 'ok') throw new Error('no record')
    const foreign = buildSupportLine({
      key: TEST_ONLY_KEYS[0],
      grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3399',
      consentVersion: 1,
      dispatchPath: record.record.dispatchPath,
      fromCidrs: TEST_ONLY_FROM,
      sshd: { major: 9, minor: 6 },
    })
    writeFileSync(join(sshDir, 'authorized_keys'), keysText() + foreign + '\n')
    expect(supportLines()).toBe(3)
    expect(await reconcileSupportStandby(deps())).toBe('kept')
    expect(supportLines()).toBe(2)
    expect(keysText()).not.toContain('3f2504e0-4f89-41d3-9a0c-0305e82c3399')
  })

  it('Q1: an enabling without a consent row gets one, copied from the record, once', async () => {
    await enable()
    rows.has.clear()
    await reconcileSupportStandby(deps())
    await reconcileSupportStandby(deps())
    expect(rows.inserted.map((r) => [r.grantId, r.consentVersion, r.consentAt])).toEqual([[GRANT, SUPPORT_CONSENT_VERSION, '2026-11-15T06:10:00Z']])
  })

  it('token_revoked: on 401 with exactly that body, the lines go first, then the token and the record; external', async () => {
    await enable()
    probeAnswer = { status: 401, body: TOKEN_REVOKED_BODY }
    expect(await reconcileSupportStandby(deps())).toBe('removed_token_revoked')
    allGone()
    expect(rows.revoked).toEqual(['external'])
    expect(events.indexOf('token_revoked_lines')).toBeLessThan(events.indexOf('token_revoked_done'))
    expect(notices).toHaveLength(1)
  })

  it.each<[string, { status: number; body: string } | 'throw']>([
    ['a bare 401', { status: 401, body: '' }],
    ['a loose body (a line end)', { status: 401, body: TOKEN_REVOKED_BODY + '\n' }],
    ['a loose body (a space)', { status: 401, body: '{"error": "token_revoked"}' }],
    ['the body on another status', { status: 403, body: TOKEN_REVOKED_BODY }],
    ['a 5xx', { status: 503, body: '' }],
    ['no answer', 'throw'],
  ])('G5/G6: %s changes nothing', async (_label, answer) => {
    await enable()
    probeAnswer = answer
    expect(await reconcileSupportStandby(deps())).toBe('kept')
    expect(supportLines()).toBe(2)
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
    expect(rows.revoked).toEqual([])
  })

  it('G3: a token swapped while the answer was on its way (a new enabling) keeps everything', async () => {
    await enable()
    probeAnswer = { status: 401, body: TOKEN_REVOKED_BODY }
    onProbe = () => writeSupportToken(supportDir, TOKEN2)
    expect(await reconcileSupportStandby(deps())).toBe('token_changed')
    expect(supportLines()).toBe(2)
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN2 })
    expect(rows.revoked).toEqual([])
  })

  describe('the host key (support-hostkey-v1; Samu 79773)', () => {
    it('kept: the confirmed key of the sshd the probe asked is sent with the token; the log has the fingerprint only', async () => {
      await enable()
      sshd = { ...OK_SSHD, listenPorts: [2222, 2223], hostKeyFiles: ['/etc/ssh/ssh_host_ed25519_key'] }
      hostKeySends = []
      hostKeyAsked = []
      expect(await reconcileSupportStandby(deps())).toBe('kept')
      expect(hostKeyAsked).toEqual([{ listenPorts: [2222, 2223], hostKeyFiles: ['/etc/ssh/ssh_host_ed25519_key'] }])
      expect(hostKeySends).toEqual([{ body: '{"host_key":"' + HOST_KEY + '"}', bearer: TOKEN }])
      expect(logged).toContain(JSON.stringify({ event: 'host_key', fingerprint: 'SHA256:xcTb/ZL8NmQsvo9k2j/c7dIyp7nvDnswfPZHlzcZwz0', sent: 'stored' }))
      expect(logged.join('\n')).not.toContain(HOST_KEY.slice(12))
    })

    it.each<[string, { status: number; body: string } | 'throw']>([
      ['a 503', { status: 503, body: '{"error":"unavailable"}' }],
      ['a 429', { status: 429, body: '{"error":"rate_limited"}' }],
      ['no answer', 'throw'],
    ])('a send that is not stored (%s) changes nothing', async (_label, answer) => {
      await enable()
      hostKeyAnswer = answer
      expect(await reconcileSupportStandby(deps())).toBe('kept')
      expect(supportLines()).toBe(2)
      expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
      expect(logged).toContain(JSON.stringify({ event: 'host_key', fingerprint: 'SHA256:xcTb/ZL8NmQsvo9k2j/c7dIyp7nvDnswfPZHlzcZwz0', sent: 'not_stored' }))
      expect([rows.revoked, notices]).toEqual([[], []])
    })

    it.each<[OwnHostKey['kind'], string]>([
      ['missing', 'host_key_missing'],
      ['unverified', 'host_key_unverified'],
    ])('a key that is %s: nothing is sent, nothing changes, the log says which', async (kind, event) => {
      await enable()
      hostKeySends = []
      ownHostKey = { kind } as OwnHostKey
      expect(await reconcileSupportStandby(deps())).toBe('kept')
      expect(hostKeySends).toEqual([])
      expect(events).toContain(event)
      expect(supportLines()).toBe(2)
      expect([rows.revoked, notices]).toEqual([[], []])
    })

    it('token_revoked: the key is not asked and not sent', async () => {
      await enable()
      hostKeySends = []
      hostKeyAsked = []
      probeAnswer = { status: 401, body: TOKEN_REVOKED_BODY }
      expect(await reconcileSupportStandby(deps())).toBe('removed_token_revoked')
      expect([hostKeyAsked, hostKeySends]).toEqual([[], []])
    })
  })
})
