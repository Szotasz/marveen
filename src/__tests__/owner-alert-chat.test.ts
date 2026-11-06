// ISSUE2556X (marveen#2556): OWNER_ALERT_CHAT_ID, the owner's alert chat from the settings page. With two paired DMs
// and the installer's ALLOWED_CHAT_ID=0 the alert resolver refuses to guess, and every system alert was lost; the key
// names the chat outright. Delivery only: who the owner IS (the command gate, the ledger) is not touched.
// The three ports (TS, shell, Python) are held to one table, as owner-chat-parity.test.ts does for the old rule.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOwnerAlertChat, resolveAlertDeliveryChat, resolveAlertOwnerChat, ownerAlertChatOverride } from '../owner-chat.js'
import { ALERT_CHAT_FORMATS, alertChatFormatError, alertChatProviderOf, OWNER_ALERT_CHAT_KEY, type AlertChatProvider } from '../alert-chat-format.js'
import { getSettingDefinition, isOverridesOnly } from '../config-registry.js'
import { logger } from '../logger.js'
import type { ChannelProviderType } from '../channel-provider.js'

const REAL = '1268077055'
const OTHER = '2233445566'
const ALERT = '5556667778'
const REPO_ROOT = join(__dirname, '..', '..')
const SH_LIB = join(REPO_ROOT, 'scripts', 'lib', 'owner-chat.sh')
const PY_LIB = join(REPO_ROOT, 'scripts', 'lib')
const ENV_KEY: Record<string, string> = { telegram: 'ALLOWED_CHAT_ID', slack: 'SLACK_CHANNEL_ID', discord: 'DISCORD_CHANNEL_ID', googlechat: 'GOOGLECHAT_SPACE_ID', teams: 'TEAMS_ALLOWED_CONVERSATION_ID' }

let dirs: string[] = []
const HOME_DIR = mkdtempSync(join(tmpdir(), 'owner-alert-chat-home-'))
const childEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: HOME_DIR })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })
afterAll(() => rmSync(HOME_DIR, { recursive: true, force: true }))

interface Case {
  name: string
  provider?: ChannelProviderType // asked for; default telegram
  install?: string // CHANNEL_PROVIDER in .env; undefined = no line (telegram)
  envChat?: string // the provider's configured .env key
  access?: unknown
  overrides?: unknown // store/config-overrides.json body (an object, or a raw string)
  envLine?: string // an OWNER_ALERT_CHAT_ID line in .env: must never count
  expected: string | null
}

function makeInstall(c: Case): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-alert-chat-'))
  dirs.push(dir)
  const provider = c.provider ?? 'telegram'
  let env = 'MAIN_AGENT_ID=marveen\n'
  if (c.install !== undefined) env += `CHANNEL_PROVIDER=${c.install}\n`
  if (c.envChat !== undefined) env += `${ENV_KEY[provider]}=${c.envChat}\n`
  if (c.envLine !== undefined) env += `OWNER_ALERT_CHAT_ID=${c.envLine}\n`
  writeFileSync(join(dir, '.env'), env)
  if (c.access !== undefined) {
    const ch = join(dir, '.claude', 'channels', provider)
    mkdirSync(ch, { recursive: true })
    writeFileSync(join(ch, '.env'), 'X=1\n')
    writeFileSync(join(ch, 'access.json'), JSON.stringify(c.access))
  }
  if (c.overrides !== undefined) {
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(join(dir, 'store', 'config-overrides.json'), typeof c.overrides === 'string' ? c.overrides : JSON.stringify(c.overrides))
  }
  return dir
}

