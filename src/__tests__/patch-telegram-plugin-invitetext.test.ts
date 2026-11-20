// scripts/patch-telegram-plugin.py, the invitetext patch (INVITEPAIRCODE1120, card 500495b9): the dashboard's invite
// monitor (src/web/channel-invites.ts) approves the oldest pending pairing while an invite is live, but the plugin knows
// nothing of invites, so an invitee was handed a pairing code the monitor made useless seconds later ("lejárt a párosító
// kód", Prorab and Gyula, 2026-11-20). While an invite in invites.json is live, /start invite-... creates the pending
// entry and answers "letting you in", the pair branch answers the same instead of the code, and the approval
// confirmation says "you are in" in the install's language. Without a live invite nothing changes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')
const MARKER = '// MARVEEN-PATCH(invitetext): an invitee gets no pairing code'
const PAIRTEXT_MARKER = '// MARVEEN-PATCH(pairtext): the pairing text names the Marveen dashboard'
const HU = {
  wait: 'Meghívóval érkeztél, beengedlek. Pár másodperc, és szólok, hogy írhatsz.',
  welcome: 'Bent vagy, írhatsz. Amit ide írsz, az ügynökhöz jut.',
  already: 'Már bent vagy, írhatsz.',
}
const EN_WELCOME = 'You are in, go ahead and write. What you send here reaches the agent.'

let install = ''
let script = ''
let cache = ''
let server = ''

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'tg-invitetext-install-'))
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

type State = { lang: string; files: Array<{ status: string; patches: Record<string, string> }> }
function run(): { state: State; stderr: string } {
  const state = join(install, 'store', 'state.json')
  const r = spawnSync('python3', [script, '--state', state, cache], { encoding: 'utf-8', timeout: 30_000 })
  expect(r.status).toBe(0)
  return { state: JSON.parse(readFileSync(state, 'utf-8')), stderr: r.stderr }
}

