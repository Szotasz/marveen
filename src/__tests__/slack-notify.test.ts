// SLACKATALLAS1006: owner notifications go to Slack topic channels.
// Pure resolution + the send path with an injected fetch/readFile (no network,
// no real tokens), and the notify.ts funnel's Slack-then-Telegram rule.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const {
  resolveSlackTarget, parseChannelMap, resolveOwnerUserId, splitForSlack, sendSlackNotification,
} = await import('../slack-notify.js')
const { deliverWithSlack } = await import('../notify.js')

const OWNER = 'U08OWNER01'
const MAP = { napindito: 'C0NAPINDIT', fejlesztes: 'C0FEJLESZT' }

describe('resolveSlackTarget', () => {
  it('"dm" opens the owner DM from the owner USER id (a D-id is per bot pair)', () => {
    expect(resolveSlackTarget('dm', MAP, OWNER)).toEqual({ kind: 'dm', userId: OWNER })
  })
  it('"dm" without a known owner resolves to nothing, never a guess', () => {
    expect(resolveSlackTarget('dm', MAP, null)).toBeNull()
  })
  it('a channel name resolves through the store map, with or without #', () => {
    expect(resolveSlackTarget('napindito', MAP, OWNER)).toEqual({ kind: 'channel', id: 'C0NAPINDIT' })
    expect(resolveSlackTarget('#fejlesztes', MAP, OWNER)).toEqual({ kind: 'channel', id: 'C0FEJLESZT' })
  })
  it('a raw C/G/D id passes as given; an unknown name is unresolved', () => {
    expect(resolveSlackTarget('C0RAWCHAN1', MAP, OWNER)).toEqual({ kind: 'channel', id: 'C0RAWCHAN1' })
    expect(resolveSlackTarget('nincsilyen', MAP, OWNER)).toBeNull()
  })
})

describe('parseChannelMap / resolveOwnerUserId / splitForSlack', () => {
  it('the map keeps only entries whose value is a Slack channel id', () => {
    expect(parseChannelMap('{"a":"C0AAAAAAA","b":"nope","c":5}')).toEqual({ a: 'C0AAAAAAA' })
    expect(parseChannelMap('not json')).toEqual({})
    expect(parseChannelMap(null)).toEqual({})
  })
  it('owner id: explicit setting first, else exactly ONE allowFrom entry', () => {
    expect(resolveOwnerUserId(OWNER, null)).toBe(OWNER)
    expect(resolveOwnerUserId('', JSON.stringify({ allowFrom: [OWNER] }))).toBe(OWNER)
    expect(resolveOwnerUserId('', JSON.stringify({ allowFrom: [OWNER, 'U0SECOND1'] }))).toBeNull()
    expect(resolveOwnerUserId('', null)).toBeNull()
  })
  it('long text is split under the Slack chunk size, on a newline when possible', () => {
    const parts = splitForSlack('a'.repeat(30) + '\n' + 'b'.repeat(30), 40)
    expect(parts).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })
})

// A fake Slack + filesystem. Files are matched by path suffix so the real
// PROJECT_ROOT / home do not matter.
function world(opts: { mainToken?: string; agentTokens?: Record<string, string>; access?: unknown; map?: unknown; postError?: Record<string, string> }) {
  const calls: { token: string; method: string; body: Record<string, unknown> }[] = []
  const readFile = (p: string): string | null => {
    if (p.endsWith('/slack-channels.json')) return opts.map === undefined ? JSON.stringify(MAP) : JSON.stringify(opts.map)
    for (const [a, t] of Object.entries(opts.agentTokens ?? {})) {
      if (p.endsWith(`/agents/${a}/.claude/channels/slack/.env`)) return `SLACK_BOT_TOKEN=${t}\n`
    }
    if (/\/\.claude\/channels\/slack\/\.env$/.test(p) && !p.includes('/agents/')) return opts.mainToken ? `SLACK_BOT_TOKEN=${opts.mainToken}\n` : null
    if (/\/\.claude\/channels\/slack\/access\.json$/.test(p) && !p.includes('/agents/')) return JSON.stringify(opts.access ?? { allowFrom: [OWNER] })
    return null
  }
  const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const method = url.split('/api/')[1]
    const token = init.headers.Authorization.replace('Bearer ', '')
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ token, method, body })
    if (method === 'conversations.open') return { ok: true, json: async () => ({ ok: true, channel: { id: 'D0DMCHAN01' } }) }
    const err = opts.postError?.[token]
    return { ok: true, json: async () => (err ? { ok: false, error: err } : { ok: true }) }
  }) as unknown as typeof fetch
  return { calls, deps: { readFile, fetch: fetchFn } }
}

