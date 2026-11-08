// scripts/patch-telegram-plugin.py, the pairtext patch (TGPAIRTEXT1108, Samu 73716): on a Marveen install the plugin's
// pairing reply and its /start say "run in Claude Code: /telegram:access pair <code>", but the code is approved in the
// dashboard. Two insert-only lines answer first and return; the language is the install's AGENT_TEXT_LANG (en | hu,
// anything else or none: hu); a missing anchor leaves the file alone, all-or-nothing, and the state file says so.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')
const MARKER = '// MARVEEN-PATCH(pairtext): the pairing text names the Marveen dashboard'

let install = ''
let script = ''
let cache = ''
let server = ''

beforeEach(() => {
  // An install of its own: the script reads <install>/.env for AGENT_TEXT_LANG (as it reads its other settings).
  install = mkdtempSync(join(tmpdir(), 'tg-pairtext-install-'))
  mkdirSync(join(install, 'scripts'))
  mkdirSync(join(install, 'store'))
  script = join(install, 'scripts', 'patch-telegram-plugin.py')
  copyFileSync(SCRIPT, script)
  cache = join(install, 'cache')
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(install, { recursive: true, force: true }))

function run(): { state: { lang: string; files: Array<{ patches: Record<string, string> }> }; stderr: string } {
  const state = join(install, 'store', 'state.json')
  const r = spawnSync('python3', [script, '--state', state, cache], { encoding: 'utf-8', timeout: 30_000 })
  expect(r.status).toBe(0)
  return { state: JSON.parse(readFileSync(state, 'utf-8')), stderr: r.stderr }
}

const ours = (text: string) => text.split('\n').filter((l) => l.endsWith(' ' + MARKER))
const strip = (text: string) => text.split('\n').filter((l) => !l.endsWith(' ' + MARKER)).join('\n')

describe('the pairtext patch', () => {
  it('answers the pair branch and /start with the dashboard, in Hungarian by default, before the plugin lines', () => {
    const { state } = run()
    expect(state.lang).toBe('hu')
    expect(state.files[0].patches.pairtext).toBe('patched')
    const text = readFileSync(server, 'utf-8')
    const lines = ours(text)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Ez a bot egy Marveen-ügynökhöz kapcsol.')
    expect(lines[0]).toContain('A Marveen dashboardon hagyd jóvá ezzel a kóddal.')
    expect(lines[1]).toContain("${result.isResend ? 'Még várakozik' : 'Párosítás szükséges'}")
    expect(lines[1]).toContain('Marveen dashboardon lehet jóváhagyni ezzel a kóddal: ${result.code}')
    for (const l of lines) {
      expect(l.trimStart().startsWith('await ctx.reply(`')).toBe(true)
      expect(l).toContain('); return ' + MARKER)
      // Nothing new in the chat (Samu 73716 (1)): no Claude Code, no URL, no name, no agent list.
      expect(l).not.toMatch(/Claude Code|https?:|localhost|\/telegram:access/)
    }
    // Each line sits right before the plugin's own answer, which stays as published.
    const all = text.split('\n')
    const start = all.indexOf(lines[0])
    expect(all[start - 1]).toMatch(/^ *if \(!dmCommandGate\(ctx\)\) return$/)
    expect(all[start + 2]).toContain('This bot bridges Telegram to a Claude Code session.')
    const pair = all.indexOf(lines[1])
    expect(all[pair - 1]).toMatch(/const lead = result\.isResend \? 'Still pending' : 'Pairing required'$/)
    expect(all[pair + 2]).toContain('run in Claude Code:\\n\\n/telegram:access pair ${result.code}')
  })

  it('is idempotent: a second run changes nothing', () => {
    run()
    const once = readFileSync(server, 'utf-8')
    const { state } = run()
    expect(state.files[0].patches.pairtext).toBe('already')
    expect(readFileSync(server, 'utf-8')).toBe(once)
  })

  it('takes English from AGENT_TEXT_LANG=en, and rebuilds its lines when the language changes', () => {
    writeFileSync(join(install, '.env'), 'AGENT_TEXT_LANG=en\n')
    expect(run().state.lang).toBe('en')
    const en = ours(readFileSync(server, 'utf-8'))
    expect(en[0]).toContain('This bot connects to a Marveen agent.')
    expect(en[1]).toContain('approve this pairing in the Marveen dashboard with this code: ${result.code}')
    writeFileSync(join(install, '.env'), 'AGENT_TEXT_LANG=hu\n')
    const { state } = run()
    expect(state.files[0].patches.pairtext).toBe('patched')
    const hu = ours(readFileSync(server, 'utf-8'))
    expect(hu).toHaveLength(2)
    expect(hu[0]).toContain('Ez a bot egy Marveen-ügynökhöz kapcsol.')
  })

  it('falls back to Hungarian for any other value', () => {
    for (const v of ['de', '', 'EN-us', '"']) {
      writeFileSync(join(install, '.env'), `AGENT_TEXT_LANG=${v}\n`)
      expect(run().state.lang).toBe('hu')
    }
  })

  it('gives back the original lines byte-exact when ours are stripped', () => {
    const before = readFileSync(server, 'utf-8')
    run()
    // The other patches write too; ours alone come off by their marker, and what is left equals a run without pairtext.
    const patched = readFileSync(server, 'utf-8')
    expect(strip(patched)).not.toContain(MARKER)
    expect(strip(patched).split('\n').length).toBe(patched.split('\n').length - 2)
    expect(before).toContain('`2. In Claude Code: /telegram:access pair <code>\\n\\n` +')
    expect(strip(patched)).toContain('`2. In Claude Code: /telegram:access pair <code>\\n\\n` +')
  })

  it('leaves the file alone when an anchor moved (a plugin update), and the state file says which', () => {
    // The plugin changed its pairing wording: the pair-reply anchor no longer matches.
    // (the pair branch's own line: the fixture's /status has a similar one, which the d4 patch takes out anyway)
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace('`${lead} — run in Claude Code:', '`${lead} — run this in Claude Code:'))
    const { state, stderr } = run()
    expect(state.files[0].patches.pairtext).toBe('anchor-missing:pair reply')
    const text = readFileSync(server, 'utf-8')
    // All-or-nothing: the /start line is not there either.
    expect(ours(text)).toHaveLength(0)
    expect(stderr).toContain('the pairtext patch left out')
    // The other patches are independent and still applied.
    expect(state.files[0].patches.kbd).toBe('patched')
  })

  it('leaves the file alone when the /start anchor moved', () => {
    writeFileSync(server, readFileSync(FIXTURE, 'utf-8').replace('`2. In Claude Code: /telegram:access pair <code>', '`2. Then: /telegram:access pair <code>'))
    const { state } = run()
    expect(state.files[0].patches.pairtext).toBe('anchor-missing:start reply')
    expect(ours(readFileSync(server, 'utf-8'))).toHaveLength(0)
  })
})
