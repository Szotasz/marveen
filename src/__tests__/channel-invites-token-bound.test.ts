// INVITETOKENBIND1120 (card 1fff5453): the invite monitor approves a Telegram pending entry ONLY when its sender came
// with that live invite's own token, i.e. the patched plugin left invite-claims/<senderId> = sha256(token). Before, ANY
// sender who messaged the bot while an invite was live (24 h) took it. Slack approves nothing automatically
// (SLACKINVBIND1120). Everything runs in a temp dir; the main agent's state dirs are pointed into it too.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'invite-bind-'))
const AGENTS = join(ROOT, 'agents')
process.env.TELEGRAM_STATE_DIR = join(ROOT, 'main-telegram')
process.env.SLACK_STATE_DIR = join(ROOT, 'main-slack')

const { runInviteMonitorTick } = await import('../web/channel-invites.js')
const { logger } = await import('../logger.js')

const TOK_A = 'AAAAAAAAAAAAAAAAAAAAAA'
const TOK_B = 'BBBBBBBBBBBBBBBBBBBBBB'
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
const DAY = 24 * 3600 * 1000

function dir(provider = 'telegram', agent = 'a'): string {
  return join(AGENTS, agent, '.claude', 'channels', provider)
}
function setup(o: { provider?: string; pending: Record<string, { senderId: string; createdAt: number }>; tokens: string[]; claims?: Record<string, string> }) {
  const d = dir(o.provider)
  mkdirSync(d, { recursive: true })
  const now = Date.now()
  const pending = Object.fromEntries(Object.entries(o.pending).map(([code, p]) => [code, { ...p, chatId: p.senderId, expiresAt: now + 3600_000, replies: 1 }]))
  writeFileSync(join(d, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending }))
  writeFileSync(join(d, 'invites.json'), JSON.stringify({ invites: Object.fromEntries(o.tokens.map((t, i) => [t, { createdAt: now - 1000 + i, expiresAt: now + DAY, used: false }])) }))
  if (o.claims) {
    mkdirSync(join(d, 'invite-claims'), { recursive: true })
    for (const [id, v] of Object.entries(o.claims)) writeFileSync(join(d, 'invite-claims', id), v + '\n')
  }
  return d
}
const read = (d: string) => ({
  access: JSON.parse(readFileSync(join(d, 'access.json'), 'utf-8')),
  invites: JSON.parse(readFileSync(join(d, 'invites.json'), 'utf-8')).invites,
})

