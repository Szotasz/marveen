import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Card 9a77b3e5 (B1): the permission-bot id is pinned outside the Bearer's
// reach (startup env / .env only, not the settings registry), and the Vault
// entry holding the bot's token cannot be written or deleted through the API.
// No network; the Vault and the DB are mocked, nothing is written to disk.

const vault = vi.hoisted(() => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(() => true),
}))

vi.mock('../web/vault.js', () => ({
  listSecrets: () => [],
  setSecret: vault.setSecret,
  deleteSecret: vault.deleteSecret,
  getSecret: () => null,
  getSecretsForEnv: () => ({}),
}))
vi.mock('../web/vault-bindings.js', () => ({
  syncSecret: () => ({ updated: 0, errors: [] }),
  removeBindingsForSecret: () => undefined,
  addBinding: () => undefined,
  syncAllBindings: () => ({}),
  listBindings: () => [],
}))
vi.mock('../db.js', () => ({ logConfigChange: () => undefined }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => undefined }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => 'unchanged' }))

const { resolvePermissionBotId } = await import('../config.js')
const { SETTINGS_REGISTRY } = await import('../config-registry.js')
const { setOverride } = await import('../settings-store.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { PERMISSION_BOT_VAULT_ID, isPermissionBotVaultId } = await import('../web/permission-bot-vault.js')

function fakeReq(body: unknown) {
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  return {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
}

async function call(handler: (ctx: RouteContext) => Promise<boolean>, method: string, path: string, body?: unknown) {
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const ctx = {
    req: fakeReq(body) as unknown as http.IncomingMessage, res: res as http.ServerResponse,
    path, method, url: new URL(`http://localhost${path}`), auth: { kind: 'token' },
  } as unknown as RouteContext
  expect(await handler(ctx)).toBe(true)
  return out
}

beforeEach(() => { vault.setSecret.mockClear(); vault.deleteSecret.mockClear() })

describe('PERMISSION_BOT_ID: read from the process env / .env only', () => {
  it('the process environment wins, then the .env value; digits only', () => {
    expect(resolvePermissionBotId('7000000002', '7000000003')).toBe('7000000002')
    expect(resolvePermissionBotId(undefined, '7000000003')).toBe('7000000003')
    expect(resolvePermissionBotId('  7000000002 ', undefined)).toBe('7000000002')
    expect(resolvePermissionBotId('', '7000000003')).toBe('7000000003')
  })

  it('missing or malformed is the empty string (every permission-bot path then fails closed)', () => {
    expect(resolvePermissionBotId(undefined, undefined)).toBe('')
    for (const bad of ['abc', '0', '012', '12 34', '12:AAtoken', '-5', '1'.repeat(17)]) {
      expect(resolvePermissionBotId(bad, undefined)).toBe('')
      // a malformed process value is not silently replaced by the .env one
      expect(resolvePermissionBotId(bad, '7000000003')).toBe('')
    }
  })

  it('the function takes no settings-override input: config-overrides.json cannot reach it', () => {
    expect(resolvePermissionBotId.length).toBe(2)
  })
})

describe('PERMISSION_BOT_ID cannot be set through the settings path', () => {
  it('is not in the settings registry', () => {
    expect(SETTINGS_REGISTRY.some(d => d.key === 'PERMISSION_BOT_ID')).toBe(false)
  })

  it('setOverride refuses it as an unknown key', () => {
    expect(setOverride('PERMISSION_BOT_ID', '7000000099')).toMatchObject({ ok: false })
  })

  it('POST /api/settings answers 404 for it and writes nothing', async () => {
    const out = await call(tryHandleSettings, 'POST', '/api/settings', { key: 'PERMISSION_BOT_ID', value: '7000000099' })
    expect(out.status).toBe(404)
  })
})

describe('the permission bot\'s Vault entry is locked against the API', () => {
  it('the predicate: the exact id, trimmed and case-insensitive; nothing else', () => {
    expect(isPermissionBotVaultId(PERMISSION_BOT_VAULT_ID)).toBe(true)
    expect(isPermissionBotVaultId(`  ${PERMISSION_BOT_VAULT_ID} `)).toBe(true)
    expect(isPermissionBotVaultId('Telegram-Engedely-Bot-Token')).toBe(true)
    expect(isPermissionBotVaultId('telegram-engedely-bot-token-2')).toBe(false)
    expect(isPermissionBotVaultId('TELEGRAM_BOT_TOKEN')).toBe(false)
    expect(isPermissionBotVaultId(undefined)).toBe(false)
  })

  it('POST /api/vault with that id is refused (403) and writes nothing; padded and upper-case spellings too', async () => {
    for (const id of [PERMISSION_BOT_VAULT_ID, ` ${PERMISSION_BOT_VAULT_ID}`, PERMISSION_BOT_VAULT_ID.toUpperCase()]) {
      const out = await call(tryHandleConnectors, 'POST', '/api/vault', { id, label: 'x', value: '7000000099:AAswappedSECRET' })
      expect(out.status).toBe(403)
      expect(out.body.error).toContain('locked')
    }
    expect(vault.setSecret).not.toHaveBeenCalled()
  })

  it('DELETE /api/vault/<id> is refused (403) and deletes nothing', async () => {
    const out = await call(tryHandleConnectors, 'DELETE', `/api/vault/${PERMISSION_BOT_VAULT_ID}`)
    expect(out.status).toBe(403)
    expect(vault.deleteSecret).not.toHaveBeenCalled()
  })

  it('POST /api/vault/import skips that vaultId and writes nothing for it', async () => {
    const out = await call(tryHandleConnectors, 'POST', '/api/vault/import', {
      imports: [{ serverName: 's', envVar: 'E', vaultId: PERMISSION_BOT_VAULT_ID, label: 'x', createBinding: false, targets: [] }],
    })
    expect(out.status).toBe(200)
    expect(out.body.imported).toBe(0)
    expect(out.body.errors.join(' ')).toContain('locked')
    expect(vault.setSecret).not.toHaveBeenCalled()
  })

  it('every other entry behaves as before: POST writes, DELETE deletes', async () => {
    const post = await call(tryHandleConnectors, 'POST', '/api/vault', { id: 'OTHER_SECRET', label: 'o', value: 'v' })
    expect(post.status).toBe(200)
    expect(post.body.ok).toBe(true)
    expect(vault.setSecret).toHaveBeenCalledWith('OTHER_SECRET', 'o', 'v')
    const del = await call(tryHandleConnectors, 'DELETE', '/api/vault/OTHER_SECRET')
    expect(del.status).toBe(200)
    expect(vault.deleteSecret).toHaveBeenCalledWith('OTHER_SECRET')
  })
})
