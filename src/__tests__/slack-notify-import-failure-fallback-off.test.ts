// SLACKATALLAS1006: the half-finished-build fallback (slack-notify-import-failure.test.ts)
// also obeys NOTIFY_TELEGRAM_FALLBACK=0 -- a module that does not load costs the
// notification an error line, not a Telegram message.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => ({ NOTIFY_SLACK_TARGET: 'dm', NOTIFY_TELEGRAM_FALLBACK: '0' } as Record<string, string>)[k] ?? '',
}))
vi.mock('../slack-notify.js', () => { throw new Error('dist/slack-notify.js missing') })

const { deliverWithSlack } = await import('../notify.js')

describe('Slack module load failure with the Telegram fallback off', () => {
  it('does NOT reach Telegram', async () => {
    const telegram = vi.fn(async () => {})
    await deliverWithSlack('owner', 'x', telegram)
    expect(telegram).not.toHaveBeenCalled()
  })
})