function runShell(envFile: string, provider: string): string | null {
  try {
    const out = execFileSync('bash', ['-c', `. "${SH_LIB}"; resolve_alert_chat_id "$1" "$2" 2>/dev/null`, '_', envFile, provider],
      { encoding: 'utf-8', env: childEnv() }).trim()
    return out || null
  } catch { return null }
}
function runPython(envFile: string, provider: string): string | null {
  const code = `import sys\nsys.path.insert(0, ${JSON.stringify(PY_LIB)})\nimport owner_chat\nprint(owner_chat.resolve_alert_chat_id(${JSON.stringify(envFile)}, ${JSON.stringify(provider)}) or "")`
  try {
    const out = execFileSync('python3', ['-c', code], { encoding: 'utf-8', env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out || null
  } catch { return null }
}
// The TS resolver, fed the same files: the override read as settings-store answers an overrides-only key (the
// overrides file alone, never .env), the install provider as config.ts reads CHANNEL_PROVIDER.
function runTs(c: Case): string | null {
  const provider = c.provider ?? 'telegram'
  const overrides = typeof c.overrides === 'object' && c.overrides !== null ? c.overrides as Record<string, unknown> : {}
  const raw = overrides[OWNER_ALERT_CHAT_KEY]
  const read = () => (typeof raw === 'string' || typeof raw === 'number' ? raw : '')
  const override = readOwnerAlertChat(provider, read, alertChatProviderOf(c.install))
  const reader = () => { if (c.access === undefined) throw new Error('ENOENT'); return JSON.stringify(c.access) }
  return resolveAlertDeliveryChat(reader, c.envChat ?? '', provider, override).chatId
}

const TWO_DMS = { allowFrom: [REAL, OTHER] }
const cases: Case[] = [
  { name: '#2556: two DMs, ALLOWED_CHAT_ID=0, the key set: the key', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: ALERT }, expected: ALERT },
  { name: 'the key wins over a configured ALLOWED_CHAT_ID', envChat: REAL, access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: ALERT }, expected: ALERT },
  { name: 'unset: two DMs still refuse to guess (unchanged)', envChat: '0', access: TWO_DMS, overrides: {}, expected: null },
  { name: 'unset: ALLOWED_CHAT_ID as before', envChat: REAL, access: TWO_DMS, expected: REAL },
  { name: 'unset: the sole DM as before', envChat: '0', access: { allowFrom: [REAL] }, overrides: { OWNER_ALERT_CHAT_ID: '' }, expected: REAL },
  { name: '"0" is unset', envChat: '0', access: { allowFrom: [REAL] }, overrides: { OWNER_ALERT_CHAT_ID: '0' }, expected: REAL },
  { name: 'a .env line never counts (overrides-only)', envChat: '0', access: TWO_DMS, envLine: ALERT, expected: null },
  { name: 'invalid shape: not used, the old rule answers', envChat: REAL, access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: 'abc' }, expected: REAL },
  { name: 'invalid shape and no old answer: none', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: 'D0123456789' }, expected: null },
  { name: 'a Telegram group id is refused (Samu 71847): the old rule answers', envChat: '0', access: { allowFrom: [REAL] }, overrides: { OWNER_ALERT_CHAT_ID: '-1001234567890' }, expected: REAL },
  { name: 'a Slack channel id is refused (Samu 71847): the old rule answers', provider: 'slack', install: 'slack', envChat: '', access: { allowFrom: ['U0123456'] }, overrides: { OWNER_ALERT_CHAT_ID: 'C0123456789' }, expected: 'U0123456' },
  { name: 'a number in the JSON', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: Number(ALERT) }, expected: ALERT },
  { name: 'whitespace around the value', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: `  ${ALERT} ` }, expected: ALERT },
  { name: 'a malformed overrides file: unset', envChat: REAL, access: TWO_DMS, overrides: 'not json', expected: REAL },
  { name: 'a Slack install: a Telegram send does not get the key', provider: 'telegram', install: 'slack', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: 'D0123456789' }, expected: null },
  { name: 'a Slack install: the Slack alert gets the key', provider: 'slack', install: 'slack', envChat: '', access: { allowFrom: ['U01', 'U02'] }, overrides: { OWNER_ALERT_CHAT_ID: 'D0123456789' }, expected: 'D0123456789' },
  { name: 'a Slack install: a Telegram send ignores even a value valid for Telegram', provider: 'telegram', install: 'slack', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: ALERT }, expected: null },
  { name: 'a Telegram install: a Slack alert does not get the key', provider: 'slack', install: 'telegram', envChat: '', access: { allowFrom: ['U01', 'U02'] }, overrides: { OWNER_ALERT_CHAT_ID: 'D0123456789' }, expected: null },
  { name: 'non-object overrides JSON: unset', envChat: REAL, access: TWO_DMS, overrides: '["x"]', expected: REAL },
  { name: 'an unknown CHANNEL_PROVIDER reads as telegram', install: 'pigeon', envChat: '0', access: TWO_DMS, overrides: { OWNER_ALERT_CHAT_ID: ALERT }, expected: ALERT },
]

