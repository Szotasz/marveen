// OWNERAUTHGUESS1106: who may run the owner's chat commands. With several paired DMs and the installer's
// ALLOWED_CHAT_ID=0 the command gate used the FIRST allowFrom entry (pairing order decided who the owner was). The
// strict identity resolver never guesses: TELEGRAM_OWNER_USER_ID, a positive ALLOWED_CHAT_ID, the sole DM, else nobody.
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOwnerIdentity, ownerUnsetNotice, OWNER_UNSET_REPLY, readTelegramOwnerSetting, TELEGRAM_OWNER_KEY } from '../owner-identity.js'
import { ownerUnsetResult } from '../web/routes/commands.js'
import { registerCommand, clearCommandsForTest } from '../web/commands.js'
import { midTurnTick, newTailState, type MidTurnDeps } from '../web/midturn-commands.js'
import { getSettingDefinition, isOverridesOnly } from '../config-registry.js'
import { logger } from '../logger.js'

const OWNER = '1268077055'
const FAMILY = '2233445566'
const access = (body: unknown) => () => JSON.stringify(body)
const noAccess = () => { throw new Error('ENOENT') }
const REPO = join(__dirname, '..', '..')

beforeAll(() => {
  clearCommandsForTest()
  registerCommand({ name: 'status', kind: 'read', description: 'állapot', run: async (ctx) => { await ctx.reply('ok') } })
})
afterAll(() => clearCommandsForTest())

describe('resolveOwnerIdentity: never a guess', () => {
  it.each([
    ['the setting wins over everything', access({ allowFrom: [FAMILY, OWNER] }), FAMILY, OWNER, { chatId: OWNER, source: 'setting' }],
    ['a positive ALLOWED_CHAT_ID (unchanged)', access({ allowFrom: [FAMILY, OWNER] }), OWNER, '', { chatId: OWNER, source: 'allowed-chat-id' }],
    ['one DM, ALLOWED_CHAT_ID=0 (unchanged)', access({ allowFrom: [OWNER] }), '0', '', { chatId: OWNER, source: 'sole-dm' }],
    ['one DM plus a group (unchanged)', access({ allowFrom: [OWNER], groups: { '-1001': {} } }), '0', '', { chatId: OWNER, source: 'sole-dm' }],
  ])('%s', (_n, read, configured, explicit, want) => {
    expect(resolveOwnerIdentity(read, configured, explicit)).toEqual(want)
  })
  it('two DMs and ALLOWED_CHAT_ID=0: nobody (before: the FIRST entry, the pairing order)', () => {
    const r = resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '0', '')
    expect(r.chatId).toBeNull()
    expect(r.ambiguous).toBe(true)
  })
  it('groups only: nobody, and not "ambiguous" (no person paired)', () => {
    const r = resolveOwnerIdentity(access({ allowFrom: [], groups: { '-1001': {} } }), '0', '')
    expect(r).toMatchObject({ chatId: null, ambiguous: false })
  })
  it('no access file: nobody', () => {
    expect(resolveOwnerIdentity(noAccess, '0', '')).toMatchObject({ chatId: null, ambiguous: false })
  })
  it('a negative (group) ALLOWED_CHAT_ID names no person: the sole-DM rule decides', () => {
    expect(resolveOwnerIdentity(access({ allowFrom: [OWNER] }), '-1001234', '')).toEqual({ chatId: OWNER, source: 'sole-dm' })
    expect(resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '-1001234', '').chatId).toBeNull()
  })
  it('an invalid setting is not used, is logged once, and the rest of the order decides', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    expect(resolveOwnerIdentity(access({ allowFrom: [OWNER] }), '0', '-55').chatId).toBe(OWNER)
    expect(resolveOwnerIdentity(access({ allowFrom: [OWNER] }), '0', '-55').chatId).toBe(OWNER)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][1])).toMatch(/TELEGRAM_OWNER_USER_ID is set but is not a positive Telegram user id -- NOT used/)
    spy.mockRestore()
  })
  it('"0" and empty are unset', () => {
    expect(resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '0', '0').chatId).toBeNull()
    expect(resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '0', '  ').chatId).toBeNull()
  })
})