const ours = (text: string) => text.split('\n').filter((l) => l.endsWith(' ' + MARKER))
const transpile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function syntaxErrors(code: string): string[] {
  const out = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

// The three module-level helper lines, run with fakes for what they reach for (the plugin's fs/path imports, STATE_DIR, gate).
function helpers(patched: string, o: { invites?: unknown; raw?: string; gate?: () => { action: string } } = {}) {
  const lines = ours(patched).filter((l) => /^(const MARVEEN_INVITE_TEXT|function marveenInvite)/.test(l))
  expect(lines).toHaveLength(3)
  const reads: string[] = []
  const gateCalls: unknown[] = []
  const readFileSync = (p: string) => {
    reads.push(p)
    if (o.raw !== undefined) return o.raw
    if (o.invites === undefined) throw new Error('ENOENT')
    return JSON.stringify(o.invites)
  }
  const gate = (ctx: unknown) => { gateCalls.push(ctx); return (o.gate ?? (() => ({ action: 'pair' })))() }
  const api = new Function('readFileSync', 'join', 'STATE_DIR', 'gate',
    transpile(lines.join('\n')) + '\nreturn { live: marveenInviteLive, start: marveenInviteStart, text: MARVEEN_INVITE_TEXT }')(
    readFileSync, (...p: string[]) => p.join('/'), '/state', gate)
  return { ...api, reads, gateCalls }
}
function fakeCtx(match: string | undefined) {
  const replies: string[] = []
  return { ctx: { match, reply: (t: string) => { replies.push(t); return Promise.resolve() } }, replies }
}
const DAY = 24 * 3600 * 1000
const liveInvite = () => ({ invites: { tok1: { createdAt: Date.now() - 1000, expiresAt: Date.now() + DAY, used: false } } })

describe('the invitetext patch', () => {
  it('puts its six lines in four places, Hungarian by default, and the file still parses', () => {
    const { state } = run()
    expect(state.files[0].patches.invitetext).toBe('patched')
    expect(state.files[0].patches.pairtext).toBe('patched')
    const text = readFileSync(server, 'utf-8')
    const lines = ours(text)
    expect(lines).toHaveLength(6)
    expect(syntaxErrors(text)).toEqual([])
    const all = text.split('\n')
    // helpers right before checkApprovals, at module level
    const fn = all.indexOf('function checkApprovals(): void {')
    expect(all.slice(fn - 3, fn).every((l) => l.endsWith(' ' + MARKER))).toBe(true)
    expect(all[fn - 3]).toContain(JSON.stringify(HU.wait))
    // the confirmation: ours first, the plugin's own send kept right under it
    const confirm = all.findIndex((l) => l.includes('MARVEEN_INVITE_TEXT.welcome'))
    expect(all[confirm + 1]).toMatch(/^ *void bot\.api\.sendMessage\(senderId, "Paired! Say hi to Claude\."\)\.then\($/)
    expect(all[confirm]).toMatch(/; continue \/\/ MARVEEN-PATCH\(invitetext\)/)
    // /start: right under the DM gate, ABOVE the pairtext line
    const start = all.findIndex((l) => l.trim().startsWith('if (marveenInviteStart(ctx)) return'))
    expect(all[start - 1]).toMatch(/^ *if \(!dmCommandGate\(ctx\)\) return$/)
    expect(all[start + 1].endsWith(' ' + PAIRTEXT_MARKER)).toBe(true)
    // the pair branch: first line inside it, before the plugin's `const lead` and the pairtext line
    const pair = all.findIndex((l) => l.includes('if (marveenInviteLive()) { await ctx.reply(MARVEEN_INVITE_TEXT.wait); return }'))
    expect(all[pair - 1]).toMatch(/^ *if \(result\.action === 'pair'\) \{$/)
    expect(all[pair + 1]).toMatch(/const lead = result\.isResend/)
  })

  it('is idempotent, and taking it back is deleting its lines', () => {
    run()
    const first = readFileSync(server, 'utf-8')
    const { state, stderr } = run()
    expect(state.files[0].patches.invitetext).toBe('already')
    expect(state.files[0].patches.pairtext).toBe('already')
    expect(readFileSync(server, 'utf-8')).toBe(first)
    expect(stderr).not.toMatch(/invitetext/)
    const back = first.split('\n').filter((l) => !l.endsWith(' ' + MARKER)).join('\n')
    expect(back).not.toMatch(/marveenInvite|MARVEEN_INVITE_TEXT/)
    expect(syntaxErrors(back)).toEqual([])
  })

  it('follows AGENT_TEXT_LANG=en and rebuilds in place when the language changes back', () => {
    run()
    const hu = readFileSync(server, 'utf-8')
    writeFileSync(join(install, '.env'), 'AGENT_TEXT_LANG=en\n')
    const { state } = run()
    expect(state.files[0].patches.invitetext).toBe('patched')
    const en = readFileSync(server, 'utf-8')
    expect(en).toContain(JSON.stringify(EN_WELCOME))
    expect(en).not.toContain(HU.welcome)
    expect(ours(en)).toHaveLength(6)
    writeFileSync(join(install, '.env'), 'AGENT_TEXT_LANG=hu\n')
    run()
    expect(readFileSync(server, 'utf-8')).toBe(hu)
  })

  it('all or nothing: without the approval poller no line goes in, loudly, the other patches still applied', () => {
    const fx = readFileSync(FIXTURE, 'utf-8')
    writeFileSync(server, fx.replace('function checkApprovals(): void {', 'function checkApprovalsMoved(): void {'))
    const { state, stderr } = run()
    expect(state.files[0].patches.invitetext).toBe('anchor-missing:approvals function')
    expect(state.files[0].patches.pairtext).toBe('patched')
    expect(ours(readFileSync(server, 'utf-8'))).toHaveLength(0)
    expect(stderr).toMatch(/invitetext/)
  })

  it('a live invite: /start invite-... makes the pending entry (gate) and answers "letting you in", no code', () => {
    run()
    const h = helpers(readFileSync(server, 'utf-8'), { invites: liveInvite() })
    const c = fakeCtx('invite-AbC123')
    expect(h.start(c.ctx)).toBe(true)
    expect(h.gateCalls).toHaveLength(1)
    expect(c.replies).toEqual([HU.wait])
    expect(h.reads).toEqual(['/state/invites.json'])
    // already approved: told so, nothing else
    const d = helpers(readFileSync(server, 'utf-8'), { invites: liveInvite(), gate: () => ({ action: 'deliver' }) })
    const c2 = fakeCtx('invite-AbC123')
    expect(d.start(c2.ctx)).toBe(true)
    expect(c2.replies).toEqual([HU.already])
    // the plugin's gate drops (third reply, pending cap): silent, and the pairing text is not sent either
    const g = helpers(readFileSync(server, 'utf-8'), { invites: liveInvite(), gate: () => ({ action: 'drop' }) })
    const c3 = fakeCtx('invite-AbC123')
    expect(g.start(c3.ctx)).toBe(true)
    expect(c3.replies).toEqual([])
  })

  it('no live invite, or no invite payload: /start goes on to the pairing text as before, gate untouched', () => {
    run()
    const patched = readFileSync(server, 'utf-8')
    const now = Date.now()
    const cases: Array<[string, Parameters<typeof helpers>[1], string | undefined]> = [
      ['no invites.json', {}, 'invite-x'],
      ['unreadable invites.json', { raw: '{not json' }, 'invite-x'],
      ['only a used invite', { invites: { invites: { a: { createdAt: now - 10, expiresAt: now + DAY, used: true } } } }, 'invite-x'],
      ['only an expired invite', { invites: { invites: { a: { createdAt: now - DAY, expiresAt: now - 1, used: false } } } }, 'invite-x'],
      ['an invite with no expiry', { invites: { invites: { a: { createdAt: now, used: false } } } }, 'invite-x'],
      ['plain /start', { invites: liveInvite() }, ''],
      ['other payload', { invites: liveInvite() }, 'hello'],
      ['no match field', { invites: liveInvite() }, undefined],
    ]
    for (const [name, o, match] of cases) {
      const h = helpers(patched, o)
      const c = fakeCtx(match)
      expect(h.start(c.ctx), name).toBe(false)
      expect(h.gateCalls, name).toHaveLength(0)
      expect(c.replies, name).toEqual([])
    }
    expect(helpers(patched, { invites: liveInvite() }).live()).toBe(true)
    expect(helpers(patched, {}).live()).toBe(false)
  })

  it('the approval confirmation says "you are in" and still removes the marker; a failed send removes it too', async () => {
    run()
    const patched = readFileSync(server, 'utf-8')
    const lines = ours(patched).filter((l) => /^(const MARVEEN_INVITE_TEXT)/.test(l))
    const s = patched.indexOf('function checkApprovals(): void {')
    const e = patched.indexOf('\n}\n', s) + 3
    for (const fails of [false, true]) {
      const sent: Array<[string, string]> = []
      const removed: string[] = []
      const errs: string[] = []
      const bot = { api: { sendMessage: (id: string, t: string) => { sent.push([id, t]); return fails ? Promise.reject(new Error('net')) : Promise.resolve() } } }
      const proc = { stderr: { write: (t: string) => { errs.push(t) } } }
      const check = new Function('bot', 'readdirSync', 'rmSync', 'join', 'APPROVED_DIR', 'process',
        transpile(lines.join('\n') + '\n' + patched.slice(s, e)) + '\nreturn checkApprovals')(
        bot, () => ['111', '222'], (p: string) => { removed.push(p) }, (...p: string[]) => p.join('/'), '/approved', proc)
      check()
      await new Promise((r) => setTimeout(r, 10))
      expect(sent).toEqual([['111', HU.welcome], ['222', HU.welcome]])
      expect(removed.sort()).toEqual(['/approved/111', '/approved/222'])
      expect(errs.length).toBe(fails ? 2 : 0)
    }
  })

  it('the pair branch line: a live invite answers "letting you in" and returns before the code', async () => {
    run()
    const patched = readFileSync(server, 'utf-8')
    const line = ours(patched).find((l) => l.includes('if (marveenInviteLive())'))!
    for (const live of [true, false]) {
      const replies: string[] = []
      const ctx = { reply: (t: string) => { replies.push(t); return Promise.resolve() } }
      const f = new Function('ctx', 'marveenInviteLive', 'MARVEEN_INVITE_TEXT',
        'return (async () => { ' + transpile(line) + '\n await ctx.reply("CODE") })()')
      await f(ctx, () => live, HU)
      expect(replies).toEqual(live ? [HU.wait] : ['CODE'])
    }
  })
})
