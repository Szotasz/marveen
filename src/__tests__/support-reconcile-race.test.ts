import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// G4: a new enabling that lands AFTER the old lines went and BEFORE the token would be removed must keep its token
// and record. The real guarded removal runs, then (as a stand-in for that enabling) a new token is written.
const race = vi.hoisted(() => ({ newToken: null as string | null, supportDir: '' }))
vi.mock('../support-access-fs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../support-access-fs.js')>()
  const { writeSupportToken } = await import('../support-access-token.js')
  return {
    ...real,
    revokeSupportLinesIf: async (...args: Parameters<typeof real.revokeSupportLinesIf>) => {
      const out = await real.revokeSupportLinesIf(...args)
      if (race.newToken !== null) writeSupportToken(race.supportDir, race.newToken)
      return out
    },
  }
})

import { TOKEN_REVOKED_BODY } from '../support-access-check.js'
import { readSupportToken } from '../support-access-token.js'
import { readGroupRecord } from '../support-group-record.js'
import { writeKit } from '../support-kit.js'
import { KIT_DISPATCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { reconcileSupportStandby, type ReconcileRevokedVia } from '../support-reconcile.js'
import { enableSupportStandby, SUPPORT_CONSENT_VERSION, type StandbyDeps } from '../support-standby-enable.js'
import { TEST_ONLY_FROM, TEST_ONLY_KEYS } from './helpers/sk-test-keys.js'

// TEST ONLY values.
const CODE = 'msc_' + 'TESTONLY'.repeat(4)
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const TOKEN2 = 'mst_' + 'TESTONLY'.repeat(5) + '_-1'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('the token_revoked removal, a new enabling between the lines and the token (G4)', () => {
  let root: string
  let supportDir: string
  let sshDir: string
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-reconcile-race-')))
    supportDir = join(root, 'home', '.marveen', 'support')
    sshDir = join(root, 'home', '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(sshDir, 'authorized_keys'), '', { mode: 0o600 })
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
    race.supportDir = supportDir
    race.newToken = null
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the new token and the record, and closes no row', async () => {
    const standby: StandbyDeps = {
      supportDir,
      sshDir,
      pins: { keys: TEST_ONLY_KEYS, fromCidrs: TEST_ONLY_FROM },
      probeSshd: async () => ({ ok: true, version: { major: 9, minor: 6 }, keysFiles: ['authorized_keys'], listenPorts: [22], hostKeyFiles: [] }),
      readHostKey: async () => ({ kind: 'ok', key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ' }),
      redeemTransport: async () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) }),
      now: () => new Date('2026-11-15T06:10:00Z'),
      newGrantId: () => '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      startedFromKit: true,
    }
    expect(await enableSupportStandby({ code: CODE, consentVersion: SUPPORT_CONSENT_VERSION }, standby)).toMatchObject({ ok: true })
    race.newToken = TOKEN2
    const revoked: ReconcileRevokedVia[] = []
    const outcome = await reconcileSupportStandby({
      standby,
      transport: async () => ({ status: 401, body: TOKEN_REVOKED_BODY }),
      consents: { has: () => true, insertFromRecord: () => {}, revokeOpen: (via) => revoked.push(via) },
      notifyOwner: () => {},
      log: () => {},
    })
    expect(outcome).toBe('token_changed')
    expect(readSupportToken(supportDir)).toEqual({ kind: 'ok', token: TOKEN2 })
    expect(readGroupRecord(supportDir).kind).toBe('ok')
    expect(revoked).toEqual([])
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'latin1')).toBe('')
  })
})
