import { beforeEach, describe, expect, it, vi } from 'vitest'

// The live sender of the mid-turn command watcher (liveDeps.send). The tick and
// its retry wrapper are pinned in midturn-commands.test.ts through injected
// deps; this pins what the live one hands the channel provider: the topic as
// the fifth argument when there is one, and the plain three-argument call
// (exactly the one before the topics support) when there is none.

const sendMessage = vi.fn(async () => undefined)
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  CHANNEL_TOKEN: 'tok',
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('../channel-provider.js', async (orig) => ({
  ...(await orig<typeof import('../channel-provider.js')>()),
  getProvider: () => ({ sendMessage }),
}))

const { liveDeps } = await import('../web/midturn-commands.js')
const { markIfTestRun } = await import('../test-run-marker.js')

describe('midturn-commands liveDeps.send', () => {
  beforeEach(() => sendMessage.mockClear())

  it('a command written in a topic: the answer goes into that topic', async () => {
    await liveDeps.send('42', 'válasz', '12')
    expect(sendMessage.mock.calls).toEqual([['tok', '42', markIfTestRun('válasz'), undefined, '12']])
  })

  it('a plain chat: three arguments, as before', async () => {
    await liveDeps.send('42', 'válasz')
    expect(sendMessage.mock.calls).toEqual([['tok', '42', markIfTestRun('válasz')]])
  })
})
