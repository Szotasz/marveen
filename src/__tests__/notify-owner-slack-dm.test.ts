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
    const [target, , opts] = send.mock.calls[0] as unknown as [string, string, { ownerUserId: string }]
    expect(target).toBe('dm')
    expect(opts.ownerUserId).toBe('U0OWNER1')
  })

  it('a failed send is reported with its error', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const send = vi.fn(async () => ({ ok: false, error: 'no_slack_token' }))
    expect(await sendOwnerSlackDm('x', send as never)).toEqual({ attempted: true, sent: false, error: 'no_slack_token' })
  })
})
