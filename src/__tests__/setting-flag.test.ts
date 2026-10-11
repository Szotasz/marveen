import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnvContent } from '../env-parse.js'

// TELEGRAM_TOPICS_ENABLED is read in two languages: the plugin patcher
// (Python, at channel start) and the dashboard (TS: the fallback poller's
// handoff tag). Both must read the same value the same way, or a hand-written
// TELEGRAM_TOPICS_ENABLED=true patches the plugin while the dashboard calls
// the switch off.

let effective: unknown = '0'
vi.mock('../settings-store.js', async (orig) => ({
  ...(await orig<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (key: string) => {
    if (key !== 'TELEGRAM_TOPICS_ENABLED') throw new Error(`Unknown setting key: ${key}`)
    if (effective instanceof Error) throw effective
    return effective
  },
}))

const { SETTING_ON_VALUES, isSettingValueOn, isSettingOn } = await import('../setting-flag.js')
const { buildHandoffContent } = await import('../channel-coordinator.js')

const ROOT = join(__dirname, '..', '..')

describe('isSettingValueOn', () => {
  it('what the Settings page writes: "1" on, "0" off, unset off', () => {
    expect(isSettingValueOn('1')).toBe(true)
    expect(isSettingValueOn('0')).toBe(false)
    expect(isSettingValueOn('')).toBe(false)
    expect(isSettingValueOn(undefined)).toBe(false)
  })

  it('a hand-written .env value: every value src/config.ts reads as on', () => {
    for (const v of ['true', 'TRUE', 'Yes', ' on ', 1]) expect(isSettingValueOn(v), String(v)).toBe(true)
    for (const v of ['false', 'no', 'off', '2', 'enabled']) expect(isSettingValueOn(v), v).toBe(false)
  })
})

describe('one set of "on" values across the readers', () => {
  it('the plugin patcher\'s TRUTHY is the same set', () => {
    const py = readFileSync(join(ROOT, 'scripts', 'patch-telegram-plugin.py'), 'utf-8')
    const tuple = py.match(/^TRUTHY = \(([^)]*)\)/m)?.[1] ?? ''
    expect([...tuple.matchAll(/"([^"]*)"/g)].map(m => m[1])).toEqual([...SETTING_ON_VALUES])
  })

  it('the plugin patcher\'s JS_TRIM is exactly what String.prototype.trim() removes', () => {
    const py = 'import importlib.util, json, sys\n'
      + 'spec = importlib.util.spec_from_file_location("patcher", sys.argv[1])\n'
      + 'patcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(patcher)\n'
      + 'print(json.dumps(sorted(ord(c) for c in patcher.JS_TRIM)))'
    const r = spawnSync('python3', ['-c', py, join(ROOT, 'scripts', 'patch-telegram-plugin.py')], { encoding: 'utf-8', timeout: 30_000 })
    const jsTrimmed: number[] = []
    for (let c = 0; c <= 0xffff; c++) if (String.fromCharCode(c).trim() === '') jsTrimmed.push(c)
    expect(JSON.parse(r.stdout)).toEqual(jsTrimmed)
  })

  it('src/config.ts reads its boolean flags with the same set', () => {
    const cfg = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf-8')
    const sets = [...cfg.matchAll(/\[('1', 'true', [^\]]*)\]\.includes/g)].map(m => m[1])
    expect(sets.length).toBeGreaterThan(0)
    for (const s of sets) expect(s).toBe(SETTING_ON_VALUES.map(v => `'${v}'`).join(', '))
  })
})

describe('isSettingOn and the fallback poller\'s handoff tag', () => {
  const ev = { kind: 'message', chat_id: 42, user_id: 42, username: 'owner', message_id: 8, content: 'x', tg_date: 1700000000, meta: { message_thread_id: 12 } }
  afterEach(() => { effective = '0' })

  it('"true" in .env is on for the dashboard too: the handoff tag carries the topic', () => {
    effective = 'true'
    expect(isSettingOn('TELEGRAM_TOPICS_ENABLED')).toBe(true)
    expect(buildHandoffContent(ev)).toContain('message_thread_id="12"')
  })

  it('"1" stays on and "0" stays off, as before', () => {
    effective = '1'
    expect(buildHandoffContent(ev)).toContain('message_thread_id="12"')
    effective = '0'
    expect(buildHandoffContent(ev)).not.toContain('message_thread_id')
  })

  it('an unreadable setting is off', () => {
    effective = new Error('boom')
    expect(isSettingOn('TELEGRAM_TOPICS_ENABLED')).toBe(false)
    expect(isSettingOn('NO_SUCH_KEY')).toBe(false)
  })
})

