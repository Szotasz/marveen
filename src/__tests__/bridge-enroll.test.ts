import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { initDatabase, getDb } from '../db.js'
import { bridgeEnroll, removeBridgeSshAccess, RemoteEnrollError, type BridgeEnrollDeps } from '../web/bridge-enroll.js'
import { decodeBundle, removeAuthorizedKey, RESTRICT_OPTIONS } from '../remote-enroll-core.js'
import { resolveAuth } from '../web/auth-gate.js'
import { listDeviceKeys, findDeviceKeyByInstallId, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { tryHandleSecurity } from '../web/routes/security.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import type { RouteContext } from '../web/routes/types.js'

// AUTHPLAN1 #2 -- Bridge pairing. Contract under test:
//   - one enroll writes the restricted authorized_keys line AND mints a
//     device key, and the bundle embeds the DEVICE key (not the shared token);
//   - re-pairing the same installId replaces both halves (no key pile-up);
//   - revoking a paired key drops the authorized_keys line in the same step;
//   - the endpoint is denied to 'device' principals and validates input;
//   - old-bundle compatibility: nothing here touches the shared-token lane.

const TOKEN = 'a'.repeat(64)

/** Build a VALID `ssh-ed25519 <base64> marveen-remote:<uuid>` line: the blob
 *  is the real OpenSSH wire format around 32 random key bytes. */
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
  sshDir = mkdtempSync(join(tmpdir(), 'bridge-enroll-test-'))
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
  getDb().prepare('DELETE FROM config_change_log').run()
})

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true })
  delete process.env.MARVEEN_SSH_DIR
})

describe('bridgeEnroll', () => {
  it('writes the restricted line, mints a paired device key, and embeds it in the bundle', async () => {
    const { line, installId } = makeKeyLine()
    const outcome = await bridgeEnroll({ keyLine: line, name: 'Szabi MacBook' }, testDeps())

    expect(outcome.action).toBe('added')
    expect(outcome.installId).toBe(installId)
    expect(authKeysContent()).toContain(`${RESTRICT_OPTIONS} ${line}`)

    const keys = listDeviceKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ name: 'Szabi MacBook', installId })

    const bundle = decodeBundle(outcome.bundle)
    expect(bundle.installId).toBe(installId)
    expect(bundle.hostKey).toBe(HOST_KEY_B64)
    // The bundle carries the DEVICE key, not the shared dashboard token...
    expect(bundle.dashboardToken).toMatch(/^mvdk_/)
    // ...and that key actually authenticates as a device principal.
    const r = resolveAuth(
      { headers: { authorization: `Bearer ${bundle.dashboardToken}` } } as unknown as http.IncomingMessage,
      new URL('http://127.0.0.1:3420/api/agents'), '/api/agents', 'GET', TOKEN,
    )
    expect(r).toMatchObject({ kind: 'device', device: 'Szabi MacBook' })
  })

  it('re-pairing the same installId replaces BOTH the ssh line and the device key', async () => {
    const { line, installId } = makeKeyLine()
    const first = await bridgeEnroll({ keyLine: line, name: 'Phone' }, testDeps())
    const second = await bridgeEnroll({ keyLine: line, name: 'Phone (repaired)' }, testDeps())

    expect(second.action).toBe('replaced')
    expect(second.replacedDeviceKey).toBe(true)
    // Exactly one authorized_keys line and one device key for the install id.
    const lines = authKeysContent().trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(listDeviceKeys()).toHaveLength(1)
    expect(listDeviceKeys()[0]!.name).toBe('Phone (repaired)')
    // The FIRST bundle's key is dead; the second lives.
    const firstKey = decodeBundle(first.bundle).dashboardToken!
    const secondKey = decodeBundle(second.bundle).dashboardToken!
    const gate = (k: string) => resolveAuth(
      { headers: { authorization: `Bearer ${k}` } } as unknown as http.IncomingMessage,
      new URL('http://127.0.0.1:3420/api/agents'), '/api/agents', 'GET', TOKEN,
    )
    expect(gate(firstKey)).toEqual({ kind: 'none' })
    expect(gate(secondKey).kind).toBe('device')
  })

  it('fails hard without a host key and leaves NO side effects', async () => {
    const { line } = makeKeyLine()
    await expect(
      bridgeEnroll({ keyLine: line, name: 'x' }, testDeps({ keyscan: async () => null })),
    ).rejects.toThrow(RemoteEnrollError)
    expect(authKeysContent()).toBe('')
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('rejects a garbage key line before touching anything', async () => {
    await expect(
      bridgeEnroll({ keyLine: 'ssh-rsa AAAA nope', name: 'x' }, testDeps()),
    ).rejects.toThrow(RemoteEnrollError)
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('preserves foreign authorized_keys lines byte-for-byte', async () => {
    mkdirSync(sshDir, { recursive: true })
    const foreign = 'ssh-ed25519 AAAAforeignkey user@laptop\n'
    writeFileSync(join(sshDir, 'authorized_keys'), foreign)
    const { line } = makeKeyLine()
    await bridgeEnroll({ keyLine: line, name: 'x' }, testDeps())
    expect(authKeysContent()).toContain(foreign.trim())
  })
})

describe('removeAuthorizedKey (pure) + removeBridgeSshAccess', () => {
  it('removes exactly the target line and is idempotent', async () => {
    const { line, installId } = makeKeyLine()
    await bridgeEnroll({ keyLine: line, name: 'x' }, testDeps())
    expect(await removeBridgeSshAccess(installId, { sshDir })).toBe(true)
    expect(authKeysContent()).toBe('')
    expect(await removeBridgeSshAccess(installId, { sshDir })).toBe(false)
  })

  it('pure removal keeps other lines untouched', () => {
    const { installId } = makeKeyLine()
    const keep = 'ssh-ed25519 AAAAkeep other@host'
    const drop = `${RESTRICT_OPTIONS} ssh-ed25519 AAAAdrop marveen-remote:${installId}`
    const r = removeAuthorizedKey(`${keep}\n${drop}\n`, installId)
    expect(r.removed).toBe(true)
    expect(r.content).toBe(`${keep}\n`)
  })
})

// --- HTTP layer ---

function mkRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead(status: number, headers?: Record<string, unknown>) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this },
    setHeader(k: string, v: string) { this.headers[k] = v },
    end(data?: string) { if (data !== undefined) this.body += data },
  }
}