describe('sendSlackNotification', () => {
  it('an agent posts with ITS OWN bot token', async () => {
    const w = world({ mainToken: 'xoxb-main', agentTokens: { boni: 'xoxb-boni' } })
    const r = await sendSlackNotification('napindito', 'szia', { sender: 'boni', deps: w.deps })
    expect(r).toMatchObject({ ok: true, via: 'own', channel: 'C0NAPINDIT' })
    expect(w.calls.map((c) => [c.token, c.method])).toEqual([['xoxb-boni', 'chat.postMessage']])
    expect(w.calls[0].body.text).toBe('szia')
  })

  it('own bot not in the channel -> the MAIN bot posts, with the sender name in front', async () => {
    const w = world({ mainToken: 'xoxb-main', agentTokens: { geri: 'xoxb-geri' }, postError: { 'xoxb-geri': 'not_in_channel' } })
    const r = await sendSlackNotification('fejlesztes', 'kesz', { sender: 'geri', deps: w.deps })
    expect(r).toMatchObject({ ok: true, via: 'main' })
    expect(w.calls[1]).toMatchObject({ token: 'xoxb-main', method: 'chat.postMessage' })
    expect(w.calls[1].body.text).toBe('[geri] kesz')
  })

  it('a sender without a Slack token goes through the main bot, attributed', async () => {
    const w = world({ mainToken: 'xoxb-main' })
    const r = await sendSlackNotification('napindito', 'x', { sender: 'heartbeat', deps: w.deps })
    expect(r).toMatchObject({ ok: true, via: 'main' })
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0].body.text).toBe('[heartbeat] x')
  })

  it('a non-fallback error from the own bot is reported, not retried as the main bot', async () => {
    const w = world({ mainToken: 'xoxb-main', agentTokens: { boni: 'xoxb-boni' }, postError: { 'xoxb-boni': 'msg_too_long' } })
    const r = await sendSlackNotification('napindito', 'x', { sender: 'boni', deps: w.deps })
    expect(r).toMatchObject({ ok: false, error: 'msg_too_long' })
    expect(w.calls).toHaveLength(1)
  })

  it('"dm" opens the owner DM first and posts to the returned D-id', async () => {
    const w = world({ mainToken: 'xoxb-main' })
    const r = await sendSlackNotification('dm', 'surgos', { deps: w.deps })
    expect(r).toMatchObject({ ok: true, channel: 'D0DMCHAN01' })
    expect(w.calls.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage'])
    expect(w.calls[0].body.users).toBe(OWNER)
  })

  it('an unresolved target or a missing token fails without a guess', async () => {
    const w = world({ mainToken: 'xoxb-main' })
    expect(await sendSlackNotification('ismeretlen', 'x', { deps: w.deps })).toMatchObject({ ok: false, error: 'unresolved_target:ismeretlen' })
    expect(w.calls).toHaveLength(0)
    const n = world({})
    expect(await sendSlackNotification('napindito', 'x', { deps: n.deps })).toMatchObject({ ok: false, error: 'no_slack_token' })
  })
})

