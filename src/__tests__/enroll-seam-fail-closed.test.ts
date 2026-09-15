// ENROLL813 regression: the authorized_keys writers and the ssh-dir resolver
// must FAIL CLOSED under a test runner, instead of quietly writing the
// operator's real ~/.ssh.
//
// What went wrong (2026-09-15): `POST /api/security/bridge-enroll` calls
// bridgeEnroll() without deps, the default resolver fell back to
// homedir()/.ssh, and one branch of bridge-enroll.test.ts hits that route with a
// valid address before the file sets MARVEEN_SSH_DIR. One full suite run =
// exactly one real `marveen-remote` key. 62 of them accumulated across the fleet
// (Tecton 13, isapp06 51, pestihazak 4), and the suite was green the whole time.
//
// Two halves, and they need opposite things from the environment:
//   TEST MODE   (the first blocks) -- the guards must REFUSE the real ~/.ssh.
//   PRODUCTION  (the last block)   -- the same guards must be INERT, or this
//                                    patch would break customer pairing. That
//                                    half strips VITEST/NODE_ENV and genuinely
//                                    WRITES, because a guard whose production
//                                    behaviour is untested can silently become
//                                    a blocker, and "it has no production
//                                    behaviour" is the whole case for shipping it.
//
// Safety of this file, in BOTH halves: it never names the tester's actual home.
// process.env.HOME is redirected to a fresh scratch directory in beforeEach and
// asserted to have taken effect, so "the real ~/.ssh" every case here resolves,
// refuses, or writes IS a temp path. A regression -- or the production block
// doing its normal job -- puts the key in that temp directory, never in anyone's
// account. The environment is put back by the file-level afterEach, not by the
// block that changed it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  enrollAuthorizedKey,
  updateEnrolledServicePorts,
  removeEnrolledKey,
} from '../remote-enroll-fs.js'
import {
  resolveSshDir,
  realSshDir,
  sshDirOverride,
  isSshDirGuardError,
  SSH_DIR_GUARD_CODE,
} from '../ssh-dir.js'
import { isTestRun } from '../test-run-marker.js'
import { restrictOptions, COMMENT_PREFIX } from '../remote-enroll-core.js'