describe('readTelegramOwnerSetting: the overrides file only', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  it('reads the key, trims, and treats anything else as unset', () => {
    dir = mkdtempSync(join(tmpdir(), 'owner-identity-'))
    const f = join(dir, 'config-overrides.json')
    writeFileSync(f, JSON.stringify({ TELEGRAM_OWNER_USER_ID: ` ${OWNER} ` }))
    expect(readTelegramOwnerSetting(f)).toBe(OWNER)
    writeFileSync(f, JSON.stringify({ TELEGRAM_OWNER_USER_ID: Number(OWNER) }))
    expect(readTelegramOwnerSetting(f)).toBe(OWNER)
    writeFileSync(f, JSON.stringify({ TELEGRAM_OWNER_USER_ID: true }))
    expect(readTelegramOwnerSetting(f)).toBe('')
    writeFileSync(f, '{ bad')
    expect(readTelegramOwnerSetting(f)).toBe('')
    expect(readTelegramOwnerSetting(join(dir, 'missing.json'))).toBe('')
  })
})

describe('the fail-closed answer (Samu 71849)', () => {
  const ambiguous = resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '0', '')
  it('a registry command gets one generic line, with nothing about the owner', () => {
    expect(ownerUnsetResult('/status', ambiguous)).toEqual({ handled: true, outcome: 'owner-unset', replies: [OWNER_UNSET_REPLY] })
    expect(OWNER_UNSET_REPLY).toBe('Ez a parancs most nem futtatható; a gazda a dashboardon tudja beállítani.')
    expect(OWNER_UNSET_REPLY).not.toMatch(/\d{5,}/)
  })
  it('anything that is not a registry command passes as before', () => {
    expect(ownerUnsetResult('szia, mi újság?', ambiguous)).toBeNull()
    expect(ownerUnsetResult('/nincsilyenparancs', ambiguous)).toBeNull()
  })
  it('a named owner, or no person paired at all: no fail-closed answer (the old not-owner path)', () => {
    expect(ownerUnsetResult('/status', { chatId: OWNER, source: 'sole-dm' })).toBeNull()
    expect(ownerUnsetResult('/status', resolveOwnerIdentity(noAccess, '0', ''))).toBeNull()
  })
  it('the dashboard / doctor line names the setting, only when commands are off for this reason', () => {
    expect(ownerUnsetNotice(ambiguous)).toMatch(/A chat-parancsok le vannak tiltva: több párosított DM van.*Beállítások -> TELEGRAM_OWNER_USER_ID/)
    expect(ownerUnsetNotice({ chatId: OWNER, source: 'setting' })).toBeNull()
    expect(ownerUnsetNotice(resolveOwnerIdentity(noAccess, '0', ''))).toBeNull()
  })
})

