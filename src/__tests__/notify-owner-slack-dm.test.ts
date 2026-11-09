import { beforeEach, describe, expect, it, vi } from 'vitest'

// APPROVALSLACK1030: sendOwnerSlackDm, the approval request's Slack path. It sends only when Slack is the owner's
// channel (a NOTIFY_SLACK_TARGET), always to the owner's DM (not the topic channel), and reports the result instead
// of falling back to Telegram.
const settings: Record<string, string> = {}
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))

const { sendOwnerSlackDm, noticeTargetDrift } = await import('../notify.js')
const noDrift = async () => false

describe('sendOwnerSlackDm', () => {
  beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k] })

  it('no Slack target: not attempted, nothing sent', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('x', send as never, { drift: noDrift })).toEqual({ attempted: false, sent: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('a Slack target (even a topic channel): the request goes to the owner DM, with the owner id setting', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'napindito', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never, { drift: noDrift })).toEqual({ attempted: true, sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [target, , opts] = send.mock.calls[0] as unknown as [string, string, { ownerUserId: string; raw: boolean }]
    expect(target).toBe('dm')
    expect(opts.ownerUserId).toBe('U0OWNER1')
    expect(opts.raw).toBe(true)
  })

  it('a failed send is reported with its error', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const send = vi.fn(async () => ({ ok: false, error: 'no_slack_token' }))
    expect(await sendOwnerSlackDm('x', send as never, { drift: noDrift })).toEqual({ attempted: true, sent: false, error: 'no_slack_token' })
  })

  // APPROVALSLACK1030 (Samu 66026): the bot has no im:write, so the 'dm' path (conversations.open) fails; a raw D id
  // in NOTIFY_SLACK_TARGET is posted to directly, after the confidentiality check (Dani 66016 (b)).
  it('a raw D id target: posted to that id directly (no conversations.open), after the check said ok', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    const verdict = vi.fn(async () => 'ok' as const)
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict, drift: noDrift })).toEqual({ attempted: true, sent: true })
    expect(verdict).toHaveBeenCalledWith('D0C74N9SAF6', 'U0OWNER1')
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe('D0C74N9SAF6')
  })

  it('someone other than the owner writes in that channel: NOT sent, reported', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'foreign', drift: noDrift })).toEqual({ attempted: true, sent: false, error: 'dm_channel_foreign' })
    expect(send).not.toHaveBeenCalled()
  })

  it('the check could not run: sent anyway (the id\'s source is protected)', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0C74N9SAF6', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const send = vi.fn(async () => ({ ok: true }))
    expect(await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'unknown', drift: noDrift })).toEqual({ attempted: true, sent: true })
    expect((send.mock.calls[0] as unknown as [string])[0]).toBe('D0C74N9SAF6')
  })

  it('a C id or a name is not a DM: the owner DM path stays (no check)', async () => {
    for (const t of ['C0TOPIC01', 'napindito', 'dm']) {
      settings.NOTIFY_SLACK_TARGET = t
      const send = vi.fn(async () => ({ ok: true }))
      const verdict = vi.fn(async () => 'ok' as const)
      await sendOwnerSlackDm('x', send as never, { verdict, drift: noDrift })
      expect((send.mock.calls[0] as unknown as [string])[0]).toBe('dm')
      expect(verdict).not.toHaveBeenCalled()
    }
  })

  // Dani 66036: a target changed AROUND the settings route (a direct file write) is caught at the next owner DM: the
  // OLD target is told FIRST, then the request goes to the new one.
  it('a target changed around the route: the next owner DM first tells the OLD target, then sends', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: 'D0NEWTARGET', SLACK_OWNER_USER_ID: 'U0OWNER1' })
    const order: string[] = []
    let stored: string | null = 'D0OLDTARGET'
    const drift = (t: string) => noticeTargetDrift(t, {
      read: () => stored, write: (v) => { stored = v },
      announce: async (o, n) => { order.push(`announce ${o}->${n}`) },
    })
    const send = vi.fn(async (t: string) => { order.push(`send ${t}`); return { ok: true } })
    await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'ok', drift })
    expect(order).toEqual(['announce D0OLDTARGET->D0NEWTARGET', 'send D0NEWTARGET'])
    expect(stored).toBe('D0NEWTARGET')
    order.length = 0
    await sendOwnerSlackDm('kérés', send as never, { verdict: async () => 'ok', drift })
    expect(order).toEqual(['send D0NEWTARGET'])
  })
})

describe('noticeTargetDrift', () => {
  const run = (stored: string | null, current: string, fallbackOld?: string) => {
    let rec = stored
    const said: string[] = []
    return noticeTargetDrift(current, { fallbackOld, read: () => rec, write: (v) => { rec = v }, announce: async (o, n) => { said.push(`${o}->${n}`) } })
      .then((changed) => ({ changed, rec, said }))
  }
  it('first sight (no record, no old value): records only', async () => {
    expect(await run(null, 'D0A1B2C3D')).toEqual({ changed: false, rec: 'D0A1B2C3D', said: [] })
  })
  it('unchanged: nothing said', async () => {
    expect(await run('D0A1B2C3D', 'D0A1B2C3D')).toEqual({ changed: false, rec: 'D0A1B2C3D', said: [] })
  })
  it('changed: the old target is told, the new one recorded', async () => {
    expect(await run('D0A1B2C3D', 'D0X9Y8Z7W')).toEqual({ changed: true, rec: 'D0X9Y8Z7W', said: ['D0A1B2C3D->D0X9Y8Z7W'] })
  })
  it('the route gives the old value when there is no record yet', async () => {
    expect(await run(null, 'D0X9Y8Z7W', 'D0A1B2C3D')).toEqual({ changed: true, rec: 'D0X9Y8Z7W', said: ['D0A1B2C3D->D0X9Y8Z7W'] })
  })
})