describe('OWNER_ALERT_CHAT_ID parity: TS, shell and Python agree', () => {
  for (const c of cases) {
    it(c.name, () => {
      const envFile = join(makeInstall(c), '.env')
      const provider = c.provider ?? 'telegram'
      expect(runTs(c), 'TS').toBe(c.expected)
      expect(runShell(envFile, provider), 'shell').toBe(c.expected)
      expect(runPython(envFile, provider), 'python').toBe(c.expected)
    })
  }
})

// Samu 71763: without the key the behaviour stays byte-identical. Every old-rule shape, no overrides file: the new
// alert functions print what the old ones print (stdout and the reason line), in all three ports.
describe('unset: byte-identical to the old resolvers', () => {
  const olds: Case[] = [
    { name: '"0", no access', envChat: '0', expected: null },
    { name: 'configured', envChat: REAL, access: TWO_DMS, expected: REAL },
    { name: '"0", sole DM', envChat: '0', access: { allowFrom: [REAL] }, expected: REAL },
    { name: '"0", two DMs', envChat: '0', access: TWO_DMS, expected: null },
    { name: '"0", groups only', envChat: '0', access: { allowFrom: [], groups: { '-100999': {} } }, expected: null },
    { name: 'no .env value at all', access: { allowFrom: [REAL] }, expected: REAL },
  ]
  const both = (fnNew: string, fnOld: string, envFile: string) => {
    const run = (fn: string) => {
      try {
        return execFileSync('bash', ['-c', `. "${SH_LIB}"; ${fn} "$1"; echo "rc=$?"`, '_', envFile],
          { encoding: 'utf-8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) { return String((e as { stdout?: string }).stdout ?? '') }
    }
    return [run(fnNew), run(fnOld)]
  }
  for (const c of olds) {
    it(c.name, () => {
      const envFile = join(makeInstall(c), '.env')
      const [shNew, shOld] = both('resolve_alert_chat_id', 'resolve_owner_chat_id', envFile)
      expect(shNew, 'shell stdout').toBe(shOld)
      const py = (fn: string) => execFileSync('python3', ['-c', `import sys\nsys.path.insert(0, ${JSON.stringify(PY_LIB)})\nimport owner_chat\nprint(repr(owner_chat.${fn}(${JSON.stringify(envFile)})))`],
        { encoding: 'utf-8', env: childEnv() })
      expect(py('resolve_alert_chat'), 'python').toBe(py('resolve_owner_chat'))
      const reader = () => { if (c.access === undefined) throw new Error('ENOENT'); return JSON.stringify(c.access) }
      expect(resolveAlertDeliveryChat(reader, c.envChat ?? '', 'telegram', { chatId: null }), 'TS')
        .toEqual(resolveAlertOwnerChat(reader, c.envChat ?? '', 'telegram'))
    })
  }
})

describe('the chat id shapes, one table for the three ports', () => {
  const table: Array<[AlertChatProvider, string, boolean]> = [
    ['telegram', REAL, true], ['telegram', '-1001234567890', false], ['telegram', '-1268077055', false], ['telegram', '0123', false], ['telegram', 'abc', false],
    ['telegram', '12 34', false], ['telegram', '123456789012345678901', false],
    ['slack', 'D0123456789', true], ['slack', 'C0C71PY0S2H', false], ['slack', 'G0123456789', false], ['slack', 'U01ABCDEF', true], ['slack', 'd0123456789', false],
    ['slack', '12345', false], ['slack', 'X0123456789', false],
    ['discord', '1234567890123456789', true], ['discord', '12345', false], ['discord', 'abc1234567890123', false],
    ['googlechat', 'spaces/AAAAbbbb_-1', true], ['googlechat', 'AAAA', false], ['googlechat', 'spaces/a b', false],
    ['teams', '19:abc@thread.v2', true], ['teams', 'a:1Xyz', true], ['teams', 'x y', false], ['teams', 'ab', false],
  ]
  for (const [provider, value, ok] of table) {
    it(`${provider} ${JSON.stringify(value)} -> ${ok ? 'valid' : 'refused'}`, () => {
      expect(alertChatFormatError(provider, value) === null, 'TS').toBe(ok)
      expect(ALERT_CHAT_FORMATS[provider].test(value), 'TS pattern').toBe(ok)
      const c: Case = { name: '', provider, install: provider, envChat: '', access: { allowFrom: [] }, overrides: { OWNER_ALERT_CHAT_ID: value }, expected: ok ? value : null }
      const envFile = join(makeInstall(c), '.env')
      expect(runShell(envFile, provider), 'shell').toBe(c.expected)
      expect(runPython(envFile, provider), 'python').toBe(c.expected)
    })
  }
})

describe('the shell override: exit 0 = a chat, 1 = unset, 2 = set but invalid (said on stderr)', () => {
  const rc = (overrides: unknown): [number, string, string] => {
    const envFile = join(makeInstall({ name: '', overrides, expected: null }), '.env')
    try {
      const out = execFileSync('bash', ['-c', `. "${SH_LIB}"; owner_alert_chat_override "$1" telegram`, '_', envFile], { encoding: 'utf-8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      return [0, out, '']
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return [err.status ?? -1, String(err.stdout ?? ''), String(err.stderr ?? '')]
    }
  }
  it('a valid chat', () => expect(rc({ OWNER_ALERT_CHAT_ID: ALERT })).toEqual([0, ALERT, '']))
  it('no file, an empty value and "0" are unset, silently', () => {
    expect(rc(undefined)).toEqual([1, '', ''])
    expect(rc({ OWNER_ALERT_CHAT_ID: '' })).toEqual([1, '', ''])
    expect(rc({ OWNER_ALERT_CHAT_ID: '0' })).toEqual([1, '', ''])
  })
  it('a wrong shape: exit 2 and a line on stderr', () => {
    const [code, out, err] = rc({ OWNER_ALERT_CHAT_ID: 'abc' })
    expect([code, out]).toEqual([2, ''])
    expect(err).toMatch(/OWNER_ALERT_CHAT_ID is set but is not a telegram chat id -- NOT used/)
  })
})

describe('the TS resolvers', () => {
  it('readOwnerAlertChat: another provider than the install does not get it', () => {
    expect(readOwnerAlertChat('telegram', () => ALERT, 'slack')).toEqual({ chatId: null })
    expect(readOwnerAlertChat('telegram', () => ALERT, 'telegram')).toEqual({ chatId: ALERT })
  })
  it('readOwnerAlertChat: a read error is unset, not a crash', () => {
    expect(readOwnerAlertChat('telegram', () => { throw new Error('x') }, 'telegram')).toEqual({ chatId: null })
  })
  it('an invalid value is logged as an error (once per value), never used silently', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const r1 = readOwnerAlertChat('telegram', () => 'not-a-chat', 'telegram')
    const r2 = readOwnerAlertChat('telegram', () => 'not-a-chat', 'telegram')
    expect(r1.chatId).toBeNull()
    expect(r1.invalid).toMatch(/telegram/)
    expect(r2.invalid).toBe(r1.invalid)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][1])).toMatch(/OWNER_ALERT_CHAT_ID is set but is not a telegram chat id -- NOT used/)
    spy.mockRestore()
  })
  it('resolveAlertDeliveryChat: an invalid key with no old answer says why', () => {
    const r = resolveAlertDeliveryChat(() => JSON.stringify(TWO_DMS), '0', 'telegram', { chatId: null, invalid: 'x' })
    expect(r.chatId).toBeNull()
    expect(r.reason).toMatch(/2 DM entries, refusing to guess; OWNER_ALERT_CHAT_ID is set but invalid for telegram/)
  })
  it('ownerAlertChatOverride reads the install overrides file (none in this checkout: null)', () => {
    expect(ownerAlertChatOverride('telegram')).toBeNull()
  })
})

describe('the settings key', () => {
  const def = getSettingDefinition(OWNER_ALERT_CHAT_KEY)!
  it('exists, is a channels string, empty by default', () => {
    expect(def).toBeDefined()
    expect(def.type).toBe('string')
    expect(def.default).toBe('')
    expect(def.module).toBe('channels')
    expect(def.secret).toBe(false)
  })
  it('is overrides-only: any change loosens (a .env line never counts)', () => {
    expect(isOverridesOnly(def)).toBe(true)
    expect(def.loosens!('', ALERT)).toBe(true)
    expect(def.loosens!(ALERT, '')).toBe(true)
    expect(def.loosens!(ALERT, ` ${ALERT} `)).toBe(false)
  })
  it('refuses a value in the wrong shape for the install\'s provider', () => {
    const provider = alertChatProviderOf(readEnvProvider())
    expect(def.validate!('')).toBeNull()
    expect(def.validate!('0')).toBeNull()
    expect(def.validate!(provider === 'telegram' ? REAL : 'D0123456789')).toBeNull()
    expect(def.validate!('not a chat')).toMatch(/Személyes chat-azonosító kell .*Csoport vagy csatorna nem lehet.* \/ A personal chat id is required .*A group or channel is not allowed/)
    if (provider === 'telegram') expect(def.validate!('-1001234567890')).toMatch(/Személyes chat-azonosító kell \(telegram\)/)
  })
})

function readEnvProvider(): string | undefined {
  try { return /^CHANNEL_PROVIDER=(.*)$/m.exec(readFileSync(join(REPO_ROOT, '.env'), 'utf-8'))?.[1] } catch { return undefined }
}

// Delivery sites take the key; the sites that decide who the owner IS do not (Samu 71763: delivery only).
describe('where the key is read (pinned in source)', () => {
  const src = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf-8')
  it('the delivery sites', () => {
    expect(src('src/notify.ts').match(/resolveAlertDeliveryChat\(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER\)/g)).toHaveLength(3)
    expect(src('src/notify.ts')).not.toMatch(/resolveAlertOwnerChat\(/)
    expect(src('src/index.ts')).toContain("ownerAlertChatOverride('telegram') ?? resolveOwnerChatId()")
    expect(src('src/web/telegram.ts').match(/ownerAlertChatOverride\('telegram'\) \?\? resolveOwnerChatId\(\)/g)).toHaveLength(4)
    expect(src('src/web/routes/approvals.ts')).toContain("ownerAlertChatOverride('telegram') ?? resolveOwnerChatId()")
    expect(src('src/web/command-task.ts')).toContain("ownerAlertChatOverride('telegram') ?? resolveOwnerChatId()")
    expect(src('src/web/schedule-runner.ts')).toContain('ownerAlertChatOverride(CHANNEL_PROVIDER) ?? resolveOwnerChatId(undefined, configuredOwnerChatFor(CHANNEL_PROVIDER), CHANNEL_PROVIDER)')
    for (const f of ['disk-space-guard.sh', 'github-pr-monitor.sh', 'limit-monitor.sh', 'morning-briefing.sh', 'notify.sh', 'stuck-modal-guard.sh']) {
      expect(src(`scripts/${f}`), f).toContain('resolve_alert_chat_id ')
      expect(src(`scripts/${f}`), f).not.toMatch(/resolve_owner_chat_id "\$/)
    }
    expect(src('scripts/uptime-monitor.py')).toContain('owner_chat.resolve_alert_chat(INSTALL_ENV)')
    expect(src('scripts/main-inbox-observer.sh')).toContain('owner_alert_chat_override "$INSTALL_DIR/.env" telegram')
    expect(src('scripts/hooks/persona-change-notify.py')).toContain('alert_chat_override(os.path.join(ROOT, ".env"), "telegram")')
  })
  it('the owner-identity sites do not', () => {
    for (const f of ['src/web/routes/commands.ts', 'src/web/midturn-commands.ts', 'src/web/inbound-probe.ts', 'src/db.ts',
      'scripts/hooks/marveen-commands.py', 'scripts/hooks/ledger-capture.py', 'scripts/hooks/ledger-outbound.py',
      'scripts/watchdog-inbound-prober.py']) {
      expect(src(f), f).not.toMatch(/OWNER_ALERT_CHAT|ownerAlertChatOverride|resolveAlertDeliveryChat|resolve_alert_chat|alert_chat_override/)
    }
  })
})
