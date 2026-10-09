import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { botCommandList, clearCommandsForTest, dispatchCommand, listCommands, renderHelp } from '../web/commands.js'
import { registerBuiltinCommands } from '../web/builtin-commands.js'
import { registerTopicCommands, type TopicCommandDeps } from '../web/topic-commands.js'
import { readTelegramTopics, saveTelegramTopic } from '../web/telegram-topics.js'
import { dispatchForChat } from '../web/routes/commands.js'

const OWNER = 42

async function run(text: string): Promise<string[]> {
  const replies: string[] = []
  await dispatchCommand(text, { reply: async t => { replies.push(t) }, ownerId: OWNER, now: Date.now() })
  return replies
}

describe('/topic is not there while the topics switch is off', () => {
  beforeEach(() => { clearCommandsForTest() })

  it('the builtin registry alone has no /topic: help, menu and dispatch stay as they were', async () => {
    registerBuiltinCommands()
    expect(listCommands().some(e => e.name === 'topic')).toBe(false)
    expect(renderHelp()).not.toContain('/topic')
    expect(botCommandList().some(c => c.command === 'topic')).toBe(false)
    // the hook's route: not a registry command -> not handled, the model gets it as before
    const r = await dispatchForChat('/topic new Hírek', String(OWNER), String(OWNER))
    expect(r).toEqual({ handled: false, outcome: 'unknown', replies: [] })
  })

  it('the dashboard registers it only behind the switch', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    expect(src).toMatch(/if \(telegramTopicsEnabled\(\)\) registerTopicCommands\(\)/)
  })
})

describe('/topic and /topic new', () => {
  let dir: string
  let deps: TopicCommandDeps
  let createTopic: ReturnType<typeof vi.fn<TopicCommandDeps['createTopic']>>

  beforeEach(() => {
    clearCommandsForTest()
    dir = mkdtempSync(join(tmpdir(), 'topic-cmd-'))
    createTopic = vi.fn<TopicCommandDeps['createTopic']>(async () => 22200)
    deps = { createTopic, topicsFile: join(dir, 'telegram-topics.json') }
    registerBuiltinCommands()
    registerTopicCommands(deps)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('/topic new and /topic remove are writes, /topic a read, and all are in /help', () => {
    const topic = listCommands().filter(e => e.name === 'topic')
    expect(topic.map(e => [e.usage ?? '/topic', e.kind])).toEqual([['/topic', 'read'], ['/topic new <név>', 'write'], ['/topic remove <név>', 'write']])
    expect(renderHelp()).toContain('/topic new <név>')
    expect(renderHelp()).toContain('/topic remove <név>')
  })

  it('opens the topic in the owner chat, stores its id under the typed name, and says how to use it', async () => {
    const replies = await run('/topic new Napi   hírek')
    expect(createTopic).toHaveBeenCalledWith(String(OWNER), 'Napi hírek')
    expect(readTelegramTopics(deps.topicsFile)).toEqual({ chatId: String(OWNER), topics: { 'Napi hírek': 22200 } })
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('Napi hírek (azonosító: 22200)')
    expect(replies[0]).toContain('"telegramTopic": "Napi hírek"')
  })

  it('an existing name opens no second topic', async () => {
    saveTelegramTopic(String(OWNER), 'Hírek', 7, deps.topicsFile)
    const replies = await run('/topic new hírek')
    expect(createTopic).not.toHaveBeenCalled()
    expect(replies[0]).toMatch(/Már van ilyen téma: Hírek \(azonosító: 7\)/)
  })

  it('a failed create stores nothing, is not retried, and names the Bot API reason', async () => {
    createTopic.mockRejectedValueOnce(new Error('Telegram API 400: ok:false Bad Request: the chat is not a forum'))
    const replies = await run('/topic new Hírek')
    expect(createTopic).toHaveBeenCalledTimes(1)
    expect(readTelegramTopics(deps.topicsFile)).toBeNull()
    expect(replies[0]).toContain('the chat is not a forum')
    expect(replies[0]).toContain('nézd meg a chatben, létrejött-e')
  })

  it('a non-Telegram error is named by type only (a raw network error can carry the token URL)', async () => {
    createTopic.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED https://api.telegram.org/botSECRET/createForumTopic'))
    const replies = await run('/topic new Hírek')
    expect(replies[0]).toContain('TypeError')
    expect(replies[0]).not.toContain('SECRET')
  })

  it('no name -> usage, nothing created', async () => {
    expect((await run('/topic new'))[0]).toMatch(/^Használat: \/topic new <név>/)
    expect(createTopic).not.toHaveBeenCalled()
  })

  it('/topic lists the stored topics of the owner chat only', async () => {
    expect((await run('/topic'))[0]).toMatch(/Még nincs elnevezett téma/)
    saveTelegramTopic(String(OWNER), 'Hírek', 7, deps.topicsFile)
    expect((await run('/topic'))[0]).toContain('- Hírek (azonosító: 7)')
    saveTelegramTopic('999', 'Más', 8, deps.topicsFile)
    expect((await run('/topic'))[0]).toMatch(/Még nincs elnevezett téma/)
  })

  it('/topic ? explains every form', async () => {
    const help = (await run('/topic ?'))[0]
    expect(help).toContain('/topic new <név>')
    expect(help).toContain('/topic remove <név>')
    expect(help).toContain('telegramTopic')
  })

  it('/topic remove forgets the local row only, says so, and calls no Bot API', async () => {
    saveTelegramTopic(String(OWNER), 'Hírek', 7, deps.topicsFile)
    const replies = await run('/topic remove hírek')
    expect(readTelegramTopics(deps.topicsFile)).toEqual({ chatId: String(OWNER), topics: {} })
    expect(replies[0]).toMatch(/Elfelejtettem: Hírek \(azonosító: 7\)/)
    expect(replies[0]).toContain('a Telegram-téma megmaradt')
    expect(createTopic).not.toHaveBeenCalled()
  })

  it('a stale row (topic deleted by hand) can be removed, and then the name opens a new topic', async () => {
    saveTelegramTopic(String(OWNER), 'Hírek', 7, deps.topicsFile)
    expect((await run('/topic new Hírek'))[0]).toMatch(/Már van ilyen téma/)
    await run('/topic remove Hírek')
    expect((await run('/topic new Hírek'))[0]).toContain('Hírek (azonosító: 22200)')
    expect(createTopic).toHaveBeenCalledTimes(1)
  })

  it('/topic remove of an unknown name or without a name changes nothing', async () => {
    saveTelegramTopic(String(OWNER), 'Hírek', 7, deps.topicsFile)
    expect((await run('/topic remove Nincs'))[0]).toBe('Nincs ilyen elnevezett téma: Nincs. Lásd /topic.')
    expect((await run('/topic remove'))[0]).toBe('Használat: /topic remove <név>')
    expect(readTelegramTopics(deps.topicsFile)?.topics).toEqual({ Hírek: 7 })
  })
})
