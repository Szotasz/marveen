import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

// INSTUX1 regression (Marveen msg 23503): BOTH enroll paths must follow the
// install's real WEB_PORT into the permitopen restriction AND the connection
// bundle. The original defect: the enrolled key's permitopen targeted a
// hardcoded 3420 while the dashboard ran elsewhere -- the tunnel opened a dead
// port and the app said "dashboard not running" forever.
//
// Everything here runs on a NON-DEFAULT port (3421). Asserting on 3420 proves
// nothing: that is exactly where the hardcode and the variable coincide
// (PORTCHAIN1's own header). The PORTCHAIN1 suite covers ten other callers but
// NOT these two enroll paths, and RESTRICT_OPTIONS-shaped assertions in
// bridge-enroll.test.ts are 3420-shaped for the same reason.
//
// NEGATIVE CONTROL (performed by hand before merge, both flips, then reverted):
//   - defaultWebPort() body replaced with `return REMOTE_PORT`  -> the CLI
//     test below goes RED (3420 !== 3421);
//   - bridge-enroll.ts:189 reverted to `buildRestrictedLine(parsed)` and
//     :209 to `webPort: REMOTE_PORT` -> the bridge tests below go RED.
// A test that stays green under the restored hardcode would not be measuring
// the fix; the flip results are recorded in the PR.

const PORT = 3421

// The config mock must be in place BEFORE bridge-enroll.js (and the CLI
// module) resolve their imports. Everything else in config is the real value:
// only WEB_PORT simulates an install whose .env selects a non-default port.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  WEB_PORT: 3421,
}))

import { initDatabase, getDb } from '../db.js'
import { bridgeEnroll, type BridgeEnrollDeps } from '../web/bridge-enroll.js'
import { decodeBundle } from '../remote-enroll-core.js'
import { _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'

const ROOT = join(__dirname, '..', '..')

function makeKeyLine(installId = randomUUID()): { line: string; installId: string } {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const key = randomBytes(32)
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, 32]), key,
  ])
  return { line: `ssh-ed25519 ${blob.toString('base64')} marveen-remote:${installId}`, installId }
}

const HOST_KEY_B64 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519', 'utf8'),
  Buffer.from([0, 0, 0, 32]), randomBytes(32),
]).toString('base64')

let sshDir: string

function testDeps(overrides: Partial<BridgeEnrollDeps> = {}): BridgeEnrollDeps {
  return {
    sshDir,
    readFile: () => null,
    keyscan: async () => `127.0.0.1 ssh-ed25519 ${HOST_KEY_B64}`,
    ...overrides,
  }
}

function authKeysContent(): string {
  const p = join(sshDir, 'authorized_keys')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), 'enroll-port-test-'))
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
  getDb().prepare('DELETE FROM config_change_log').run()
})

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true })
})

describe('INSTUX1: enroll paths follow WEB_PORT on a NON-default port', () => {
  it('CLI defaultWebPort() resolves 3421 from a sandbox .env through the REAL config chain', () => {
    // Subprocess on purpose: CLAUDECLAW_ENV_DIR (env.ts test escape hatch) is
    // read at import time, so a fresh tsx process exercises the FULL
    // resolution the CLI really uses (.env -> config.WEB_PORT ->
    // defaultWebPort) with no mock in the path. The import-guard keeps main()
    // from running on import.
    const dir = mkdtempSync(join(tmpdir(), 'enroll-cli-env-'))
    try {
      writeFileSync(join(dir, '.env'), `WEB_PORT=${PORT}\n`)
      const script = join(ROOT, 'scripts', 'remote-access-enroll.ts')
      const out = execFileSync(
        join(ROOT, 'node_modules', '.bin', 'tsx'),
        ['-e', `import(${JSON.stringify(script)}).then(m => console.log(m.defaultWebPort()))`],
        { env: { ...process.env, CLAUDECLAW_ENV_DIR: dir }, encoding: 'utf-8', timeout: 30_000 },
      ).trim()
      expect(out).toBe(String(PORT))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CLI wiring: args.webPort feeds BOTH the restricted line and the bundle (source pin)', () => {
    // main() cannot be executed here without a live sshd/host key, so the two
    // call sites that carry defaultWebPort() into the outputs are pinned in
    // source. The executed half above plus these pins together go red on the
    // historical defect shape (webPort ignored / restricted line built on the
    // default): verified by the negative-control flips in the header.
    const src = readFileSync(join(ROOT, 'scripts', 'remote-access-enroll.ts'), 'utf8')
    expect(src).toMatch(/webPort: defaultWebPort\(\)/)
    expect(src).toMatch(/buildRestrictedLine\(parsed, args\.webPort\)/)
    expect(src).toMatch(/webPort: args\.webPort/)
  })

  it('bridge pairing writes permitopen on 3421 and NO 3420 anywhere in authorized_keys', async () => {
    const { line } = makeKeyLine()
    const outcome = await bridgeEnroll({ keyLine: line, name: 'Port próba' }, testDeps())
    expect(outcome.action).toBe('added')
    const content = authKeysContent()
    expect(content).toContain(`permitopen="127.0.0.1:${PORT}"`)
    expect(content).not.toContain(':3420')
  })

  it('bridge pairing embeds 3421 as the bundle remotePort', async () => {
    const { line } = makeKeyLine()
    const outcome = await bridgeEnroll({ keyLine: line, name: 'Port próba' }, testDeps())
    const bundle = decodeBundle(outcome.bundle)
    expect(bundle.remotePort).toBe(PORT)
  })

  it('the import-guard still runs main() through a SYMLINKED absolute path (realpath guard)', () => {
    // Marveen review (msg 23506, measured): a bare URL comparison silently
    // no-ops on a symlinked ABSOLUTE invocation -- exit 0, zero output, which
    // the installer reads as "no bundle": the exact silent-failure family of
    // this card. The guard therefore realpaths both sides; this test invokes
    // that precise shape. main() running shows as the usage error on stderr
    // with exit 1 -- a silent guard shows as exit 0 with neither.
    // Negative control (performed and reverted): argv[1] left un-realpathed
    // in the guard -> this test goes RED (exit 0, empty stderr).
    const dir = mkdtempSync(join(tmpdir(), 'enroll-symlink-'))
    try {
      symlinkSync(ROOT, join(dir, 'repo'))
      const script = join(dir, 'repo', 'scripts', 'remote-access-enroll.ts')
      let stderr = ''
      let status = 0
      try {
        execFileSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [script], {
          encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        const err = e as { status?: number; stderr?: string }
        status = err.status ?? -1
        stderr = err.stderr ?? ''
      }
      expect(status).toBe(1)
      expect(stderr).toContain('missing public key line')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
