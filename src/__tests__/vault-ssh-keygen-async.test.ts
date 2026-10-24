// ssh-keygen must run off the event loop, with stdin closed. A fake ssh-keygen
// on PATH records its argv, optionally sleeps / reads stdin, then execs the real one.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-ssh-keygen-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }
})

const REAL = execFileSync('which', ['ssh-keygen'], { encoding: 'utf-8' }).trim()
const ORIGINAL_PATH = process.env.PATH
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
writeFileSync(join(binDir, 'ssh-keygen'), `#!/bin/sh
d="$FAKE_KEYGEN_DIR"
n=$(cat "$d/n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/n"
: > "$d/argv.$n"
for a in "$@"; do printf '%s\\n' "$a" >> "$d/argv.$n"; done
if [ -n "$FAKE_READ_STDIN" ]; then cat > /dev/null; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exec ${REAL} "$@"
`)
chmodSync(join(binDir, 'ssh-keygen'), 0o755)
process.env.PATH = `${binDir}:${ORIGINAL_PATH}`

beforeEach(() => {
  process.env.FAKE_KEYGEN_DIR = mkdtempSync(join(tmpRoot, 'fake-'))
})
afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_READ_STDIN
})
afterAll(() => {
  process.env.PATH = ORIGINAL_PATH
  rmSync(tmpRoot, { recursive: true, force: true })
})

function argvOf(n: number): string[] {
  const text = readFileSync(join(process.env.FAKE_KEYGEN_DIR!, `argv.${n}`), 'utf-8')
  return text.replace(/\n$/, '').split('\n')
}

const { initDatabase } = await import('../db.js')
const { generateSshKeyPair, extractPublicKeyFromVault, tryHandleVaultSshKeys } = await import('../web/routes/vault-ssh-keys.js')
const { setSecret } = await import('../web/vault.js')

initDatabase(':memory:')

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}
const STALL_MAX_MS = 750

interface MockRes {
  statusCode: number
  body: string
  writeHead(status: number): MockRes
  end(data?: string): void
}
function mkRes(): MockRes {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    end(data) { if (data !== undefined) this.body += data },
  }
}

async function importKey(privateKey: string) {
  const payload = Buffer.from(JSON.stringify({ label: 'test-key', username: 'deploy', privateKey }))
  const req = Readable.from([payload]) as unknown as http.IncomingMessage
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path: '/api/vault/ssh-keys/import',
    method: 'POST',
    url: new URL('http://127.0.0.1:3420/api/vault/ssh-keys/import'),
  }
  await tryHandleVaultSshKeys(ctx)
  return { res, json: () => JSON.parse(res.body || '{}') }
}

describe('ssh-keygen runs asynchronously', () => {
  it('instrument positive control: a synchronous busy-wait is measured', async () => {
    const stall = await stallDuring(async () => {
      const end = Date.now() + 300
      while (Date.now() < end) { /* busy */ }
    })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('generateSshKeyPair does not stall the event loop', async () => {
    process.env.FAKE_SLEEP = '1.5'
    let kp!: Awaited<ReturnType<typeof generateSshKeyPair>>
    const stall = await stallDuring(async () => { kp = await generateSshKeyPair('t@h') })
    expect(kp.privateKey).toMatch(/^-{5}BEGIN OPENSSH PRIVATE KEY-{5}\n/)
    expect(kp.publicKey).toMatch(/^ssh-ed25519 \S+ t@h$/)
    expect(kp.fingerprint).toMatch(/^SHA256:/)
    const argv = argvOf(1)
    expect(argv).toHaveLength(8)
    expect(argv[3].endsWith('/key')).toBe(true)
    expect([...argv.slice(0, 3), ...argv.slice(4)]).toEqual(['-t', 'ed25519', '-f', '-N', '', '-C', 't@h'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('extractPublicKeyFromVault does not stall the event loop', async () => {
    const kp = await generateSshKeyPair('v@h')
    setSecret('ssh-key-t1', 'test', kp.privateKey)
    process.env.FAKE_SLEEP = '1.5'
    let pub: string | null = null
    const stall = await stallDuring(async () => { pub = await extractPublicKeyFromVault('ssh-key-t1') })
    expect(pub).toBe(kp.publicKey)
    expect(stall).toBeLessThan(STALL_MAX_MS)
    expect(await extractPublicKeyFromVault('ssh-key-missing')).toBeNull()
  })

  it('import route rejects an invalid key with ssh-keygen message, without stalling', async () => {
    process.env.FAKE_SLEEP = '1.5'
    let result!: Awaited<ReturnType<typeof importKey>>
    const stall = await stallDuring(async () => { result = await importKey('not a key') })
    expect(result.res.statusCode).toBe(400)
    const err = result.json().error as string
    expect(err.startsWith('Invalid private key: ')).toBe(true)
    expect(err.length).toBeGreaterThan('Invalid private key: '.length)
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('closes stdin so a stdin-reading ssh-keygen settles', async () => {
    process.env.FAKE_READ_STDIN = '1'
    const outcome = await Promise.race([generateSshKeyPair('s@h'), sleep(5000).then(() => 'timeout' as const)])
    expect(outcome).not.toBe('timeout')
    expect((outcome as { publicKey: string }).publicKey).toMatch(/^ssh-ed25519 \S+ s@h$/)
  })
})
