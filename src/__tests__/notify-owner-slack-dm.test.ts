import { beforeEach, describe, expect, it, vi } from 'vitest'

// APPROVALSLACK1030: sendOwnerSlackDm, the approval request's Slack path. It sends only when Slack is the owner's
// channel (a NOTIFY_SLACK_TARGET), always to the owner's DM (not the topic channel), and reports the result instead
// of falling back to Telegram.
const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const { sendOwnerSlackDm } = await import('../notify.js')

describe('sendOwnerSlackDm', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })

  it('no Slack target: not attempted, nothing sent', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('x', send as never)).toEqual({ attempted: false, sent: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('a Slack target (even a topic channel): the request goes to the owner DM, with the owner id setting', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'napindito', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never)).toEqual({ attempted: true, sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [target, , opts] = send.mock.calls[0] as unknown as [string, string, { ownerUserId: string; raw: boolean }]
    expect(target).toBe('dm')
    expect(opts.ownerUserId).toBe('U0OWNER1')
    expect(opts.raw).toBe(true)
  })

  it('a failed send is reported with its error', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const send = vi.fn(async () => ({ ok: false, error: 'no_slack_token' }))
    expect(await sendOwnerSlackDm('x', send as never)).toEqual({ attempted: true, sent: false, error: 'no_slack_token' })
  })

  // APPROVALSLACK1030 (Samu 66026): the bot has no im:write, so the 'dm' path (conversations.open) fails; a raw D id
  // in NOTIFY_SLACK_TARGET is posted to directly, after the confidentiality check (Dani 66016 (b)).
  it('a raw D id target: posted to that id directly (no conversations.open), after the check said ok', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    const verdict = vi.fn(async () => 'ok' as const)
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict })).toEqual({ attempted: true, sent: true })
    expect(verdict).toHaveBeenCalledWith('D0C74N9SAF6', 'U0OWNER1')
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe('D0C74N9SAF6')
  })

  it('someone other than the owner writes in that channel: NOT sent, reported', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'foreign' })).toEqual({ attempted: true, sent: false, error: 'dm_channel_foreign' })
    expect(send).not.toHaveBeenCalled()
  })

  it('the check could not run: sent anyway (the id\'s source is protected)', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'unknown' })).toEqual({ attempted: true, sent: true })
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe('D0C74N9SAF6')
  })

  it('a C id or a name is not a DM: the owner DM path stays (no check)', async () => {
    for (const t of ['C0TOPIC01', 'napindito', 'dm']) {
      settings.NOTIFY_SLACK_TARGET = t
      const send = vi.fn(async () => ({ ok: true }))
      const verdict = vi.fn(async () => 'ok' as const)
      await sendOwnerSlackDm('x', send as never, { verdict })
      expect((send.mock.calls[0] as unknown as [string])[0]).toBe('dm')
      expect(verdict).not.toHaveBeenCalled()
    }
  })
})
