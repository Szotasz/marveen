import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disableSupportStandby, enableSupportStandby, SUPPORT_CONSENT_VERSION, type StandbyDeps } from '../support-standby-enable.js'
import { readSupportToken, SUPPORT_TOKEN_FILE } from '../support-access-token.js'
import { readGroupRecord, SUPPORT_GROUP_RECORD_FILE, SUPPORT_RUN_DIR } from '../support-group-record.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { countSupportLines } from '../support-access-line.js'
import type { RedeemTransport } from '../support-access-redeem.js'
import { SUPPORT_HOST_KEY_PATH } from '../support-access-hostkey.js'
import type { SshdAssessment } from '../support-access-sshd.js'
import { TEST_ONLY_BLOBS, TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// TEST ONLY values: a code and a token of the right shape, issued by nobody.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
// TEST ONLY host key: the right shape, 32 bytes of 0x09.
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ'
const OWN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH owner@laptop'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const noSleep = async (): Promise<void> => {}

describe('enable and disable support standby', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  let calls: string[]
  let transportAnswer: { status: number; body: string }
  let hostKeyAnswer: { status: number; body: string } | 'throw'
  let hostKeySends: { body: string; bearer: string | undefined; linesAtSend: number }[]
  let hostKeyAsked: { listenPorts: readonly number[]; hostKeyFiles: readonly string[] }[]

  async function makeKit(withDispatcher = true): Promise<void> {
    const dispatcher = Buffer.from('#!/bin/sh\nexit 1\n')
    const routine = Buffer.from('export async function main() { return 0 }\n')
    const files = [{ name: KIT_ROUTINE_NAME, content: routine, sha256: sha(routine), executable: false }]
    if (withDispatcher) files.unshift({ name: KIT_DISPATCHER_NAME, content: dispatcher, sha256: sha(dispatcher), executable: false })
    await writeKit({ supportDir, files, installRoot: '/opt/marveen', nodePath: '/usr/bin/node', nodeMin: 20, release: '37c85a884', sleep: noSleep })
  }

  function deps(over: Partial<StandbyDeps> = {}): StandbyDeps {
    const transport: RedeemTransport = async (req) => {
      if (req.path === SUPPORT_HOST_KEY_PATH) {
        calls.push('host-key')
        hostKeySends.push({ body: req.body, bearer: req.bearer, linesAtSend: countSupportLines(keysText(), TEST_ONLY_BLOBS) })
        if (hostKeyAnswer === 'throw') throw new Error('timeout')
        return hostKeyAnswer
      }
      calls.push('redeem')
      return transportAnswer
    }
    return {
      supportDir,
      sshDir,
      pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
      probeSshd: async (): Promise<SshdAssessment> => {
        calls.push('probe')
        return { ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'], listenPorts: [22], hostKeyFiles: [] }
      },
      readHostKey: async (s) => {
        hostKeyAsked.push({ listenPorts: s.listenPorts, hostKeyFiles: s.hostKeyFiles })
        return { kind: 'ok', key: HOST_KEY }
      },
      redeemTransport: transport,
      now: () => new Date('2026-11-15T06:10:00.456Z'),
      newGrantId: () => GRANT,
      startedFromKit: true,
      ...over,
    }
  }
  const keysText = (): string => readFileSync(join(sshDir, 'authorized_keys'), 'latin1')
  const nothingWritten = (): void => {
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
    expect(countSupportLines(keysText(), TEST_ONLY_BLOBS)).toBe(0)
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-enable-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n', { mode: 0o600 })
    calls = []
    transportAnswer = { status: 200, body: JSON.stringify({ token: TOKEN }) }
    hostKeyAnswer = { status: 200, body: '{"stored":true}' }
    hostKeySends = []
    hostKeyAsked = []
    await makeKit()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('enables: token, record and one line per key, bound to the kit\'s dispatcher; the owner\'s line stays', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({
      ok: true,
      keys: ['key1', 'key2'],
      lines: 2,
      hostKey: 'stored',
    })
    expect(calls).toEqual(['probe', 'redeem', 'host-key'])
    // the confirmed key of the sshd the probe asked, sent with the new token, after the lines are written
    expect(hostKeyAsked).toEqual([{ listenPorts: [22], hostKeyFiles: [] }])
    expect(hostKeySends).toEqual([{ body: '{"host_key":"' + HOST_KEY + '"}', bearer: TOKEN, linesAtSend: 2 }])
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
    expect(readGroupRecord(supportDir)).toEqual({
      kind: 'ok',
      record: {
        grantId: GRANT,
        consentVersion: SUPPORT_CONSENT_VERSION,
        consentAt: '2026-11-15T06:10:00Z',
        keys: TEST_ONLY_KEYS.map((k) => ({ name: k.name, fingerprint: k.fingerprint })),
        fromCidrs: [...TEST_ONLY_FROM],
        dispatchPath: join(supportDir, 'kit', KIT_DISPATCHER_NAME),
        sshd: { major: 9, minor: 6 },
      },
    })
    const text = keysText()
    expect(text.startsWith(OWN_LINE + '\n')).toBe(true)
    expect(countSupportLines(text, TEST_ONLY_BLOBS)).toBe(2)
    expect(text).toContain('command="/bin/sh ' + join(supportDir, 'kit', KIT_DISPATCHER_NAME) + ' --key key1 ')
  })

  it('is refused, and writes and asks nothing, unless it is the kit\'s copy started by the loader', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ startedFromKit: false }))).toEqual({ ok: false, problem: 'enable_not_from_kit' })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it.each<[string, unknown, unknown, string]>([
    ['no code', '', 1, 'code_required'],
    ['a licence key', 'mrv_' + 'x'.repeat(40), 1, 'license_key_not_accepted'],
    ['a code of another shape', 'msc_short', 1, 'code_shape'],
    ['a consent version this release does not know', CODE, 3, 'consent_invalid'],
    ['an earlier consent version (1): the owner must see the current text', CODE, 1, 'consent_invalid'],
    ['a consent version as text', CODE, '1', 'consent_invalid'],
  ])('refuses %s before it asks sshd or the service', async (_label, code, consentVersion, problem) => {
    expect(await enableSupportStandby({ code, consentVersion }, deps())).toEqual({ ok: false, problem })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it('refuses when the pins of this release are unset or invalid', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ pins: { keys: [], fromCidrs: [] } }))).toEqual({ ok: false, problem: 'support_keys_unset' })
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ pins: { keys: [], fromCidrs: TEST_ONLY_FROM } }))).toEqual({ ok: false, problem: 'support_keys_unset' })
    // keys pinned, no source address yet (this release): that, not "no key" (Geri 78991)
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ pins: { keys: TEST_ONLY_KEYS, fromCidrs: [] } }))).toEqual({ ok: false, problem: 'support_from_unset' })
    const twice = { keys: [TEST_ONLY_KEYS[0], TEST_ONLY_KEYS[0]], fromCidrs: TEST_ONLY_FROM }
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ pins: twice }))).toEqual({ ok: false, problem: 'support_pins_invalid' })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it('refuses with sshd\'s reason, and redeems nothing', async () => {
    const probeSshd = async (): Promise<SshdAssessment> => {
      calls.push('probe')
      return { ok: false, problem: 'sshd_config_include_unlistable', version: { major: 9, minor: 6 } }
    }
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ probeSshd }))).toEqual({ ok: false, problem: 'sshd_config_include_unlistable' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
  })

  it.each<['missing' | 'unverified', string]>([
    ['missing', 'host_key_missing'],
    // Dani 79778: a key on the wire that no root-owned .pub confirms (another listener on the port)
    ['unverified', 'host_key_unverified'],
  ])('refuses a host key that is %s, before it redeems: the code is not used', async (kind, problem) => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ readHostKey: async () => ({ kind }) }))).toEqual({ ok: false, problem })
    expect(calls).toEqual(['probe'])
    nothingWritten()
  })

  it('asks the host key of the sshd the probe asked: its ports and its hostkey files', async () => {
    const probeSshd = async (): Promise<SshdAssessment> => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys'], listenPorts: [2200, 2222], hostKeyFiles: ['/etc/ssh/k'] })
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps({ probeSshd }))).toMatchObject({ ok: true })
    expect(hostKeyAsked).toEqual([{ listenPorts: [2200, 2222], hostKeyFiles: ['/etc/ssh/k'] }])
  })

  it.each<[string, { status: number; body: string } | 'throw']>([
    ['a 503', { status: 503, body: '{"error":"unavailable"}' }],
    ['a 401', { status: 401, body: '{"error":"invalid_status_token"}' }],
    ['no answer', 'throw'],
  ])('a host-key send that is not stored (%s) does not stop the enable: everything written stays', async (_label, answer) => {
    hostKeyAnswer = answer
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: true, keys: ['key1', 'key2'], lines: 2, hostKey: 'not_stored' })
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
    expect(readGroupRecord(supportDir).kind).toBe('ok')
    expect(countSupportLines(keysText(), TEST_ONLY_BLOBS)).toBe(2)
  })

  // Dani 78357, Q3: the kit is checked before any line, and the lines bind its dispatcher.
  it('refuses a missing kit, or a kit without a dispatcher, before it redeems anything', async () => {
    rmSync(join(supportDir, 'kit'), { recursive: true })
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'kit_missing' })
    await makeKit(false)
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'kit_mismatch' })
    expect(calls).toEqual(['probe', 'probe'])
    nothingWritten()
  })

  it('refuses with the kit\'s own reason when the kit is there but not safe', async () => {
    chmodSync(join(supportDir, 'kit'), 0o770)
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'kit_writable_by_others' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
  })

  it.each<[number, string]>([
    [401, 'code_rejected'],
    [429, 'rate_limited'],
    [503, 'service_unavailable'],
  ])('refuses when the service answers %i, and writes nothing', async (status, problem) => {
    transportAnswer = { status, body: '' }
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem })
    nothingWritten()
  })

  // Dani's review of #2779, F2: a layout the grant would refuse must not cost the code.
  it('refuses a keys-file layout a grant could not keep (a hard-linked second file) before it redeems the code', async () => {
    linkSync(join(sshDir, 'authorized_keys'), join(sshDir, 'authorized_keys2'))
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'keys_file_layout' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
    expect(keysText()).toBe(OWN_LINE + '\n')
  })

  it('refuses a second file that links elsewhere before it redeems the code; a link to the first file is fine', async () => {
    writeFileSync(join(root, 'elsewhere'), '')
    symlinkSync(join(root, 'elsewhere'), join(sshDir, 'authorized_keys2'))
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'keys_file_layout' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
    rmSync(join(sshDir, 'authorized_keys2'))
    symlinkSync('authorized_keys', join(sshDir, 'authorized_keys2'))
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toMatchObject({ ok: true })
  })

  // Dani's review of #2779, F1: a second enable would redeem a second code and overwrite the token.
  it('refuses while standby is on, before sshd or the service is asked; the first token stays', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toMatchObject({ ok: true })
    calls = []
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'already_on' })
    expect(calls).toEqual([])
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
  })

  it('a half state is on too (only the token, or only the record): switch off first', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toMatchObject({ ok: true })
    rmSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))
    calls = []
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'already_on' })
    await disableSupportStandby(deps())
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toMatchObject({ ok: true })
    rmSync(join(supportDir, SUPPORT_TOKEN_FILE))
    calls = []
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'already_on' })
    expect(calls).toEqual([])
  })

  it('something that is not a record at the record path counts as on: switch off first (the write failure is in the fault tests)', async () => {
    mkdirSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())).toEqual({ ok: false, problem: 'already_on' })
    expect(calls).toEqual([])
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
  })

  it('disables: the lines, the token and the record go; the owner\'s line stays; twice is fine', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 2 })
    nothingWritten()
    expect(keysText()).toBe(OWN_LINE + '\n')
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 0 })
  })

  it('disable removes the pid files of running dispatchers, and only those', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())
    const runDir = join(supportDir, SUPPORT_RUN_DIR)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '4242'), 'pid=4242\n')
    writeFileSync(join(runDir, '17'), 'pid=17\n')
    writeFileSync(join(runDir, 'body.4242'), 'x')
    mkdirSync(join(runDir, 'r.4242'))
    mkdirSync(join(runDir, '99'))
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 2 })
    expect(readdirSync(runDir).sort()).toEqual(['99', 'body.4242', 'r.4242'])
  })

  it('a run folder that is a link is left alone; disable still succeeds', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())
    const elsewhere = join(supportDir, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, '4242'), 'pid=4242\n')
    symlinkSync(elsewhere, join(supportDir, SUPPORT_RUN_DIR))
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 2 })
    expect(existsSync(join(elsewhere, '4242'))).toBe(true)
  })

  it('disable works without a kit, and still removes the token and the record when the lines cannot be removed', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, deps())
    rmSync(join(supportDir, 'kit'), { recursive: true })
    rmSync(join(sshDir, 'authorized_keys'))
    mkdirSync(join(sshDir, 'authorized_keys'))
    expect(await disableSupportStandby(deps())).toEqual({ ok: false, problem: 'lines_remain', removedLines: 0 })
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
  })
})