const LINE = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA marveen-remote:${randomUUID()}`

// The production-branch block below drives updateEnrolledServicePorts, which
// only recognises a line in the exact shape this file authors: four fields,
// options first. LINE above has no options field on purpose (the guard refuses
// before parsing), so it would be silently skipped as "not ours to rewrite".
const PROD_INSTALL_ID = randomUUID()
const PROD_LINE = `${restrictOptions(3420)} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ${COMMENT_PREFIX}${PROD_INSTALL_ID}`

let fakeHome: string
let scratchSshDir: string
let savedHome: string | undefined
let savedOverride: string | undefined
// Saved and restored at FILE level, not inside the block that removes them: an
// assertion that throws mid-test must not leak a signal-free environment into
// the next test -- or, worse, into the next file in this vitest worker, where
// every other suite's guards would quietly stop guarding.
let savedVitest: string | undefined
let savedNodeEnv: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  savedOverride = process.env.MARVEEN_SSH_DIR
  savedVitest = process.env['VITEST']
  savedNodeEnv = process.env['NODE_ENV']
  fakeHome = mkdtempSync(join(tmpdir(), 'enroll-seam-home-'))
  process.env.HOME = fakeHome
  // Sanity: without this the whole file would be testing the REAL home, which
  // is the one thing it must never do.
  expect(homedir()).toBe(fakeHome)
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true, mode: 0o700 })
  scratchSshDir = mkdtempSync(join(tmpdir(), 'enroll-seam-scratch-'))
})

afterEach(() => {
  // Signals first: everything after this line (and every later test) must run
  // in a normal test environment again.
  if (savedVitest === undefined) delete process.env['VITEST']
  else process.env['VITEST'] = savedVitest
  if (savedNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = savedNodeEnv
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedOverride === undefined) delete process.env.MARVEEN_SSH_DIR
  else process.env.MARVEEN_SSH_DIR = savedOverride
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(scratchSshDir, { recursive: true, force: true })
})

describe('remote-enroll-fs chokepoint (ENROLL813)', () => {
  it('refuses to ENROLL into the real ~/.ssh from a test run, and writes nothing', async () => {
    await expect(
      enrollAuthorizedKey({ sshDir: realSshDir(), restrictedLine: LINE, installId: 'x' }),
    ).rejects.toThrow(/ENROLL813/)
    // The point of the guard: refusal must be side-effect free. A guard that
    // throws AFTER writing would still have enrolled the key.
    expect(existsSync(join(fakeHome, '.ssh', 'authorized_keys'))).toBe(false)
  })

  it('names the test signal it detected, so a production misfire is diagnosable from the message', async () => {
    await expect(
      enrollAuthorizedKey({ sshDir: realSshDir(), restrictedLine: LINE, installId: 'x' }),
    ).rejects.toThrow(/VITEST=|NODE_ENV=test/)
  })

  it('refuses to REWRITE service ports in the real ~/.ssh (the other two writers are guarded too)', async () => {
    await expect(
      updateEnrolledServicePorts({ sshDir: realSshDir(), installId: 'x', webPort: 3420, ports: [] }),
    ).rejects.toThrow(/ENROLL813/)
  })

  it('refuses to REMOVE a key from the real ~/.ssh', async () => {
    await expect(removeEnrolledKey({ sshDir: realSshDir(), installId: 'x' })).rejects.toThrow(/ENROLL813/)
  })

  it('still enrolls normally into a scratch directory -- the guard is narrow, not blanket', async () => {
    const result = await enrollAuthorizedKey({
      sshDir: scratchSshDir,
      restrictedLine: LINE,
      installId: 'scratch-install',
    })
    expect(result.action).toBe('added')
    expect(existsSync(join(scratchSshDir, 'authorized_keys'))).toBe(true)
  })
})

describe('resolveSshDir (ENROLL813)', () => {
  it('throws instead of falling back to the real ~/.ssh when the seam is unset', () => {
    delete process.env.MARVEEN_SSH_DIR
    expect(() => resolveSshDir()).toThrow(/ENROLL813/)
  })

  it('returns the override and notifies the caller so the redirect is never silent', () => {
    process.env.MARVEEN_SSH_DIR = scratchSshDir
    const seen: string[] = []
    expect(resolveSshDir((d) => seen.push(d))).toBe(scratchSshDir)
    expect(seen).toEqual([scratchSshDir])
    expect(sshDirOverride()).toBe(scratchSshDir)
  })
})

// ---------------------------------------------------------------------------
// PRODUCTION BRANCH -- the half the suite could not see.
//
// Everything above runs under vitest, i.e. on the guarded side of the
// `if (!isTestRun()) return` that opens assertSafeSshDir(). That leaves the
// property this patch most needs to hold completely untested: IN A LIVE INSTALL
// THESE GUARDS MUST BE INERT. If a future refactor deletes that early return,
// or inverts it, every assertion above still passes -- and the damage shows up
// at a customer, as a Bridge device that can no longer be paired. A guard whose
// production behaviour is untested is a guard that can silently become a
// blocker; the whole justification for shipping it is that it has no production
// behaviour to get wrong, so that claim is the one that needs a test.
//
// Method: strip the test signals (the enterProductionEnv/restoreEnv pattern
// from src/__tests__/test-run-marker.test.ts) and drive the real production
// path -- resolver, all three writers, end to end.
//
// Safety, and why this file may do that at all: the file-level beforeEach
// redirects HOME to a scratch directory and ASSERTS it took effect, so the
// "real ~/.ssh" these cases resolve and genuinely write IS a temp path. The
// tester's own account is never a candidate, in either mode. Restoring the
// signals is not left to the block either -- the file-level afterEach does it,
// so an assertion that throws mid-test cannot leak a signal-free environment
// into the next file in this worker.
describe('production branch -- the guards must stay INERT in a live install (ENROLL813)', () => {
  /** Remove every signal that makes isTestRun() true, plus the suite-wide seam
   * (which would otherwise answer first and we would never reach the production
   * fallback this block exists to cover). Restoration: file-level afterEach. */
  function enterProductionEnv(): void {
    delete process.env['VITEST']
    delete process.env['NODE_ENV']
    delete process.env['MARVEEN_SSH_DIR']
  }

  it('resolveSshDir() returns the real ~/.ssh instead of throwing', () => {
    enterProductionEnv()
    expect(isTestRun()).toBe(false)
    const dir = resolveSshDir()
    expect(dir).toBe(realSshDir())
    expect(dir).toBe(join(fakeHome, '.ssh'))
  })

  it('an explicit MARVEEN_SSH_DIR still wins in production -- and is still announced, never silent', () => {
    enterProductionEnv()
    process.env['MARVEEN_SSH_DIR'] = scratchSshDir
    const seen: string[] = []
    expect(resolveSshDir((d) => seen.push(d))).toBe(scratchSshDir)
    expect(seen).toEqual([scratchSshDir])
  })

  it('the full chain runs against the real ~/.ssh: enroll -> service-port rewrite -> revoke', async () => {
    enterProductionEnv()
    const sshDir = realSshDir()
    // Belt and braces before anything WRITES: refuse to continue unless "the
    // real ~/.ssh" is the scratch home this file created. If the HOME redirect
    // ever stops working, this fails instead of touching a real account.
    expect(sshDir.startsWith(tmpdir())).toBe(true)
    const authPath = join(sshDir, 'authorized_keys')

    // (b) the writers' guard is a no-op here -- none of these three throws.
    const enrolled = await enrollAuthorizedKey({
      sshDir,
      restrictedLine: PROD_LINE,
      installId: PROD_INSTALL_ID,
    })
    expect(enrolled.action).toBe('added')
    expect(readFileSync(authPath, 'utf8')).toContain(`${COMMENT_PREFIX}${PROD_INSTALL_ID}`)

    const ports = await updateEnrolledServicePorts({
      sshDir,
      installId: PROD_INSTALL_ID,
      webPort: 3420,
      ports: [8080],
    })
    expect(ports.found).toBe(true)
    expect(ports.after).toEqual([8080])
    expect(readFileSync(authPath, 'utf8')).toContain('permitopen="127.0.0.1:8080"')

    const removed = await removeEnrolledKey({ sshDir, installId: PROD_INSTALL_ID })
    expect(removed.removed).toBe(true)
    expect(readFileSync(authPath, 'utf8')).not.toContain(`${COMMENT_PREFIX}${PROD_INSTALL_ID}`)
  })

  it('A/B on ONE directory: the same writer succeeds without a test signal and refuses with one', async () => {
    // The sharpest form of the regression this block guards. Nothing differs
    // between the two halves except the presence of VITEST -- not the path, not
    // the arguments, not the file on disk. So a refactor that makes the guard
    // unconditional fails the first half, and one that makes it never fire
    // fails the second; a single assertion pair pins both directions.
    enterProductionEnv()
    const sshDir = realSshDir()
    expect(sshDir.startsWith(tmpdir())).toBe(true)

    await expect(
      enrollAuthorizedKey({ sshDir, restrictedLine: PROD_LINE, installId: PROD_INSTALL_ID }),
    ).resolves.toMatchObject({ action: 'added' })

    process.env['VITEST'] = 'true'
    await expect(removeEnrolledKey({ sshDir, installId: PROD_INSTALL_ID })).rejects.toThrow(/ENROLL813/)
    // And the refusal left the key alone: a guard that throws after writing
    // would still have revoked it.
    expect(readFileSync(join(sshDir, 'authorized_keys'), 'utf8')).toContain(
      `${COMMENT_PREFIX}${PROD_INSTALL_ID}`,
    )
  })

  it('a guard refusal is a distinguishable TYPE, not just a message -- callers branch on it', async () => {
    // readCurrentPorts() in bridge-service-ports.ts re-throws on this predicate
    // instead of reporting the device as unpaired. If the guards ever went back
    // to a bare Error, that catch would silently start swallowing them again.
    enterProductionEnv()
    process.env['VITEST'] = 'true'
    const err = await enrollAuthorizedKey({
      sshDir: realSshDir(),
      restrictedLine: PROD_LINE,
      installId: PROD_INSTALL_ID,
    }).catch((e: unknown) => e)
    expect(isSshDirGuardError(err)).toBe(true)
    expect((err as { code?: string }).code).toBe(SSH_DIR_GUARD_CODE)

    // ... and the predicate is TYPE/code based, not text based. An ordinary
    // error that merely mentions the ticket must not be mistaken for a guard
    // refusal, or the re-throw in readCurrentPorts would start eating real
    // I/O faults -- the same swallowing, one layer up.
    expect(isSshDirGuardError(new Error('ENROLL813 appears in this message only'))).toBe(false)
  })
})
