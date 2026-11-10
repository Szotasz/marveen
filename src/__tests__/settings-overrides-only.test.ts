// ENVRELAXGATE1104 step 2: an overrides-only (security) key takes its .env line only when that line TIGHTENS the
// registry default. The .env can be written without the dashboard's owner check, so it must never loosen a control;
// the owner's override still applies either way, a loosening one too (Samu 67933). The ignored lines and an unreadable
// overrides file are made visible: the Settings page, the boot log, and one owner notice per overrides state change.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const SANDBOX = mkdtempSync(join(tmpdir(), 'settings-overrides-only-'))
const STORE = join(SANDBOX, 'store')
const ROOT = join(__dirname, '..', '..')

const envFile: Record<string, string> = {}

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) => Object.fromEntries(Object.entries(envFile).filter(([k]) => !keys || keys.includes(k))),
  }
})
vi.mock('../db.js', () => ({ logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => 'unchanged' }))

const store = await import('../settings-store.js')
const registry = await import('../config-registry.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')
const health = await import('../settings-health.js')
const { cfg } = await import('../config.js')

function call(method: string, path: string): { ctx: any; out: { status: number; body: any; raw: string } } {
  const out: { status: number; body: any; raw: string } = { status: 0, body: null, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const req: any = { on(event: string, cb: () => void) { if (event === 'end') cb() } }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`) }, out }
}
async function getSettings(): Promise<{ body: any; raw: string }> {
  const { ctx, out } = call('GET', '/api/settings')
  await tryHandleSettings(ctx)
  return out
}
const listedFrom = (body: any, key: string) => body.settings.find((s: any) => s.key === key)

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(store.OVERRIDES_PATH)) rmSync(store.OVERRIDES_PATH)
  store.reloadOverridesForTest()
  for (const k of Object.keys(envFile)) delete envFile[k]
})

describe('registry: which keys are overrides-only', () => {
  it('every key with a loosens function is overrides-only (inventory), BASH_EGRESS_HOST_ALLOW among them', () => {
    const withLoosens = registry.SETTINGS_REGISTRY.filter((d) => typeof d.loosens === 'function')
    expect(withLoosens.length).toBeGreaterThanOrEqual(8)
    for (const def of withLoosens) expect(registry.isOverridesOnly(def), def.key).toBe(true)
    expect(withLoosens.map((d) => d.key)).toContain('BASH_EGRESS_HOST_ALLOW')
    expect(withLoosens.map((d) => d.key)).toContain('NOTIFY_SLACK_ALERT_TARGET')
    expect(withLoosens.map((d) => d.key)).toContain('OWNER_DRIVE_FOLDER')
    expect(withLoosens.map((d) => d.key)).toContain('SCHEDULED_DELIVERY_CHANNEL')
  })

  it('BASH_EGRESS_HOST_ALLOW: switching it on loosens, switching it off does not', () => {
    const def = registry.getSettingDefinition('BASH_EGRESS_HOST_ALLOW')!
    expect(def.loosens!('0', '1')).toBe(true)
    expect(def.loosens!('1', '0')).toBe(false)
    expect(def.loosens!('1', '1')).toBe(false)
  })

  it('the explicit flag and the security module make a key overrides-only; a plain key is not', () => {
    const plain = { key: 'X', type: 'string', default: 'a', description: '', module: 'kanban', secret: false, requiresRestart: false } as const
    expect(registry.isOverridesOnly({ ...plain })).toBe(false)
    expect(registry.isOverridesOnly({ ...plain, overridesOnly: true })).toBe(true)
    expect(registry.isOverridesOnly({ ...plain, module: 'security' })).toBe(true)
    // A key with no loosens cannot tell a tightening line from a loosening one: its .env never counts.
    expect(registry.envValueTightens({ ...plain, module: 'security' }, 'b')).toBe(false)
  })
})

describe('store: override > .env (only if it tightens) > default', () => {
  it('a loosening .env line is IGNORED: the default answers', () => {
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    envFile.APPROVAL_SLACK_REACTIONS = 'on'
    envFile.BASH_EGRESS_HOST_ALLOW = '1'
    envFile.SLACK_OWNER_USER_ID = 'U0SOMEONE'
    envFile.NOTIFY_SLACK_ALERT_TARGET = 'D0ALERTSELSEWHERE'
    envFile.OWNER_DRIVE_FOLDER = 'FOLDERELSEWHERE'
    envFile.SCHEDULED_DELIVERY_CHANNEL = 'slack:D0ELSEWHERE'
    expect(store.getEffectiveSettingSource('OWNER_DRIVE_FOLDER')).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingSource('SCHEDULED_DELIVERY_CHANNEL')).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingSource('NOTIFY_SLACK_ALERT_TARGET')).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingSource('NOTIFY_SLACK_TARGET')).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingSource('APPROVAL_SLACK_REACTIONS')).toEqual({ value: 'off', source: 'default' })
    expect(store.getEffectiveSettingSource('BASH_EGRESS_HOST_ALLOW')).toEqual({ value: '0', source: 'default' })
    expect(store.getEffectiveSettingSource('SLACK_OWNER_USER_ID')).toEqual({ value: '', source: 'default' })
  })

  it('a tightening .env line still counts (the two documented ones, and adding an agent to the sandbox list)', () => {
    envFile.AGENT_TOKENS = '1'
    envFile.VAULT_ACL_MODE = 'enforce'
    envFile.SKILL_QUARANTINE = '1'
    envFile.BASH_SANDBOX_AGENTS = 'samu,dani'
    expect(store.getEffectiveSettingSource('AGENT_TOKENS')).toEqual({ value: '1', source: 'env' })
    expect(store.getEffectiveSettingSource('VAULT_ACL_MODE')).toEqual({ value: 'enforce', source: 'env' })
    expect(store.getEffectiveSettingSource('SKILL_QUARANTINE')).toEqual({ value: '1', source: 'env' })
    expect(store.getEffectiveSettingSource('BASH_SANDBOX_AGENTS')).toEqual({ value: 'samu,dani', source: 'env' })
  })

  it('the owner\'s override applies over a tightening .env line, a LOOSENING override too (Samu 67933)', () => {
    envFile.VAULT_ACL_MODE = 'enforce'
    expect(store.setOverride('VAULT_ACL_MODE', 'audit').ok).toBe(true)
    expect(store.getEffectiveSettingSource('VAULT_ACL_MODE')).toEqual({ value: 'audit', source: 'override' })
    expect(store.setOverride('APPROVAL_SLACK_REACTIONS', 'on').ok).toBe(true)
    expect(store.getEffectiveSettingSource('APPROVAL_SLACK_REACTIONS')).toEqual({ value: 'on', source: 'override' })
  })

  it('KONTROLL: a key that is not overrides-only takes its .env line as before, loosening or not', () => {
    envFile.KANBAN_WIP_WARN_PCT = '70'
    expect(store.getEffectiveSettingSource('KANBAN_WIP_WARN_PCT')).toEqual({ value: 70, source: 'env' })
  })

  it('an unreadable overrides file: the default answers, a tightening .env line still counts, a loosening one does not', () => {
    writeFileSync(store.OVERRIDES_PATH, '{ not json')
    store.reloadOverridesForTest()
    envFile.AGENT_TOKENS = '1'
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    expect(store.getOverridesFileState().state).toBe('unreadable')
    expect(store.getEffectiveSettingSource('AGENT_TOKENS')).toEqual({ value: '1', source: 'env' })
    expect(store.getEffectiveSettingSource('NOTIFY_SLACK_TARGET')).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingSource('VAULT_ACL_MODE')).toEqual({ value: 'audit', source: 'default' })
  })

  it('the reset target (getSettingFallback) follows the same rule', () => {
    store.setOverride('NOTIFY_SLACK_TARGET', 'D0OWNER')
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    expect(store.getSettingFallback('NOTIFY_SLACK_TARGET')).toEqual({ value: '', source: 'default' })
    store.setOverride('AGENT_TOKENS', '0')
    envFile.AGENT_TOKENS = '1'
    expect(store.getSettingFallback('AGENT_TOKENS')).toEqual({ value: '1', source: 'env' })
  })

  it('getIgnoredEnvKeys names exactly the ignored lines, in registry order, names only', () => {
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    envFile.BASH_EGRESS_HOST_ALLOW = '1'
    envFile.AGENT_TOKENS = '1'
    envFile.KANBAN_WIP_WARN_PCT = '70'
    const order = registry.SETTINGS_REGISTRY.map((d) => d.key)
    const ignored = store.getIgnoredEnvKeys()
    expect([...ignored].sort()).toEqual(['BASH_EGRESS_HOST_ALLOW', 'NOTIFY_SLACK_TARGET'])
    expect(ignored).toEqual([...ignored].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    expect(store.isEnvValueIgnored('NOTIFY_SLACK_TARGET')).toBe(true)
    expect(store.isEnvValueIgnored('AGENT_TOKENS')).toBe(false)
    expect(store.isEnvValueIgnored('KANBAN_WIP_WARN_PCT')).toBe(false)
  })

  it('getOverridesOnlyKeys lists every overrides-only key', () => {
    const keys = store.getOverridesOnlyKeys()
    expect(keys).toContain('VAULT_ACL_MODE')
    expect(keys).toContain('BASH_EGRESS_HOST_ALLOW')
    expect(keys).not.toContain('KANBAN_WIP_WARN_PCT')
  })
})

describe('GET /api/settings: the envIgnored marker and the overrides file state', () => {
  it('marks an ignored .env line, never sending its value', async () => {
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    envFile.AGENT_TOKENS = '1'
    const { body, raw } = await getSettings()
    expect(listedFrom(body, 'NOTIFY_SLACK_TARGET')).toMatchObject({ envIgnored: true, value: '', source: 'default' })
    expect(listedFrom(body, 'AGENT_TOKENS')).toMatchObject({ envIgnored: false, value: '1', source: 'env' })
    expect(listedFrom(body, 'KANBAN_WIP_WARN_PCT').envIgnored).toBe(false)
    expect(raw).not.toContain('D0ROUTEELSEWHERE')
  })

  it('reports the overrides file state: missing, readable, unreadable with its cause', async () => {
    expect((await getSettings()).body.overridesFile).toEqual({ state: 'missing' })
    store.setOverride('KANBAN_WIP_WARN_PCT', 55)
    expect((await getSettings()).body.overridesFile).toEqual({ state: 'readable' })
    writeFileSync(store.OVERRIDES_PATH, '[1]')
    store.reloadOverridesForTest()
    expect((await getSettings()).body.overridesFile).toEqual({ state: 'unreadable', cause: 'not-an-object' })
  })
})

describe('config.ts cfg(): an overrides-only key cannot be read through its own override > .env order', () => {
  it('refuses an overrides-only key and still serves a plain one', () => {
    expect(() => cfg('VAULT_ACL_MODE')).toThrow(/overrides-only/)
    expect(() => cfg('BASH_EGRESS_HOST_ALLOW')).toThrow(/overrides-only/)
    expect(() => cfg('SCHEDULER_TZ')).not.toThrow()
  })
})

describe('overrides health: one owner notice per state change (Samu 67962)', () => {
  function harness(initial: string | null) {
    const rec = { stored: initial as string | null, notices: [] as string[], sendResult: true as unknown }
    const deps = (state: { state: string; cause?: string }) => ({
      state: () => state,
      keys: () => ['VAULT_ACL_MODE', 'AGENT_TOKENS'],
      read: () => rec.stored,
      write: (v: string) => { rec.stored = v },
      notify: async (text: string) => { rec.notices.push(text); return rec.sendResult },
    })
    return { rec, deps }
  }

  it('the first sight of a readable file only records', async () => {
    const { rec, deps } = harness(null)
    expect(await health.checkOverridesHealth(deps({ state: 'readable' }))).toEqual({ state: 'ok', notified: false })
    expect(rec).toMatchObject({ stored: 'ok', notices: [] })
  })

  it('turning unreadable: ONE notice with the cause and the key names, then silence while it stays so', async () => {
    const { rec, deps } = harness('ok')
    expect((await health.checkOverridesHealth(deps({ state: 'unreadable', cause: 'EACCES' }))).notified).toBe(true)
    expect(rec.notices).toHaveLength(1)
    expect(rec.notices[0]).toContain('EACCES')
    expect(rec.notices[0]).toContain('VAULT_ACL_MODE, AGENT_TOKENS')
    expect(rec.stored).toBe('unreadable')
    expect((await health.checkOverridesHealth(deps({ state: 'unreadable', cause: 'EACCES' }))).notified).toBe(false)
    expect(rec.notices).toHaveLength(1)
  })

  it('recovering: one recovery notice; a missing file counts as recovered', async () => {
    const { rec, deps } = harness('unreadable')
    expect((await health.checkOverridesHealth(deps({ state: 'missing' }))).notified).toBe(true)
    expect(rec.notices).toEqual([health.RECOVERED_NOTICE])
    expect(rec.stored).toBe('ok')
  })

  it('an unreadable file seen first (no record yet) is reported', async () => {
    const { rec, deps } = harness(null)
    expect((await health.checkOverridesHealth(deps({ state: 'unreadable', cause: 'invalid-json' }))).notified).toBe(true)
    expect(rec.notices).toHaveLength(1)
  })

  it('an undelivered notice is not recorded, so the next check tries again; a throwing notifier never throws', async () => {
    const { rec, deps } = harness('ok')
    rec.sendResult = false
    expect((await health.checkOverridesHealth(deps({ state: 'unreadable', cause: 'EACCES' }))).notified).toBe(false)
    expect(rec.stored).toBe('ok')
    rec.sendResult = true
    expect((await health.checkOverridesHealth(deps({ state: 'unreadable', cause: 'EACCES' }))).notified).toBe(true)
    expect(rec.notices).toHaveLength(2)
    const throwing = { ...deps({ state: 'readable' }), notify: async () => { throw new Error('boom') } }
    rec.stored = 'unreadable'
    await expect(health.checkOverridesHealth(throwing)).resolves.toEqual({ state: 'ok', notified: false })
    expect(rec.stored).toBe('unreadable')
  })

  it('the boot log names the ignored keys, names only', () => {
    expect(health.logIgnoredEnvKeys(['NOTIFY_SLACK_TARGET'])).toEqual(['NOTIFY_SLACK_TARGET'])
    envFile.NOTIFY_SLACK_TARGET = 'D0ROUTEELSEWHERE'
    expect(health.logIgnoredEnvKeys()).toEqual(['NOTIFY_SLACK_TARGET'])
  })

  it('the notice text carries no value', () => {
    const text = health.unreadableNotice('EACCES', ['VAULT_ACL_MODE'])
    expect(text).toContain('VAULT_ACL_MODE')
    expect(text).not.toMatch(/=/)
  })
})

// The two script copies of the store order agree with the store, on real files in a tmp install.
describe('script parity with the store', () => {
  function install(override: Record<string, string> | 'unreadable' | null, dotenv: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'overrides-only-parity-'))
    mkdirSync(join(root, 'store'))
    if (override === 'unreadable') writeFileSync(join(root, 'store', 'config-overrides.json'), '{ bad')
    else if (override) writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify(override))
    writeFileSync(join(root, '.env'), Object.entries(dotenv).map(([k, v]) => `${k}=${v}\n`).join(''))
    return root
  }
  function storeView(key: string, override: Record<string, string> | 'unreadable' | null, dotenv: Record<string, string>): string {
    if (existsSync(store.OVERRIDES_PATH)) rmSync(store.OVERRIDES_PATH)
    if (override === 'unreadable') writeFileSync(store.OVERRIDES_PATH, '{ bad')
    else if (override) writeFileSync(store.OVERRIDES_PATH, JSON.stringify(override))
    store.reloadOverridesForTest()
    for (const k of Object.keys(envFile)) delete envFile[k]
    Object.assign(envFile, dotenv)
    return String(store.getEffectiveSettingValue(key))
  }
  const CASES: Array<[Record<string, string> | 'unreadable' | null, Record<string, string>]> = []
  for (const ov of [null, 'unreadable', { K: 'enforce' }, { K: 'audit' }, { K: '' }] as const) {
    for (const env of [{}, { K: 'enforce' }, { K: 'audit' }, { K: 'U0ENVOWNER' }] as Array<Record<string, string>>) CASES.push([ov as any, env])
  }
  const sub = (o: Record<string, string> | 'unreadable' | null, key: string) =>
    o === null || o === 'unreadable' ? o : Object.fromEntries(Object.entries(o).map(([, v]) => [key, v]))

  it('scripts/vault-dashboard-client.mjs vaultAclMode', async () => {
    const saved = process.env.VAULT_ACL_MODE
    delete process.env.VAULT_ACL_MODE
    try {
      const mod = await import(pathToFileURL(join(ROOT, 'scripts', 'vault-dashboard-client.mjs')).href)
      for (const [ov, env] of CASES) {
        const o = sub(ov, 'VAULT_ACL_MODE')
        const e = Object.fromEntries(Object.entries(env).map(([, v]) => ['VAULT_ACL_MODE', v]))
        if (o && o !== 'unreadable' && !['audit', 'enforce'].includes(o.VAULT_ACL_MODE)) continue
        if (e.VAULT_ACL_MODE === 'U0ENVOWNER') continue
        const want = storeView('VAULT_ACL_MODE', o, e)
        expect(mod.vaultAclMode(install(o, e)), JSON.stringify([o, e])).toBe(want)
      }
    } finally {
      if (saved !== undefined) process.env.VAULT_ACL_MODE = saved
    }
  })

  it('scripts/hooks/ledger-capture.py SLACK_OWNER_USER_ID (None is the store\'s empty default)', () => {
    const hook = join(ROOT, 'scripts', 'hooks', 'ledger-capture.py')
    const py = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("lc", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'v = m._setting(sys.argv[2], "SLACK_OWNER_USER_ID")',
      'print("" if v is None else v)',
    ].join('\n')
    for (const [ov, env] of CASES) {
      const o = sub(ov, 'SLACK_OWNER_USER_ID')
      const e = Object.fromEntries(Object.entries(env).map(([, v]) => ['SLACK_OWNER_USER_ID', v]))
      const want = storeView('SLACK_OWNER_USER_ID', o, e).trim()
      const got = execFileSync('python3', ['-c', py, hook, install(o, e)], { encoding: 'utf-8' }).replace(/\n$/, '')
      expect(got, JSON.stringify([o, e])).toBe(want)
    }
  })

  // ISSUE2556X: OWNER_ALERT_CHAT_ID is read by three mirrors of the store (owner-chat.ts, owner-chat.sh,
  // owner_chat.py): each must see exactly the chat the store answers (an override, never the .env line), normalised
  // ('' and '0' are unset), for every override / .env state.
  it('the three OWNER_ALERT_CHAT_ID mirrors (owner-chat.ts / .sh / owner_chat.py)', async () => {
    const { readOwnerAlertChat, readOverrideValue } = await import('../owner-chat.js')
    const { alertChatValue } = await import('../alert-chat-format.js')
    const K = 'OWNER_ALERT_CHAT_ID'
    const states: Array<Record<string, string> | 'unreadable' | null> = [null, 'unreadable', { K: '5556667778' }, { K: '' }, { K: '0' }, { K: ' 5556667778 ' }]
    const envs: Array<Record<string, string>> = [{}, { K: '1111111111' }, { K: '0' }]
    const lib = join(ROOT, 'scripts', 'lib')
    for (const ov of states) {
      for (const env of envs) {
        const o = sub(ov, K)
        const e = Object.fromEntries(Object.entries(env).map(([, v]) => [K, v]))
        const want = alertChatValue(storeView(K, o, e)) ?? ''
        const root = install(o, e)
        const ts = readOwnerAlertChat('telegram', () => readOverrideValue(K, join(root, 'store', 'config-overrides.json')), 'telegram').chatId ?? ''
        let sh = ''
        try {
          sh = execFileSync('bash', ['-c', '. "$1"; owner_alert_chat_override "$2" telegram 2>/dev/null', '_', join(lib, 'owner-chat.sh'), join(root, '.env')], { encoding: 'utf-8' }).trim()
        } catch { sh = '' }
        const py = execFileSync('python3', ['-c', `import sys\nsys.path.insert(0, sys.argv[1])\nimport owner_chat\nprint(owner_chat.alert_chat_override(sys.argv[2], "telegram")[0] or "")`, lib, join(root, '.env')], { encoding: 'utf-8' }).trim()
        const tag = JSON.stringify([o, e])
        expect(ts, `ts ${tag}`).toBe(want)
        expect(sh, `sh ${tag}`).toBe(want)
        expect(py, `py ${tag}`).toBe(want)
      }
    }
  })


  // OWNERAUTHGUESS1106: TELEGRAM_OWNER_USER_ID is read by two mirrors of the store (owner-identity.ts and the
  // marveen-commands.py hook): each must see exactly the owner id the store answers (an override, never the .env
  // line), and only a positive Telegram user id counts.
  it('the two TELEGRAM_OWNER_USER_ID mirrors (owner-identity.ts / marveen-commands.py)', async () => {
    const { readTelegramOwnerSetting, TELEGRAM_USER_ID_RX } = await import('../owner-identity.js')
    const K = 'TELEGRAM_OWNER_USER_ID'
    const states: Array<Record<string, string> | 'unreadable' | null> = [null, 'unreadable', { K: '5556667778' }, { K: '' }, { K: '0' }, { K: '-1001234' }, { K: ' 5556667778 ' }]
    const envs: Array<Record<string, string>> = [{}, { K: '1111111111' }]
    const hook = join(ROOT, 'scripts', 'hooks', 'marveen-commands.py')
    const py = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("mc", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m.owner_chat_id() or "")',
    ].join('\n')
    for (const ov of states) {
      for (const env of envs) {
        const o = sub(ov, K)
        const e = Object.fromEntries(Object.entries(env).map(([, v]) => [K, v]))
        const stored = String(storeView(K, o, e)).trim()
        const want = TELEGRAM_USER_ID_RX.test(stored) ? stored : ''
        const root = install(o, e)
        const t = readTelegramOwnerSetting(join(root, 'store', 'config-overrides.json'))
        const ts = TELEGRAM_USER_ID_RX.test(t) ? t : ''
        const got = execFileSync('python3', ['-c', py, hook], { encoding: 'utf-8', env: { ...process.env, MARVEEN_INSTALL_DIR: root } }).trim()
        const tag = JSON.stringify([o, e])
        expect(ts, `ts ${tag}`).toBe(want)
        expect(got, `py ${tag}`).toBe(want)
      }
    }
  })


  it('ledger-capture keeps the .env for ALLOWED_CHAT_ID (no registry key)', () => {
    const hook = join(ROOT, 'scripts', 'hooks', 'ledger-capture.py')
    const py = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("lc", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(m._setting(sys.argv[2], "ALLOWED_CHAT_ID"))',
    ].join('\n')
    expect(execFileSync('python3', ['-c', py, hook, install(null, { ALLOWED_CHAT_ID: '12345' })], { encoding: 'utf-8' }).trim()).toBe('12345')
  })
})

// EGM M5: a script that copies the store's order for an overrides-only key would let a loosening .env line count
// again. Every script mention of such a key is either an approved reader (parity-tested above, or the store itself
// through dist) or a pinned mention (a comment or a message). A NEW mention fails here until it is classified.
describe('grep guard: script mentions of overrides-only keys', () => {
  const READERS = new Set([
    'scripts/vault-dashboard-client.mjs', // mirror, parity-tested above
    'scripts/hooks/ledger-capture.py', // mirror, parity-tested above
    'scripts/slack-notify.mjs', // reads through dist/settings-store.js
    'scripts/morning-briefing.sh', // reads through dist/settings-store.js
    'scripts/lib/owner-chat.sh', // OWNER_ALERT_CHAT_ID mirror, parity-tested above
    'scripts/lib/owner_chat.py', // OWNER_ALERT_CHAT_ID mirror, parity-tested above
    'scripts/hooks/marveen-commands.py', // TELEGRAM_OWNER_USER_ID mirror, parity-tested above
  ])
  // file -> pinned mention count (comments and messages only, measured 2026-11-04)
  const MENTION_ONLY: Record<string, number> = {
    'scripts/vault-headers-helper.mjs': 1,
    'scripts/vault-resolve.mjs': 1,
    'scripts/watchdog.sh': 1,
    'scripts/self-pace-gate.mjs': 1,
    'scripts/notify.sh': 1,
    'scripts/hooks/db-write-gate.mjs': 2,
    // ISSUE2556X: a comment and a log line; both read through owner-chat.sh / owner_chat.py (the mirrors above)
    'scripts/main-inbox-observer.sh': 2,
    'scripts/hooks/persona-change-notify.py': 1,
    // VAULTSZELES826 PR-A: the header comment names VAULT_ACL_AGENT_MODE; the script reads the LOG, never the setting
    'scripts/vault-acl-suggest.mjs': 1,
  }
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(sh|mjs|cjs|js|py|ts)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('every mention is classified', () => {
    const keys = store.getOverridesOnlyKeys()
    const re = new RegExp(`\\b(${keys.join('|')})\\b`, 'g')
    const seen: Record<string, number> = {}
    for (const file of walk(join(ROOT, 'scripts'))) {
      const rel = relative(ROOT, file)
      const n = (readFileSync(file, 'utf-8').match(re) ?? []).length
      if (n === 0 || READERS.has(rel)) continue
      seen[rel] = n
    }
    expect(seen).toEqual(MENTION_ONLY)
  })
})

describe('wiring (static)', () => {
  it('the dashboard boot starts the settings health check', () => {
    const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf-8')
    expect(src).toMatch(/import \{ startSettingsHealth \} from '\.\/settings-health\.js'/)
    expect(src).toMatch(/\n\s+startSettingsHealth\(\)\n/)
  })

  it('update.sh names the ignored keys through the dist CLI, as a warning', () => {
    const sh = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    expect(sh).toContain('_env_check_cli="$INSTALL_DIR/dist/settings-env-check-cli.js"')
    expect(sh).toMatch(/_ignored_env_keys="\$\(node "\$_env_check_cli" 2>\/dev\/null \|\| true\)"/)
  })

  it('the Settings page shows the marker and the unreadable banner, in both languages', () => {
    const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
    expect(app).toContain('if (def.envIgnored)')
    expect(app).toContain("overridesFile.state === 'unreadable'")
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      expect(l, lang).toContain("'settings.meta.env_ignored'")
      expect(l, lang).toContain("'settings.overrides_unreadable'")
    }
  })
})