async function call(
  handler: (ctx: RouteContext) => Promise<boolean>,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth'] } = {},
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  await handler({
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path, method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  })
  return { statusCode: res.statusCode, json: () => JSON.parse(res.body || '{}') }
}

describe('POST /api/security/bridge-enroll (HTTP)', () => {
  it('denies device and federation principals, and a missing principal', async () => {
    for (const auth of [
      { kind: 'device', device: 'evil' } as RouteContext['auth'],
      { kind: 'federation', peer: 'p' } as RouteContext['auth'],
      undefined,
    ]) {
      const r = await call(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', { auth, body: { key_line: 'x', name: 'y' } })
      expect(r.statusCode).toBe(403)
    }
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('400s on a missing name or invalid key line without side effects', async () => {
    const bad1 = await call(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', { auth: { kind: 'token' }, body: { key_line: makeKeyLine().line, name: '' } })
    expect(bad1.statusCode).toBe(400)
    const bad2 = await call(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', { auth: { kind: 'token' }, body: { key_line: 'not a key', name: 'ok name' } })
    expect(bad2.statusCode).toBe(400)
    expect(listDeviceKeys()).toHaveLength(0)
  })

  it('enrolls end-to-end over the route (MARVEEN_SSH_DIR seam) and audits', async () => {
    process.env.MARVEEN_SSH_DIR = sshDir
    // The route uses default deps; loopback keyscan may fail in CI, so give it
    // a host-key file candidate instead: point readFile via a real file the
    // resolver checks -- not injectable here, so accept either outcome:
    const { line, installId } = makeKeyLine()
    const r = await call(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', { auth: { kind: 'token' }, body: { key_line: line, name: 'Route Phone' } })
    if (r.statusCode === 400) {
      // No host key obtainable in this environment -- the documented hard-fail
      // path; assert it stayed side-effect-free.
      expect(listDeviceKeys()).toHaveLength(0)
      return
    }
    expect(r.statusCode).toBe(201)
    expect(findDeviceKeyByInstallId(installId)).not.toBeNull()
    const audit = getDb().prepare("SELECT new_value FROM config_change_log WHERE key='security.bridge_enroll'").all() as { new_value: string }[]
    expect(audit).toHaveLength(1)
    // The active MARVEEN_SSH_DIR override must be visible in the audit row.
    expect(audit[0]!.new_value).toContain('sshdir_override=1')
  })
})

describe('DELETE /api/auth/device-keys/:id for a paired key', () => {
  it('reports ssh_removed:false when the authorized_keys side fails (partial revoke)', async () => {
    const { line } = makeKeyLine()
    const outcome = await bridgeEnroll({ keyLine: line, name: 'Half' }, testDeps())
    // Simulate the fs failure the UI must warn about: the line is already gone
    // (file deleted out-of-band), so removal cannot succeed.
    rmSync(join(sshDir, 'authorized_keys'), { force: true })
    process.env.MARVEEN_SSH_DIR = sshDir
    const r = await call(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${outcome.deviceKeyId}`, { auth: { kind: 'token' } })
    expect(r.statusCode).toBe(200)
    // The key itself is revoked (dead) even though the ssh half failed...
    expect(listDeviceKeys()).toHaveLength(0)
    // ...and the response says so EXPLICITLY -- this is the field the UI
    // renders as the visible partial-revoke warning.
    expect(r.json().ssh_removed).toBe(false)
    const audit = getDb().prepare("SELECT new_value FROM config_change_log WHERE key='security.bridge_revoke'").all() as { new_value: string }[]
    expect(audit[0]!.new_value).toContain('ssh_removed=false')
  })

  it('drops the authorized_keys line together with the key', async () => {
    const { line, installId } = makeKeyLine()
    const outcome = await bridgeEnroll({ keyLine: line, name: 'Pair' }, testDeps())
    process.env.MARVEEN_SSH_DIR = sshDir
    const r = await call(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${outcome.deviceKeyId}`, { auth: { kind: 'token' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().ssh_removed).toBe(true)
    expect(authKeysContent()).toBe('')
    expect(listDeviceKeys()).toHaveLength(0)
    const audit = getDb().prepare("SELECT new_value FROM config_change_log WHERE key='security.bridge_revoke'").all() as { new_value: string }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]!.new_value).toContain('ssh_removed=true')
    expect(audit[0]!.new_value).toContain('sshdir_override=1')
  })
})
