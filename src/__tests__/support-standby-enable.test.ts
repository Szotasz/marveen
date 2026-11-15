import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disableSupportStandby, enableSupportStandby, SUPPORT_CONSENT_VERSION, type StandbyDeps } from '../support-standby-enable.js'
import { readSupportToken, SUPPORT_TOKEN_FILE } from '../support-access-token.js'
import { readGroupRecord, SUPPORT_GROUP_RECORD_FILE } from '../support-group-record.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { countSupportLines } from '../support-access-line.js'
import type { RedeemTransport } from '../support-access-redeem.js'
import type { SshdAssessment } from '../support-access-sshd.js'
import { TEST_ONLY_BLOBS, TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// TEST ONLY values: a code and a token of the right shape, issued by nobody.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OWN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH owner@laptop'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const noSleep = async (): Promise<void> => {}

describe('enable and disable support standby', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  let calls: string[]
  let transportAnswer: { status: number; body: string }

  async function makeKit(withDispatcher = true): Promise<void> {
    const dispatcher = Buffer.from('#!/bin/sh\nexit 1\n')
    const routine = Buffer.from('export async function main() { return 0 }\n')
    const files = [{ name: KIT_ROUTINE_NAME, content: routine, sha256: sha(routine), executable: false }]
    if (withDispatcher) files.unshift({ name: KIT_DISPATCHER_NAME, content: dispatcher, sha256: sha(dispatcher), executable: false })
    await writeKit({ supportDir, files, installRoot: '/opt/marveen', nodePath: '/usr/bin/node', nodeMin: 20, release: '37c85a884', sleep: noSleep })
  }

  function deps(over: Partial<StandbyDeps> = {}): StandbyDeps {
    const transport: RedeemTransport = async () => {
      calls.push('redeem')
      return transportAnswer
    }
    return {
      supportDir,
      sshDir,
      pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
      probeSshd: async (): Promise<SshdAssessment> => {
        calls.push('probe')
        return { ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'] }
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
    })
    expect(calls).toEqual(['probe', 'redeem'])
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN })
    expect(readGroupRecord(supportDir)).toEqual({
      kind: 'ok',
      record: {
        grantId: GRANT,
        consentVersion: 1,
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
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps({ startedFromKit: false }))).toEqual({ ok: false, problem: 'enable_not_from_kit' })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it.each<[string, unknown, unknown, string]>([
    ['no code', '', 1, 'code_required'],
    ['a licence key', 'mrv_' + 'x'.repeat(40), 1, 'license_key_not_accepted'],
    ['a code of another shape', 'msc_short', 1, 'code_shape'],
    ['a consent version this release does not know', CODE, 2, 'consent_invalid'],
    ['a consent version as text', CODE, '1', 'consent_invalid'],
  ])('refuses %s before it asks sshd or the service', async (_label, code, consentVersion, problem) => {
    expect(await enableSupportStandby({ code, consentVersion }, deps())).toEqual({ ok: false, problem })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it('refuses when the pins of this release are unset or invalid', async () => {
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps({ pins: { keys: [], fromCidrs: [] } }))).toEqual({ ok: false, problem: 'support_keys_unset' })
    const twice = { keys: [TEST_ONLY_KEYS[0], TEST_ONLY_KEYS[0]], fromCidrs: TEST_ONLY_FROM }
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps({ pins: twice }))).toEqual({ ok: false, problem: 'support_pins_invalid' })
    expect(calls).toEqual([])
    nothingWritten()
  })

  it('refuses with sshd\'s reason, and redeems nothing', async () => {
    const probeSshd = async (): Promise<SshdAssessment> => {
      calls.push('probe')
      return { ok: false, problem: 'sshd_config_include_unlistable', version: { major: 9, minor: 6 } }
    }
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps({ probeSshd }))).toEqual({ ok: false, problem: 'sshd_config_include_unlistable' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
  })

  // Dani 78357, Q3: the kit is checked before any line, and the lines bind its dispatcher.
  it('refuses a missing kit, or a kit without a dispatcher, before it redeems anything', async () => {
    rmSync(join(supportDir, 'kit'), { recursive: true })
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem: 'kit_missing' })
    await makeKit(false)
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem: 'kit_mismatch' })
    expect(calls).toEqual(['probe', 'probe'])
    nothingWritten()
  })

  it('refuses with the kit\'s own reason when the kit is there but not safe', async () => {
    chmodSync(join(supportDir, 'kit'), 0o770)
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem: 'kit_writable_by_others' })
    expect(calls).toEqual(['probe'])
    nothingWritten()
  })

  it.each<[number, string]>([
    [401, 'code_rejected'],
    [429, 'rate_limited'],
    [503, 'service_unavailable'],
  ])('refuses when the service answers %i, and writes nothing', async (status, problem) => {
    transportAnswer = { status, body: '' }
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem })
    nothingWritten()
  })

  it('takes everything back when the lines cannot be written (a hard-linked second file), and says why', async () => {
    linkSync(join(sshDir, 'authorized_keys'), join(sshDir, 'authorized_keys2'))
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem: 'keys_file_layout' })
    nothingWritten()
    expect(keysText()).toBe(OWN_LINE + '\n')
  })

  it('takes the token back when the record cannot be written', async () => {
    mkdirSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))
    expect(await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())).toEqual({ ok: false, problem: 'enable_write_failed' })
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(countSupportLines(keysText(), TEST_ONLY_BLOBS)).toBe(0)
  })

  it('disables: the lines, the token and the record go; the owner\'s line stays; twice is fine', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 2 })
    nothingWritten()
    expect(keysText()).toBe(OWN_LINE + '\n')
    expect(await disableSupportStandby(deps())).toEqual({ ok: true, removedLines: 0 })
  })

  it('disable works without a kit, and still removes the token and the record when the lines cannot be removed', async () => {
    await enableSupportStandby({ code: CODE, consentVersion: 1 }, deps())
    rmSync(join(supportDir, 'kit'), { recursive: true })
    rmSync(join(sshDir, 'authorized_keys'))
    mkdirSync(join(sshDir, 'authorized_keys'))
    expect(await disableSupportStandby(deps())).toEqual({ ok: false, problem: 'lines_remain', removedLines: 0 })
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
  })
})
