import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { KEYCHAIN_GUARD_CODE, SECURITY_IN_SHELL } from './setup/keychain-spawn-guard.js'

// Self-test for the global spawn guard (src/__tests__/setup/keychain-spawn-guard.ts,
// card 31a6e54d). It uses the REAL node:child_process -- the same named ESM
// bindings production modules import -- but never the real `security` binary:
// every target is a FAKE `security` in a scratch dir that only touches a marker
// file. If the guard ever let a call through, the marker appears and the test
// fails; the live Keychain cannot be reached either way.

const LIVE_ARGS = ['add-generic-password', '-U', '-s', 'com.marveen.vault', '-a', 'master-key', '-w', 'x', '-A']

let dir: string
let fake: string
let marker: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'keychain-guard-test-'))
  marker = join(dir, 'spawned')
  const script = '#!/bin/sh\n: > "$KEYCHAIN_GUARD_MARKER"\n'
  fake = join(dir, 'security')
  writeFileSync(fake, script)
  chmodSync(fake, 0o755)
  writeFileSync(join(dir, 'not-security'), script)
  chmodSync(join(dir, 'not-security'), 0o755)
  // PATH holds ONLY the scratch dir (+ /bin for sh): a bare `security` can
  // resolve to nothing but the fake, even if the guard failed.
  env = { PATH: `${dir}:/bin`, KEYCHAIN_GUARD_MARKER: marker }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => rmSync(marker, { force: true }))

function expectRefused(fn: () => unknown): void {
  let err: (Error & { code?: string }) | undefined
  try {
    fn()
  } catch (e) {
    err = e as Error & { code?: string }
  }
  expect(err?.code).toBe(KEYCHAIN_GUARD_CODE)
  expect(existsSync(marker)).toBe(false)
}

describe('keychain spawn guard (global vitest setup)', () => {
  it('positive control: the fake runs when it is NOT called security (so a refusal below is the guard)', () => {
    execFileSync(join(dir, 'not-security'), [], { env })
    expect(existsSync(marker)).toBe(true)
  })

  it('execFileSync of security with the live service + update flag is refused before spawning', () => {
    expectRefused(() => execFileSync(fake, LIVE_ARGS, { env }))
  })

  it('every file-form spawner refuses it: spawnSync, execFile, spawn', () => {
    expectRefused(() => spawnSync(fake, LIVE_ARGS, { env }))
    expectRefused(() => execFile(fake, LIVE_ARGS, { env }))
    expectRefused(() => spawn(fake, LIVE_ARGS, { env }))
  })

  // The refusal is on the basename, so any directory is covered. Deliberately
  // NOT probed with the real /usr/bin/security: if the guard ever regressed,
  // this self-test itself must not be the thing that reaches the live item.
  it('a bare `security` (PATH lookup) is refused', () => {
    expectRefused(() => execFileSync('security', LIVE_ARGS, { env }))
  })

  it('shell forms are refused: execSync, exec, sh -c, spawn with shell:true', () => {
    expectRefused(() => execSync('security find-generic-password -s com.marveen.vault -a master-key -w', { env }))
    expectRefused(() => exec('cd / && security delete-generic-password -s com.marveen.vault', { env }))
    expectRefused(() => execFileSync('/bin/sh', ['-c', 'security add-generic-password -U -s com.marveen.vault -a master-key -w x'], { env }))
    expectRefused(() => spawnSync('security add-generic-password -U -s com.marveen.vault', { env, shell: true }))
  })

  // The fake is named by its full path here, so even a regressed guard could
  // only reach the fake, never a `security` found on some other PATH entry.
  it('shell forms with options BEFORE the sub-command are refused (security -q / -i ...)', () => {
    expectRefused(() => execSync(`${fake} -q find-generic-password -s com.marveen.vault -w`, { env }))
    expectRefused(() => exec(`cd / && ${fake} -i delete-generic-password -s com.marveen.vault`, { env }))
    expectRefused(() => execFileSync('/bin/sh', ['-c', `${fake} -q add-generic-password -U -s com.marveen.vault -w x`], { env }))
    expectRefused(() => execFileSync('/bin/sh', ['-ec', `true; ${fake} -q -v find-generic-password -s x`], { env }))
    expectRefused(() => spawnSync(`${fake} -q find-generic-password -s com.marveen.vault`, { env, shell: true }))
    expectRefused(() => spawnSync('cd', ['/', '&&', fake, '-q', 'find-generic-password'], { env, shell: true }))
  })

  it('a plain argv that merely MENTIONS a security sub-command is data, not refused', () => {
    // not-security touches the marker: it really ran, nothing was refused.
    execFileSync(join(dir, 'not-security'), ['commit', '-m', 'docs: security add-generic-password note'], { env })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker, { force: true })
    spawnSync(join(dir, 'not-security'), ['-c', 'security -q find-generic-password'], { env })
    expect(existsSync(marker)).toBe(true)
  })

  it('the shell pattern itself: options allowed, a bare word or a flag-only call is not a sub-command', () => {
    expect(SECURITY_IN_SHELL.test('security -q find-generic-password')).toBe(true)
    expect(SECURITY_IN_SHELL.test('x=1; /usr/bin/security -i -v delete-generic-password')).toBe(true)
    expect(SECURITY_IN_SHELL.test('echo security review')).toBe(false)
    expect(SECURITY_IN_SHELL.test('docker --security-opt seccomp')).toBe(false)
  })

  it('the promisified execFile keeps its { stdout, stderr } shape and is guarded too', async () => {
    const run = promisify(execFile)
    const ok = await run(join(dir, 'not-security'), [], { env })
    expect(ok).toHaveProperty('stdout')
    expect(ok).toHaveProperty('stderr')
    rmSync(marker, { force: true })
    let code: string | undefined
    try {
      await run(fake, LIVE_ARGS, { env })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe(KEYCHAIN_GUARD_CODE)
    expect(existsSync(marker)).toBe(false)
  })

  it('a test-only service name is refused as well: no test spawns security at all', () => {
    expectRefused(() => execFileSync(fake, ['find-generic-password', '-s', 'com.marveen.vault.test-31a6', '-w'], { env }))
  })

  it('unrelated commands that merely mention the word are not refused', () => {
    execFileSync('/bin/sh', ['-c', 'echo security-review > /dev/null'], { env })
    execSync('echo "docker --security-opt" > /dev/null', { env })
  })
})
