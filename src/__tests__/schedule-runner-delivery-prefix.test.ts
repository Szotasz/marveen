import { describe, expect, it } from 'vitest'

const { taskDeliveryPrefix, deliveryFallbackClause, resolveTaskTopicThreadId } = await import('../web/schedule-runner.js')

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

describe('taskDeliveryPrefix with a Telegram topic', () => {
  it('no topic (null) is exactly the text above', () => {
    expect(taskDeliveryPrefix('napi-hirek', 'telegram', '42', true, null))
      .toBe(taskDeliveryPrefix('napi-hirek', 'telegram', '42', true))
  })

  it('a topic adds message_thread_id next to the chat_id', () => {
    expect(taskDeliveryPrefix('napi-hirek', 'telegram', '42', true, 22200))
      .toBe('[Utemezett feladat: napi-hirek] Az eredmenyt kuldd el Telegramon (chat_id: 42, message_thread_id: 22200, reply tool). ')
  })
})

describe('resolveTaskTopicThreadId (task-config telegramTopic -> thread id)', () => {
  const tg = { provider: 'telegram' as const, chatId: '42' }
  const found = (threadId: number) => (name: string, chatId: string) => (chatId === '42' && name.toLowerCase() === 'hírek' ? { name: 'Hírek', threadId } : null)

  it('no telegramTopic: no topic, nothing to report', () => {
    expect(resolveTaskTopicThreadId({}, tg, true, true, found(7))).toEqual({ threadId: null })
  })

  it('switch off: the field is ignored silently, the prefix stays as it was', () => {
    expect(resolveTaskTopicThreadId({ telegramTopic: 'Hírek' }, tg, true, false, found(7))).toEqual({ threadId: null })
  })

  it('switch on, main agent, Telegram, known name: its thread id', () => {
    expect(resolveTaskTopicThreadId({ telegramTopic: 'hírek' }, tg, true, true, found(7))).toEqual({ threadId: 7 })
  })

  it('an unknown name is reported, and the result goes to the chat without a topic', () => {
    const r = resolveTaskTopicThreadId({ telegramTopic: 'Nincs ilyen' }, tg, true, true, found(7))
    expect(r.threadId).toBeNull()
    expect(r.problem).toMatch(/no topic of this name/)
  })

  it('a sub-agent gets no topic (named topics belong to the main bot\'s chat)', () => {
    const r = resolveTaskTopicThreadId({ telegramTopic: 'Hírek' }, tg, false, true, found(7))
    expect(r.threadId).toBeNull()
    expect(r.problem).toMatch(/only the main agent/)
  })

  it('a task delivered on another provider gets no topic', () => {
    const r = resolveTaskTopicThreadId({ telegramTopic: 'Hírek' }, { provider: 'slack', chatId: '42' }, true, true, found(7))
    expect(r.threadId).toBeNull()
    expect(r.problem).toMatch(/delivers on slack/)
  })

  it('the lookup is keyed by the delivery chat: another chat finds nothing', () => {
    const r = resolveTaskTopicThreadId({ telegramTopic: 'Hírek' }, { provider: 'telegram', chatId: '43' }, true, true, found(7))
    expect(r.threadId).toBeNull()
  })
})
