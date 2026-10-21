import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Card 9a77b3e5 (B3): the lock on the permission bot's Vault entry lives in the
// storage layer (vault.ts), so a route that merely builds the same id -- the
// connectors slugify path -- cannot overwrite or delete it. The real vault runs
// against a throw-away project root; `claude mcp add` (execSync) is mocked.

const h = vi.hoisted(() => ({ root: '', exec: [] as string[] }))

vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  h.root = mkdtempSync(join(tmpdir(), 'vault-lock-test-'))
  mkdirSync(join(h.root, 'store'), { recursive: true })
  return { ...orig, PROJECT_ROOT: h.root }
})
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainStore: () => { throw new Error('no keychain in tests') },
  keychainRetrieveStatus: () => ({ status: 'empty' }),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execSync: (cmd: string) => { if (cmd.startsWith('which ')) return '/usr/bin/claude'; h.exec.push(cmd); return '' } }
})
vi.mock('../web/vault-bindings.js', () => ({
  syncSecret: () => ({ updated: 0, errors: [] }),
  removeBindingsForSecret: () => undefined,
  addBinding: () => undefined,
  syncAllBindings: () => ({}),
  listBindings: () => [],
}))
vi.mock('../db.js', () => ({ logConfigChange: () => undefined }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => undefined }))

const { setSecret, getSecret, deleteSecret, VaultEntryLockedError } = await import('../web/vault.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { PERMISSION_BOT_VAULT_ID } = await import('../web/permission-bot-vault.js')

const ORIGINAL_TOKEN = '7000000002:AAoriginalPermissionBotToken'

function fakeReq(body: unknown) {
  const bodyStr = JSON.stringify(body)
  return {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
}

async function post(path: string, body: unknown) {
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const ctx = {
    req: fakeReq(body) as unknown as http.IncomingMessage, res: res as http.ServerResponse,
    path, method: 'POST', url: new URL(`http://localhost${path}`), auth: { kind: 'token' },
  } as unknown as RouteContext
  expect(await tryHandleConnectors(ctx)).toBe(true)
  return out
}

beforeAll(() => {
  // The locked id cannot be written through setSecret, so provision it the way
  // the operator does: out-of-band. Write a normal entry, then relabel its id.
  setSecret('seed-entry', 'seed', ORIGINAL_TOKEN)
  const p = join(h.root, 'store', 'vault.json')
  const store = JSON.parse(readFileSync(p, 'utf-8'))
  store.entries[0].id = PERMISSION_BOT_VAULT_ID
  writeFileSync(p, JSON.stringify(store, null, 2))
})

beforeEach(() => { h.exec.length = 0 })

describe('vault.ts storage lock', () => {
  it('setSecret and deleteSecret refuse the id and its case/whitespace variants', () => {
    for (const id of [PERMISSION_BOT_VAULT_ID, ` ${PERMISSION_BOT_VAULT_ID} `, PERMISSION_BOT_VAULT_ID.toUpperCase()]) {
      expect(() => setSecret(id, 'x', 'swapped')).toThrow(VaultEntryLockedError)
      expect(() => deleteSecret(id)).toThrow(VaultEntryLockedError)
    }
    expect(getSecret(PERMISSION_BOT_VAULT_ID)).toBe(ORIGINAL_TOKEN)
  })

  it('other ids still write, read and delete', () => {
    setSecret('some-other-secret', 'o', 'v1')
    expect(getSecret('some-other-secret')).toBe('v1')
    expect(deleteSecret('some-other-secret')).toBe(true)
    expect(getSecret(PERMISSION_BOT_VAULT_ID)).toBe(ORIGINAL_TOKEN)
  })
})

describe('POST /api/connectors cannot reach the locked entry through slugify', () => {
  it('name "telegram-engedely-bot" with a TOKEN env is refused (403, not 500), nothing is installed, the token is unchanged', async () => {
    for (const name of ['telegram-engedely-bot', 'Telegram-Engedely-Bot']) {
      const out = await post('/api/connectors', {
        name, type: 'stdio', command: 'node', args: 'x.js', env: { TOKEN: '7000000099:AAswappedSECRET' },
      })
      expect(out.status).toBe(403)
      expect(out.body.error).toContain('locked')
    }
    expect(h.exec).toEqual([])
    expect(getSecret(PERMISSION_BOT_VAULT_ID)).toBe(ORIGINAL_TOKEN)
  })

  it('a different connector name still installs and vaults its secret', async () => {
    const out = await post('/api/connectors', {
      name: 'other-server', type: 'stdio', command: 'node', args: 'x.js', env: { TOKEN: 'abc' },
    })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(h.exec.length).toBe(1)
    expect(getSecret('other-server-token')).toBe('abc')
    expect(getSecret(PERMISSION_BOT_VAULT_ID)).toBe(ORIGINAL_TOKEN)
  })
})
