import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countSupportLines } from '../support-access-line.js'
import { SUPPORT_TOKEN_FILE } from '../support-access-token.js'
import { SUPPORT_GROUP_RECORD_FILE } from '../support-group-record.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { enableSupportStandby, SUPPORT_CONSENT_VERSION } from '../support-standby-enable.js'
import { TEST_ONLY_BLOBS, TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// Faults inside the grant. 'after-write': the grant writes for real, then throws; enable must take the lines back
// too, not only the token and the record. 'layout': the layout changed between enable's own check and the grant's
// (the grant refuses under its lock); enable must still say keys_file_layout.
// 'record': the group record cannot be written after the token was; the token must go again.
const fault = vi.hoisted(() => ({ mode: 'after-write' as 'after-write' | 'layout' | 'record' }))
vi.mock('../support-group-record.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../support-group-record.js')>()
  return {
    ...real,
    writeGroupRecord: (...args: Parameters<typeof real.writeGroupRecord>) => {
      if (fault.mode === 'record') throw new real.GroupRecordError('group_record_readback', 'TEST ONLY: the record did not read back')
      real.writeGroupRecord(...args)
    },
  }
})
vi.mock('../support-access-fs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../support-access-fs.js')>()
  return {
    ...real,
    grantSupportLines: async (...args: Parameters<typeof real.grantSupportLines>) => {
      if (fault.mode === 'layout') throw new real.SupportKeysLayoutError('TEST ONLY: the layout changed under the lock')
      await real.grantSupportLines(...args)
      throw new Error('TEST ONLY: a failure after the lines were written')
    },
  }
})

// TEST ONLY values: a code and a token of the right shape, issued by nobody.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const OWN_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH owner@laptop'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('enable support standby, a failure after the lines were written', () => {
  let root: string
  let supportDir: string
  let sshDir: string

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-enable-fault-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), OWN_LINE + '\n', { mode: 0o600 })
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

  const run = () =>
    enableSupportStandby(
      { code: CODE, consentVersion: SUPPORT_CONSENT_VERSION },
      {
        supportDir,
        sshDir,
        pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
        probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'], listenPorts: [22], hostKeyFiles: [] }),
        readHostKey: async () => ({ kind: 'ok', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ' }),
        redeemTransport: async () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) }),
        now: () => new Date('2026-11-15T06:10:00Z'),
        newGrantId: () => '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        startedFromKit: true,
      },
    )

  it('a layout refusal under the grant\'s lock is still keys_file_layout, and nothing stays', async () => {
    fault.mode = 'layout'
    try {
      expect(await run()).toEqual({ ok: false, problem: 'keys_file_layout' })
    } finally {
      fault.mode = 'after-write'
    }
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'latin1')).toBe(OWN_LINE + '\n')
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
  })

  it('takes the token back when the record cannot be written, and writes no line', async () => {
    fault.mode = 'record'
    try {
      expect(await run()).toEqual({ ok: false, problem: 'enable_write_failed' })
    } finally {
      fault.mode = 'after-write'
    }
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'latin1')).toBe(OWN_LINE + '\n')
  })

  it('takes the lines back as well as the token and the record, and answers enable_write_failed', async () => {
    const result = await enableSupportStandby(
      { code: CODE, consentVersion: SUPPORT_CONSENT_VERSION },
      {
        supportDir,
        sshDir,
        pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
        probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'], listenPorts: [22], hostKeyFiles: [] }),
        readHostKey: async () => ({ kind: 'ok', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ' }),
        redeemTransport: async () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) }),
        now: () => new Date('2026-11-15T06:10:00Z'),
        newGrantId: () => '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        startedFromKit: true,
      },
    )
    expect(result).toEqual({ ok: false, problem: 'enable_write_failed' })
    const text = readFileSync(join(sshDir, 'authorized_keys'), 'latin1')
    expect(countSupportLines(text, TEST_ONLY_BLOBS)).toBe(0)
    expect(text).toBe(OWN_LINE + '\n')
    expect(existsSync(join(supportDir, SUPPORT_TOKEN_FILE))).toBe(false)
    expect(existsSync(join(supportDir, SUPPORT_GROUP_RECORD_FILE))).toBe(false)
  })
})
