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
import { enableSupportStandby } from '../support-standby-enable.js'
import { TEST_ONLY_BLOBS, TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// A failure AFTER the lines were written: the grant writes for real, then throws.
// Enable must take the lines back too, not only the token and the record.
vi.mock('../support-access-fs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../support-access-fs.js')>()
  return {
    ...real,
    grantSupportLines: async (...args: Parameters<typeof real.grantSupportLines>) => {
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

  it('takes the lines back as well as the token and the record, and answers enable_write_failed', async () => {
    const result = await enableSupportStandby(
      { code: CODE, consentVersion: 1 },
      {
        supportDir,
        sshDir,
        pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
        probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys', 'authorized_keys2'] }),
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
