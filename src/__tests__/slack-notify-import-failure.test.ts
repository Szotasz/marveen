// SLACKATALLAS1006 (Geri, #1745 review): if dist/slack-notify.js cannot be
// loaded (a half-finished build), a configured Slack target must not cost the
// notification -- the funnel falls back to Telegram.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => ({ NOTIFY_SLACK_TARGET: 'dm', NOTIFY_TELEGRAM: '0' } as Record<string, string>)[k] ?? '',
}))
vi.mock('../slack-notify.js', () => { throw new Error('dist/slack-notify.js missing') })

const { deliverWithSlack } = await import('../notify.js')

describe('Slack module load failure', () => {
  it('degrades to Telegram even with NOTIFY_TELEGRAM=0', async () => {
    const telegram = vi.fn(async () => {})
    await deliverWithSlack('owner', 'x', telegram)
    expect(telegram).toHaveBeenCalledTimes(1)
  })
})
