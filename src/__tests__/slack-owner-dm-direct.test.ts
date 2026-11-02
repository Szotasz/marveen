// APPROVALSLACK1030 (Samu 66026, Dani 66016 (b)): the confidentiality check before a raw owner DM id is posted to,
// the protection of that id (any change needs the owner's session), and the OLD target told on a change.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerDmVerdict } from '../slack-notify.js'
import { announceSlackTargetChange } from '../notify.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const BOT = 'U0BOTUSR1'
const OWNER = 'U0OWNER01'

/** Deps with a main bot token on disk and a fake Slack answering auth.test and conversations.history. */
function deps(messages: Array<Record<string, unknown>> | null, opts: { token?: boolean; historyOk?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    d: {
      readFile: (p: string) => (p.endsWith('.env') && opts.token !== false ? 'SLACK_BOT_TOKEN=xoxb-test\n' : null),
      fetch: (async (url: string) => {
        const method = String(url).split('/').pop()!
        calls.push(method)
        const body = method === 'auth.test' ? { ok: true, user_id: BOT }
          : method === 'conversations.history' ? (opts.historyOk === false ? { ok: false, error: 'missing_scope' } : { ok: true, messages })
            : { ok: false }
        return { ok: true, status: 200, json: async () => body } as Response
      }) as typeof fetch,
    },
  }
}

describe('ownerDmVerdict', () => {
  it('only our bot and the owner wrote: ok (the measured shape of the owner DM, Marveen 66030)', async () => {
    const { d, calls } = deps([{ user: BOT, bot_id: 'B1' }, { user: OWNER }, { user: BOT }, { user: OWNER }])
    expect(await ownerDmVerdict('D0C74N9SAF6', OWNER, d)).toBe('ok')
    expect(calls).toEqual(['auth.test', 'conversations.history'])
  })

  it('another human wrote there: foreign (do not post)', async () => {
    expect(await ownerDmVerdict('D0C74N9SAF6', OWNER, deps([{ user: OWNER }, { user: 'U0STRANGER' }]).d)).toBe('foreign')
  })

  it('another app\'s bot message (bot_id) does not count as a human', async () => {
    expect(await ownerDmVerdict('D0C74N9SAF6', OWNER, deps([{ user: OWNER }, { user: 'U0OTHERBOT', bot_id: 'B9' }]).d)).toBe('ok')
  })

  it('the check cannot run: unknown (no D id, no owner, no token, an API error)', async () => {
    expect(await ownerDmVerdict('C0TOPIC01', OWNER, deps([]).d)).toBe('unknown')
    expect(await ownerDmVerdict('D0C74N9SAF6', null, deps([]).d)).toBe('unknown')
    expect(await ownerDmVerdict('D0C74N9SAF6', OWNER, deps([], { token: false }).d)).toBe('unknown')
    expect(await ownerDmVerdict('D0C74N9SAF6', OWNER, deps([], { historyOk: false }).d)).toBe('unknown')
  })
})

describe('the owner target is protected and its change announced', () => {
  it('NOTIFY_SLACK_TARGET: ANY change needs the owner\'s session', () => {
    const l = SETTINGS_REGISTRY.find((x) => x.key === 'NOTIFY_SLACK_TARGET')!.loosens!
    expect(l('D0C74N9SAF6', 'D0OTHER01')).toBe(true)
    expect(l('', 'D0OTHER01')).toBe(true)
    expect(l('D0C74N9SAF6', '')).toBe(true)
    expect(l('D0C74N9SAF6', 'D0C74N9SAF6 ')).toBe(false)
  })

  it('the settings route announces a change on both paths (set and remove)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'settings.ts'), 'utf-8')
    expect(src.split("if (key === 'NOTIFY_SLACK_TARGET') void noticeTargetDrift(").length - 1).toBe(2)
  })

  it('announceSlackTargetChange tells the OLD target; nothing when unchanged or there was none; a failure is reported', async () => {
    const sent: Array<[string, string]> = []
    const send = (async (t: string, text: string) => { sent.push([t, text]); return { ok: true } }) as never
    expect(await announceSlackTargetChange('D0C74N9SAF6', 'D0OTHER01', { send })).toEqual({ sent: true })
    expect(sent[0][0]).toBe('D0C74N9SAF6')
    expect(sent[0][1]).toContain('D0C74N9SAF6 -> D0OTHER01')
    expect(await announceSlackTargetChange('D0C74N9SAF6', 'D0C74N9SAF6', { send })).toEqual({ sent: false, reason: 'unchanged' })
    expect(await announceSlackTargetChange('', 'D0OTHER01', { send })).toEqual({ sent: false, reason: 'no_old_target' })
    const failing = (async () => ({ ok: false, error: 'not_in_channel' })) as never
    expect(await announceSlackTargetChange('D0C74N9SAF6', 'D0OTHER01', { send: failing })).toEqual({ sent: false, reason: 'not_in_channel' })
  })
})