describe('the mid-turn path', () => {
  it('several DMs, no owner id: the command is answered generically and NOT dispatched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-identity-midturn-'))
    try {
      const file = join(dir, 'sess.jsonl')
      writeFileSync(file, '')
      const sent: unknown[][] = []
      const dispatch = vi.fn()
      const deps: MidTurnDeps = {
        transcriptDir: () => dir,
        ownerChatId: () => FAMILY, // the old first-entry guess: must not be used
        ownerIdentity: () => resolveOwnerIdentity(access({ allowFrom: [FAMILY, OWNER] }), '0', ''),
        dispatch: dispatch as unknown as MidTurnDeps['dispatch'],
        send: async (...a: unknown[]) => { sent.push(a) },
        now: () => Date.now(),
        sleep: async () => {},
      }
      const state = newTailState()
      await midTurnTick(state, deps, true)
      const prompt = `<channel source="plugin:telegram:telegram" chat_id="${FAMILY}" message_id="7" user="${FAMILY}" user_id="${FAMILY}" ts="2026-11-06T18:00:00.000Z">/status</channel>`
      writeFileSync(file, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'channel', server: 'plugin:telegram:telegram' }, isMeta: true } }) + '\n')
      expect(await midTurnTick(state, deps)).toBe(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(sent.map((a) => a.slice(0, 2))).toEqual([[FAMILY, OWNER_UNSET_REPLY]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the marveen-commands.py hook names the owner the same way (or leaves it to the dashboard)', () => {
  const hookOwner = (dotenv: string, overrides: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), 'owner-identity-hook-'))
    try {
      writeFileSync(join(root, '.env'), dotenv)
      if (overrides !== undefined) {
        mkdirSync(join(root, 'store'))
        writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify(overrides))
      }
      const py = ['import importlib.util, sys', 'spec = importlib.util.spec_from_file_location("mc", sys.argv[1])',
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)', 'print(m.owner_chat_id() or "")'].join('\n')
      return execFileSync('python3', ['-c', py, join(REPO, 'scripts', 'hooks', 'marveen-commands.py')],
        { encoding: 'utf-8', env: { ...process.env, MARVEEN_INSTALL_DIR: root } }).trim()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  it.each([
    ['a positive ALLOWED_CHAT_ID (unchanged)', `ALLOWED_CHAT_ID=${OWNER}\n`, undefined, OWNER],
    ['"0": left to the dashboard (unchanged)', 'ALLOWED_CHAT_ID=0\n', undefined, ''],
    ['a negative (group) ALLOWED_CHAT_ID names no person: left to the dashboard', 'ALLOWED_CHAT_ID=-1001234\n', undefined, ''],
    ['the setting wins', `ALLOWED_CHAT_ID=${FAMILY}\n`, { TELEGRAM_OWNER_USER_ID: OWNER }, OWNER],
    ['an invalid setting is not used', 'ALLOWED_CHAT_ID=0\n', { TELEGRAM_OWNER_USER_ID: '-5' }, ''],
    ['a .env line of the key never counts', `ALLOWED_CHAT_ID=0\nTELEGRAM_OWNER_USER_ID=${OWNER}\n`, undefined, ''],
  ])('%s', (_n, dotenv, overrides, want) => {
    expect(hookOwner(dotenv, overrides)).toBe(want)
  })
})

describe('the settings key', () => {
  const def = getSettingDefinition(TELEGRAM_OWNER_KEY)!
  it('is an overrides-only channels string, empty by default; any change loosens', () => {
    expect(def).toMatchObject({ type: 'string', default: '', module: 'channels', secret: false })
    expect(isOverridesOnly(def)).toBe(true)
    expect(def.loosens!('', OWNER)).toBe(true)
    expect(def.loosens!(OWNER, '')).toBe(true)
  })
  it('takes a positive Telegram user id or empty; refuses a group id and text, in Hungarian and English', () => {
    expect(def.validate!('')).toBeNull()
    expect(def.validate!(OWNER)).toBeNull()
    for (const bad of ['-1001234567890', 'abc', '0123', '12 34']) {
      expect(def.validate!(bad), bad).toMatch(/Pozitív Telegram-felhasználói azonosító kell.* \/ A positive Telegram user id is required/)
    }
  })
})

describe('where the owner is decided (pinned in source)', () => {
  const src = (p: string) => readFileSync(join(REPO, p), 'utf-8')
  it('the command route and the mid-turn path ask the identity resolver, not the delivery resolver', () => {
    expect(src('src/web/routes/commands.ts')).toContain('const identity = resolveOwnerIdentity()')
    expect(src('src/web/routes/commands.ts')).not.toMatch(/resolveOwnerChatId/)
    expect(src('src/web/midturn-commands.ts')).toContain('ownerIdentity: () => resolveOwnerIdentity(),')
    expect(src('src/web/midturn-commands.ts')).not.toMatch(/resolveOwnerChatId/)
    expect(src('src/web/system-status.ts')).toContain('ownerUnsetNotice(identity)')
    expect(src('scripts/doctor.sh')).toContain('owner-identity')
  })
})
