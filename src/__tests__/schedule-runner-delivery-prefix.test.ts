import { describe, expect, it } from 'vitest'

const { taskDeliveryPrefix, deliveryFallbackClause } = await import('../web/schedule-runner.js')

// The prompt prefix a non-heartbeat scheduled task gets when its delivery
// target resolved. Pinned byte for byte: the agent reads it as its delivery
// instruction, and an unnoticed change sends results somewhere else.

describe('taskDeliveryPrefix (the delivery instruction of a scheduled task)', () => {
  it('Telegram, main agent: chat_id + reply tool, no fallback clause', () => {
    expect(taskDeliveryPrefix('napi-hirek', 'telegram', '42', true))
      .toBe('[Utemezett feladat: napi-hirek] Az eredmenyt kuldd el Telegramon (chat_id: 42, reply tool). ')
  })

  it('Telegram, sub-agent: the same shape', () => {
    expect(taskDeliveryPrefix('riport', 'telegram', '7', false))
      .toBe('[Utemezett feladat: riport] Az eredmenyt kuldd el Telegramon (chat_id: 7, reply tool). ')
  })

  it('Slack, sub-agent: the provider is named, no Telegram fallback', () => {
    expect(taskDeliveryPrefix('riport', 'slack', 'D0123', false))
      .toBe('[Utemezett feladat: riport] Az eredmenyt kuldd el Slacken (chat_id: D0123, reply tool). ')
  })

  it('Slack, main agent: the Telegram fallback clause follows the instruction', () => {
    expect(taskDeliveryPrefix('riport', 'slack', 'D0123', true))
      .toBe(`[Utemezett feladat: riport] Az eredmenyt kuldd el Slacken (chat_id: D0123, reply tool). ${deliveryFallbackClause('slack', true)}`)
  })
})
