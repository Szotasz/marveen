// The import route validates the key with a trailing-newline-restored copy
// (needed for ssh-keygen to accept the PEM) but historically stored the raw,
// possibly newline-stripped client value. That passes ssh-keygen validation
// and returns 201, then fails later when something actually reads the stored
// key: an OpenSSH parser rejects a PEM without its closing newline. The gate
// here therefore checks the STORED value, not the response status.
import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-ssh-keys-import-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }
})

const { initDatabase, getVaultSshKey } = await import('../db.js')
const { tryHandleVaultSshKeys } = await import('../web/routes/vault-ssh-keys.js')
const { getSecret } = await import('../web/vault.js')

initDatabase(':memory:')

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

function freshPrivateKeyWithNewline(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-ssh-keys-fixture-'))
  const keyPath = join(dir, 'k')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'fixture'], { stdio: 'pipe' })
  return readFileSync(keyPath, 'utf-8')
}

describe('POST /api/vault/ssh-keys/import: stored value trailing newline', () => {
  it('stores the private key WITH its trailing newline even when the client body had it stripped', async () => {
    const withNewline = freshPrivateKeyWithNewline()
    expect(withNewline.endsWith('\n')).toBe(true)
    const stripped = withNewline.replace(/\n+$/, '')
    expect(stripped.endsWith('\n')).toBe(false)

    const { res, json } = await importKey(stripped)

    // Sanity: the request itself must succeed (this is NOT the bug surface).
    expect(res.statusCode).toBe(201)

    const id = json().key.id as string
    const row = getVaultSshKey(id)
    expect(row).toBeDefined()
    const stored = getSecret(row!.vault_key_id)

    // THE ACTUAL BUG SURFACE: the value that lands in the vault, not the
    // response code. A stored PEM without its closing newline is rejected by
    // OpenSSH's parser the next time it is actually used.
    expect(stored).not.toBeNull()
    expect(stored!.endsWith('\n')).toBe(true)
    expect(stored).toBe(withNewline)
  })
})