// The .env branch, both sides on the same bytes. The dashboard reads .env with
// parseEnvContent (readEnvFile -> getEffectiveSettingValue), the plugin patcher
// with its own topics_setting(); a shape they read differently gives a Settings
// page that says on while the plugin stays unpatched, or the other way round.
// The rows the #1893 review found first, then the everyday shapes.
describe('.env read the same way by the plugin patcher and the dashboard', () => {
  const K = 'TELEGRAM_TOPICS_ENABLED'
  const rows: Array<[string, Buffer, boolean]> = [
    ['spaces around =', Buffer.from(`${K} = 1\n`), true],
    ['a space before =', Buffer.from(`${K} =1\n`), true],
    ['0 then 1: the last one wins', Buffer.from(`${K}=0\n${K}=1\n`), true],
    ['1 then 0: the last one wins', Buffer.from(`${K}=1\n${K}=0\n`), false],
    ['unmatched quotes are kept', Buffer.from(`${K}="1'\n`), false],
    ['a UTF-8 BOM before line 1', Buffer.from(`\uFEFF${K}=1\n`), true],
    ['an invalid UTF-8 byte on another line', Buffer.concat([Buffer.from('OTHER='), Buffer.from([0xff]), Buffer.from(`\n${K}=1\n`)]), true],
    ['a lone CR does not end a line', Buffer.from(`OTHER=1\r${K}=1\n`), false],
    ['U+0085 is not trimmed', Buffer.from(`${K}=1\u0085\n`), false],
    ['plain 1', Buffer.from(`${K}=1\n`), true],
    ['plain 0', Buffer.from(`${K}=0\n`), false],
    ['no newline at the end', Buffer.from(`${K}=1`), true],
    ['CRLF', Buffer.from(`OTHER=x\r\n${K}=1\r\n`), true],
    ['matching double quotes', Buffer.from(`${K}="true"\n`), true],
    ['matching single quotes', Buffer.from(`${K}='yes'\n`), true],
    ['indented, with a no-break space', Buffer.from(`  ${K}=on\u00A0\n`), true],
    ['commented out', Buffer.from(`# ${K}=1\n`), false],
    ['another key only', Buffer.from('OTHER=1\n'), false],
    ['empty file', Buffer.from(''), false],
  ]

  // One python3 run: the patcher's own topics_setting() on a throwaway install
  // per row, with only that .env in it.
  function patcherReads(contents: Buffer[]): boolean[] {
    const py = [
      'import importlib.util, json, os, sys, tempfile',
      'spec = importlib.util.spec_from_file_location("patcher", sys.argv[1])',
      'patcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(patcher)',
      'out = []',
      'for hexed in json.load(sys.stdin):',
      '    with tempfile.TemporaryDirectory() as install:',
      '        with open(os.path.join(install, ".env"), "wb") as f: f.write(bytes.fromhex(hexed))',
      '        out.append(patcher.topics_setting(install))',
      'print(json.dumps(out))',
    ].join('\n')
    const r = spawnSync('python3', ['-c', py, join(ROOT, 'scripts', 'patch-telegram-plugin.py')], {
      input: JSON.stringify(contents.map(c => c.toString('hex'))), encoding: 'utf-8', timeout: 30_000,
    })
    expect(r.stderr).toBe('')
    return JSON.parse(r.stdout)
  }

  it('every row: the patcher and the dashboard agree, and on the expected value', () => {
    const patcher = patcherReads(rows.map(([, content]) => content))
    const got = rows.map(([label, content], i) => ({
      label,
      dashboard: isSettingValueOn(parseEnvContent(content.toString('utf-8'))[K]),
      patcher: patcher[i],
    }))
    expect(got).toEqual(rows.map(([label, , on]) => ({ label, dashboard: on, patcher: on })))
  })
})