beforeEach(() => { rmSync(AGENTS, { recursive: true, force: true }); mkdirSync(AGENTS, { recursive: true }) })
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('the invite monitor binds an approval to the invite token (Telegram)', () => {
  it('a stranger who messages the bot while an invite is live is NOT let in (no claim)', () => {
    const d = setup({ pending: { c1: { senderId: '666', createdAt: 1 } }, tokens: [TOK_A] })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1'])
    expect(access.pending.c1.senderId).toBe('666') // still an ordinary pairing request for the dashboard code
    expect(invites[TOK_A].used).toBe(false)
    expect(access.dmPolicy).toBe('pairing')
    expect(existsSync(join(d, 'approved', '666'))).toBe(false)
  })

  it('the sender with a claim of a live token is let in: allowFrom, pending row gone, invite used by them, claim gone, approved marker', () => {
    const d = setup({ pending: { c1: { senderId: '4242', createdAt: 1 } }, tokens: [TOK_A], claims: { '4242': sha(TOK_A) } })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1', '4242'])
    expect(access.pending.c1).toBeUndefined()
    expect(invites[TOK_A]).toMatchObject({ used: true, usedBy: '4242' })
    expect(access.dmPolicy).toBe('allowlist')
    expect(existsSync(join(d, 'invite-claims', '4242'))).toBe(false)
    expect(existsSync(join(d, 'approved', '4242'))).toBe(true)
  })

  it('the stranger who wrote FIRST does not take the invite from the invitee: only the claimed one is approved', () => {
    const d = setup({ pending: { c0: { senderId: '666', createdAt: 1 }, c1: { senderId: '4242', createdAt: 2 } }, tokens: [TOK_A], claims: { '4242': sha(TOK_A) } })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1', '4242'])
    expect(access.pending.c0.senderId).toBe('666')
    expect(invites[TOK_A].usedBy).toBe('4242')
  })

  it('two invites, two invitees: each takes their own token, in one tick', () => {
    const d = setup({ pending: { c1: { senderId: '10', createdAt: 1 }, c2: { senderId: '20', createdAt: 2 } }, tokens: [TOK_A, TOK_B], claims: { '10': sha(TOK_B), '20': sha(TOK_A) } })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom.sort()).toEqual(['1', '10', '20'])
    expect(invites[TOK_A].usedBy).toBe('20')
    expect(invites[TOK_B].usedBy).toBe('10')
  })

  it('one token, two senders who both hold its claim, in one tick: only the oldest gets in, the other stays pending', () => {
    const d = setup({ pending: { c1: { senderId: '10', createdAt: 1 }, c2: { senderId: '20', createdAt: 2 } }, tokens: [TOK_A], claims: { '10': sha(TOK_A), '20': sha(TOK_A) } })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1', '10'])
    expect(Object.keys(access.pending)).toEqual(['c2'])
    expect(invites[TOK_A].usedBy).toBe('10')
    expect(existsSync(join(d, 'approved', '20'))).toBe(false)
  })

  it('a claim that matches no live token (guessed, used, or another install\'s) lets nobody in', () => {
    const d = setup({ pending: { c1: { senderId: '4242', createdAt: 1 } }, tokens: [TOK_A], claims: { '4242': sha(TOK_B) } })
    runInviteMonitorTick('main', AGENTS)
    expect(read(d).access.allowFrom).toEqual(['1'])
    expect(read(d).invites[TOK_A].used).toBe(false)
  })

  it('a malformed claim, or one older than an hour, lets nobody in; the stale one is pruned', () => {
    const d = setup({ pending: { c1: { senderId: '4242', createdAt: 1 }, c2: { senderId: '77', createdAt: 2 } }, tokens: [TOK_A], claims: { '4242': 'not-a-hash', '77': sha(TOK_A) } })
    const old = (Date.now() - 2 * 3600_000) / 1000
    utimesSync(join(d, 'invite-claims', '77'), old, old)
    runInviteMonitorTick('main', AGENTS)
    expect(read(d).access.allowFrom).toEqual(['1'])
    expect(existsSync(join(d, 'invite-claims', '77'))).toBe(false)
  })

  it('the approval log line names the sender, never the token', () => {
    const spy = vi.spyOn(logger, 'info')
    setup({ pending: { c1: { senderId: '4242', createdAt: 1 } }, tokens: [TOK_A], claims: { '4242': sha(TOK_A) } })
    runInviteMonitorTick('main', AGENTS)
    const calls = JSON.stringify(spy.mock.calls)
    expect(calls).toContain('Channel invite auto-approved')
    expect(calls).not.toContain(TOK_A)
    spy.mockRestore()
  })
})

describe('Slack approves nothing automatically (SLACKINVBIND1120: no token can reach a claim there)', () => {
  it('a live invite and a pending sender: not let in, the code stays for the owner, the invite stays unused', () => {
    const d = setup({ provider: 'slack', pending: { c1: { senderId: 'U9', createdAt: 1 } }, tokens: [TOK_A] })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1'])
    expect(Object.keys(access.pending)).toEqual(['c1'])
    expect(access.dmPolicy).toBe('pairing')
    expect(invites[TOK_A].used).toBe(false)
    expect(existsSync(join(d, 'approved', 'U9'))).toBe(false)
  })

  it('one live invite, two senders in one tick: neither gets in, both codes stay for the owner', () => {
    const d = setup({ provider: 'slack', pending: { c1: { senderId: 'U1', createdAt: 1 }, c2: { senderId: 'U2', createdAt: 2 } }, tokens: [TOK_A] })
    runInviteMonitorTick('main', AGENTS)
    const { access, invites } = read(d)
    expect(access.allowFrom).toEqual(['1'])
    expect(Object.keys(access.pending).sort()).toEqual(['c1', 'c2'])
    expect(invites[TOK_A].used).toBe(false)
  })
})