describe('notify.ts funnel: Slack then Telegram', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })
  const run = async (slackOk: boolean) => {
    const telegram = vi.fn(async () => {})
    const send = vi.fn(async () => (slackOk ? { ok: true } : { ok: false, error: 'boom' }))
    await deliverWithSlack('owner', 'hello', telegram, send as never)
    return { telegram, send }
  }

  it('no Slack target configured -> Telegram only, exactly as before', async () => {
    const { telegram, send } = await run(true)
    expect(send).not.toHaveBeenCalled()
    expect(telegram).toHaveBeenCalledTimes(1)
  })
  it('target set, NOTIFY_TELEGRAM default -> BOTH (the transition rule)', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const { telegram, send } = await run(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(telegram).toHaveBeenCalledTimes(1)
  })
  it('NOTIFY_TELEGRAM=0 and Slack OK -> Slack only', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'; settings.NOTIFY_TELEGRAM = '0'
    const { telegram } = await run(true)
    expect(telegram).not.toHaveBeenCalled()
  })
  it('NOTIFY_TELEGRAM=0 but Slack FAILS -> Telegram anyway (nothing is lost)', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'; settings.NOTIFY_TELEGRAM = '0'
    const { telegram } = await run(false)
    expect(telegram).toHaveBeenCalledTimes(1)
  })
  it('alerts use NOTIFY_SLACK_ALERT_TARGET, falling back to the owner target', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const send = vi.fn(async (_t: string) => ({ ok: true }))
    await deliverWithSlack('alert', 'a', async () => {}, send as never)
    expect(send.mock.calls[0][0]).toBe('dm')
    settings.NOTIFY_SLACK_ALERT_TARGET = 'fejlesztes'
    await deliverWithSlack('alert', 'a', async () => {}, send as never)
    expect(send.mock.calls[1][0]).toBe('fejlesztes')
  })
})

describe('notify.ts funnel: degradation and Slack-only security events', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })
  it('notifySecurityEvent is not silenced on a Slack-only install (the old Telegram-only gate is gone)', () => {
    const src = readFileSync(join(__dirname, '..', 'notify.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export async function notifySecurityEvent'))
    expect(fn).toContain("if (!hasTelegram && !(await slackTargetFor('owner'))) return")
    expect(fn).not.toMatch(/if \(!CHANNEL_TOKEN \|\| !resolveAlertOwnerChat\([^)]*\)\.chatId\) return/)
  })
})

describe('wiring', () => {
  const ROOT = join(__dirname, '..', '..')
  const NOTIFY = readFileSync(join(ROOT, 'src', 'notify.ts'), 'utf-8')
  const SH = readFileSync(join(ROOT, 'scripts', 'notify.sh'), 'utf-8')
  it('notifyOwner and notifyChannel both go through deliverWithSlack (one funnel, no double Slack)', () => {
    expect(NOTIFY).toContain("return deliverWithSlack('owner', text, () => telegramOwner(text))")
    expect(NOTIFY).toContain("return deliverWithSlack('alert', text, () => {")
    // The alert path must NOT call notifyOwner (that would post to Slack twice).
    const alert = NOTIFY.slice(NOTIFY.indexOf('export async function notifyChannel'), NOTIFY.indexOf('export async function notifyOwner'))
    expect(alert).not.toContain('notifyOwner(')
  })
  it('notify.sh asks the Slack helper first; a skip verdict after a FAILED Slack send is a failure, never a success', () => {
    // The helper says "skip" after a failure only under NOTIFY_TELEGRAM_FALLBACK=0
    // (behaviour pinned in notify-telegram-fallback-off.test.ts); here the order.
    const slackAt = SH.indexOf('slack-notify.mjs" --kind owner')
    const tgAt = SH.indexOf('send_telegram_message "$TOKEN"')
    const failAt = SH.indexOf('NOTIFY_TELEGRAM_FALLBACK=0). Szolj a fo agensnek')
    const okAt = SH.indexOf('echo "Ertesites elkuldve (Slack)."')
    expect(slackAt).toBeGreaterThan(-1)
    expect(slackAt).toBeLessThan(tgAt)
    expect(failAt).toBeGreaterThan(-1)
    expect(failAt).toBeLessThan(okAt)
  })
})
