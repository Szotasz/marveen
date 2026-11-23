// DASHUSERGATE1123: sendOwnerPrivate carries the password reset code. It may reach ONLY a private one-to-one chat with
// the owner: the Slack DM (never NOTIFY_SLACK_TARGET, which may be a channel) or a private Telegram chat (never a
// group), and never the Gromzo relay or the "undelivered" signal that would hand the text to an agent.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings: Record<string, string> = {}
const state = { chat: '1268077055' }
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: (k: string) => settings[k] ?? '' }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), CHANNEL_PROVIDER: 'telegram', CHANNEL_TOKEN: 'test-token' }))
vi.mock('../owner-chat.js', async (orig) => ({
  ...(await orig<typeof import('../owner-chat.js')>()),
  resolveAlertDeliveryChat: () => ({ chatId: state.chat }),
}))

const { sendOwnerPrivate } = await import('../notify.js')

const ok = () => vi.fn(async () => ({ ok: true }))
const fail = (error: string) => vi.fn(async () => ({ ok: false, error }))

describe('sendOwnerPrivate', () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k]
    state.chat = '1268077055'
  })

  it('Slack is the owner\'s choice: the DM, never the configured target (it may name a channel)', async () => {
    Object.assign(settings, { NOTIFY_SLACK_TARGET: '#general', SLACK_OWNER_USER_ID: 'U123' })
    const send = ok()
    const telegram = vi.fn(async () => true)
    expect(await sendOwnerPrivate('code', { send: send as never, telegram })).toEqual({ sent: true, via: 'slack' })
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0] as unknown[])[0]).toBe('dm')
    expect((send.mock.calls[0] as unknown[])[2]).toMatchObject({ ownerUserId: 'U123' })
    expect(telegram).not.toHaveBeenCalled()
  })

  it('a failed Slack DM falls back to the private Telegram chat, unless the Telegram fallback is off', async () => {
    settings.NOTIFY_SLACK_TARGET = 'dm'
    const telegram = vi.fn(async () => true)
    expect(await sendOwnerPrivate('code', { send: fail('boom') as never, telegram })).toEqual({ sent: true, via: 'telegram' })
    expect(telegram).toHaveBeenCalledWith('1268077055', 'code')
    settings.NOTIFY_TELEGRAM_FALLBACK = '0'
    const telegram2 = vi.fn(async () => true)
    expect(await sendOwnerPrivate('code', { send: fail('boom') as never, telegram: telegram2 })).toEqual({ sent: false, reason: 'failed' })
    expect(telegram2).not.toHaveBeenCalled()
  })

  it('without a Slack target: Telegram first', async () => {
    const send = ok()
    const telegram = vi.fn(async () => true)
    expect(await sendOwnerPrivate('code', { send: send as never, telegram })).toEqual({ sent: true, via: 'telegram' })
    expect(send).not.toHaveBeenCalled()
  })

  it('a group chat (negative id) is never a private chat: Telegram is skipped', async () => {
    state.chat = '-1001234567890'
    const telegram = vi.fn(async () => true)
    expect(await sendOwnerPrivate('code', { send: fail('no_slack_token') as never, telegram })).toEqual({ sent: false, reason: 'no_private_channel' })
    expect(telegram).not.toHaveBeenCalled()
  })

  it('no private chat at all is told apart from a failed send', async () => {
    state.chat = ''
    expect(await sendOwnerPrivate('code', { send: fail('unresolved_target:dm') as never })).toEqual({ sent: false, reason: 'no_private_channel' })
    expect(await sendOwnerPrivate('code', { send: fail('channel_not_found') as never })).toEqual({ sent: false, reason: 'failed' })
    const telegram = vi.fn(async () => false)
    state.chat = '42'
    expect(await sendOwnerPrivate('code', { send: fail('no_slack_token') as never, telegram })).toEqual({ sent: false, reason: 'failed' })
  })
})
