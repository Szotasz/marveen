// The support routine's self-contained file, on its own: no node_modules, no
// compiled tree, only node. This is how the rescue path meets it on a machine
// whose install is half broken, so this check uses nothing but node either
// (node:test, node:assert) and runs the COMMITTED file.
//
//   node --test tests/support-standby/standalone-check.mjs
//
// CI runs it on the routine's lowest supported node (see
// SUPPORT_ROUTINE_MIN_NODE_MAJOR). It is not a vitest file on purpose: vitest
// would bring node_modules back in.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts', 'support-standby.mjs')
const routine = await import(FILE)

// TEST ONLY. A syntactically valid sk-ssh-ed25519 public blob made of the key
// bytes 1..32; no private half exists. The fingerprint is what `ssh-keygen -l`
// prints for it.
const TEST_ONLY_BLOB =
  'AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gAAAAGHNzaDptYXJ2ZWVuLXN1cHBvcnQtdGVzdA=='
const TEST_ONLY_FINGERPRINT = 'SHA256:LlwUFMfX2vt8uypcnNiigyXCVRNn7AQcmKfB/6k7/S0'
const GRANT = {
  keys: [{ name: 'key1', pub: TEST_ONLY_BLOB, fingerprint: TEST_ONLY_FINGERPRINT }],
  // A documentation address (RFC 5737).
  fromCidrs: ['203.0.113.7/32'],
  grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  consentVersion: 1,
  dispatchPath: '/home/marveen/.marveen/support-dispatch.sh',
  sshd: { major: 9, minor: 6 },
}
// The line, frozen as text: it must not change with the node version or with a rebuild.
const EXPECTED_LINE =
  'restrict,command="/bin/sh /home/marveen/.marveen/support-dispatch.sh --key key1 --fp ' +
  TEST_ONLY_FINGERPRINT +
  ' --grant 3f2504e0-4f89-41d3-9a0c-0305e82c3301 --consent 1",from="203.0.113.7/32",verify-required sk-ssh-ed25519@openssh.com ' +
  TEST_ONLY_BLOB +
  ' marveen-support:3f2504e0-4f89-41d3-9a0c-0305e82c3301:key1'
const PERSONAL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH someone'

function scratch() {
  return mkdtempSync(join(tmpdir(), 'support-standby-check-'))
}

test('runs on a node the routine supports', () => {
  const major = Number(/^v(\d+)\./.exec(process.version)[1])
  assert.ok(major >= routine.SUPPORT_ROUTINE_MIN_NODE_MAJOR, process.version + ' is below the routine minimum')
  assert.equal(routine.SUPPORT_ROUTINE_MIN_NODE_MAJOR, 20)
})

test('builds the one line, byte for byte', () => {
  assert.deepEqual(routine.buildSupportGrantLines(GRANT), [EXPECTED_LINE])
})

test('refuses a source that is not one exact host', () => {
  assert.throws(() => routine.buildSupportGrantLines({ ...GRANT, fromCidrs: ['203.0.113.0/24'] }), { code: 'pins_invalid' })
  assert.throws(() => routine.buildSupportGrantLines({ ...GRANT, sshd: { major: 8, minor: 2 } }), { code: 'sshd_too_old' })
})

test('writes the line, keeps every other byte, and takes the line out again', async () => {
  const root = scratch()
  try {
    const sshDir = join(root, '.ssh')
    mkdirSync(sshDir, { mode: 0o700 })
    // Another owner's line with bytes that are not valid UTF-8.
    const foreign = Buffer.concat([Buffer.from(PERSONAL, 'latin1'), Buffer.from([0x20, 0xe9, 0xff, 0x0a])])
    writeFileSync(join(sshDir, 'authorized_keys'), foreign, { mode: 0o600 })
    const pinnedBlobs = new Set([TEST_ONLY_BLOB])

    const granted = await routine.grantSupportLines({ sshDir, pinnedBlobs, grant: GRANT })
    assert.equal(granted.replaced, 0)
    const after = readFileSync(join(sshDir, 'authorized_keys'))
    assert.ok(after.equals(Buffer.concat([foreign, Buffer.from(EXPECTED_LINE + '\n', 'latin1')])))
    assert.equal(statSync(join(sshDir, 'authorized_keys')).mode & 0o777, 0o600)

    const revoked = await routine.revokeSupportLines({ sshDir, pinnedBlobs })
    assert.equal(revoked.removed, 1)
    assert.ok(readFileSync(join(sshDir, 'authorized_keys')).equals(foreign))
    assert.deepEqual(readdirSync(sshDir), ['authorized_keys'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('`status` runs as a program, exits with 0 and writes nothing', () => {
  const home = scratch()
  try {
    const run = spawnSync(process.execPath, [FILE, 'status'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 30000 })
    assert.equal(run.stderr, '')
    assert.equal(run.status, 0)
    const lines = run.stdout.trimEnd().split('\n')
    assert.deepEqual(lines.slice(0, 6), [
      'node=ok',
      'node_version=' + process.version,
      'node_minimum=20',
      'pins=support_keys_unset',
      'sshd=not_asked',
      'sshd_version=unknown',
    ])
    assert.deepEqual(lines.slice(7), ['support_lines=absent', 'support_lines_second_file=absent'])
    assert.deepEqual(readdirSync(home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unknown subcommand exits with 2', () => {
  const home = scratch()
  try {
    const run = spawnSync(process.execPath, [FILE, 'bogus'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 30000 })
    assert.equal(run.status, 2)
    assert.equal(run.stdout, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
