// `/topic`, `/topic new <name>` and `/topic remove <name>`: the owner names the
// topics of the main chat, so a scheduled task can be sent into one
// (telegram-topics.ts).
//
// Registered only while TELEGRAM_TOPICS_ENABLED is on (the switch needs a
// restart, like the plugin patch it belongs to), so with the switch off /help,
// the Telegram command menu and dispatch are exactly what they were. The
// hook's dashboard-down list (BUILTIN_NAMES in marveen-commands.py) leaves
// `topic` out for the same reason: with the dashboard down, `/topic` goes to
// the model like any unknown slash word.
//
// Only the bot can open a topic in a private chat when the owner keeps
// user-created topics off in BotFather, hence the write command.

import { CHANNEL_PROVIDER, CHANNEL_TOKEN } from '../config.js'
import { createTelegramForumTopic } from '../channel-provider.js'
import { registerCommand, type CommandContext } from './commands.js'
import {
  TELEGRAM_TOPICS_FILE,
  TOPIC_NAME_MAX,
  findTelegramTopic,
  normalizeTopicName,
  readTelegramTopics,
  removeTelegramTopic,
  saveTelegramTopic,
} from './telegram-topics.js'

export interface TopicCommandDeps {
  createTopic: (chatId: string, name: string) => Promise<number>
  topicsFile: string
}

const defaultDeps: TopicCommandDeps = {
  createTopic: (chatId, name) => {
    if (CHANNEL_PROVIDER !== 'telegram' || !CHANNEL_TOKEN) {
      return Promise.reject(new Error('Telegram: a fő csatorna nem Telegram, vagy nincs bot token'))
    }
    return createTelegramForumTopic(CHANNEL_TOKEN, chatId, name)
  },
  topicsFile: TELEGRAM_TOPICS_FILE,
}

function taskConfigHint(name: string): string {
  return `Ütemezett feladatba így kerül (task-config.json): "telegramTopic": ${JSON.stringify(name)}`
}

export function topicListText(chatId: string, topicsFile: string): string {
  const stored = readTelegramTopics(topicsFile)
  const names = stored && stored.chatId === chatId ? Object.entries(stored.topics) : []
  if (names.length === 0) return 'Még nincs elnevezett téma. Újat így nyitsz: /topic new <név>'
  const lines = ['Elnevezett témák:']
  for (const [name, id] of names) lines.push(`- ${name} (azonosító: ${id})`)
  lines.push('', 'Új téma: /topic new <név>, elfelejtés: /topic remove <név>')
  return lines.join('\n')
}

export function topicHelpText(): string {
  return [
    '/topic: az elnevezett témák listája.',
    '/topic new <név>: új témát nyit a fő chatben, és elmenti a nevét.',
    '/topic remove <név>: elfelejti a nevet (csak a helyi sort törli, a Telegram-témát nem). Kézzel törölt téma után kell, különben az ütemezett feladat a már nem létező témába küld.',
    `A név legfeljebb ${TOPIC_NAME_MAX} karakter, szóköz lehet benne. Ha már van ilyen nevű, nem nyit újat.`,
    'Egy ütemezett feladat eredményét a task-config.json "telegramTopic" mezője küldi az adott témába.',
    '',
    'Példa: /topic new Napi hírek',
  ].join('\n')
}

// A raw network error string can carry the request URL, and the Bot API URL
// carries the bot token: only our own "Telegram ..." messages are shown.
function failureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : ''
  return msg.startsWith('Telegram') ? msg : (err instanceof Error ? err.name : 'ismeretlen hiba')
}

export async function topicNew(ctx: CommandContext, args: string[], deps: TopicCommandDeps): Promise<void> {
  const chatId = String(ctx.ownerId)
  const name = normalizeTopicName(args.slice(1).join(' '))
  if (!name) {
    await ctx.reply(`Használat: /topic new <név> (legfeljebb ${TOPIC_NAME_MAX} karakter)`)
    return
  }
  const existing = findTelegramTopic(name, chatId, deps.topicsFile)
  if (existing) {
    await ctx.reply(`Már van ilyen téma: ${existing.name} (azonosító: ${existing.threadId}). Nem nyitottam újat.\n${taskConfigHint(existing.name)}`)
    return
  }
  let threadId: number
  try {
    threadId = await deps.createTopic(chatId, name)
  } catch (err) {
    // No retry: a timed-out createForumTopic may still have opened the topic,
    // and a second call would open a duplicate.
    await ctx.reply(`Nem sikerült a témát megnyitni: ${failureReason(err)}. Ha időtúllépés volt, nézd meg a chatben, létrejött-e, mielőtt újra kéred.`)
    return
  }
  try {
    saveTelegramTopic(chatId, name, threadId, deps.topicsFile)
  } catch (err) {
    await ctx.reply(`A téma megnyílt (${name}, azonosító: ${threadId}), de a nevét nem tudtam elmenteni: ${err instanceof Error ? err.message : 'ismeretlen hiba'}.`)
    return
  }
  await ctx.reply(`Kész, megnyitottam: ${name} (azonosító: ${threadId}).\n${taskConfigHint(name)}`)
}

export async function topicRemove(ctx: CommandContext, args: string[], deps: TopicCommandDeps): Promise<void> {
  const name = normalizeTopicName(args.slice(1).join(' '))
  if (!name) {
    await ctx.reply('Használat: /topic remove <név>')
    return
  }
  let removed: { name: string; threadId: number } | null
  try {
    removed = removeTelegramTopic(String(ctx.ownerId), name, deps.topicsFile)
  } catch (err) {
    await ctx.reply(`Nem tudtam törölni: ${err instanceof Error ? err.message : 'ismeretlen hiba'}.`)
    return
  }
  if (!removed) {
    await ctx.reply(`Nincs ilyen elnevezett téma: ${name}. Lásd /topic.`)
    return
  }
  await ctx.reply(`Elfelejtettem: ${removed.name} (azonosító: ${removed.threadId}). Csak a helyi sort töröltem, a Telegram-téma megmaradt; ha azt is törölni akarod, a chatben kézzel teheted meg. Az erre a névre mutató ütemezett feladatok mostantól téma nélkül küldenek.`)
}

export function registerTopicCommands(deps: TopicCommandDeps = defaultDeps): void {
  registerCommand({
    name: 'topic', kind: 'read', description: 'az elnevezett Telegram-témák', help: topicHelpText,
    run: ctx => ctx.reply(topicListText(String(ctx.ownerId), deps.topicsFile)),
  })
  registerCommand({
    name: 'topic', kind: 'write', usage: '/topic new <név>', description: 'új téma a fő chatben, névvel', help: topicHelpText,
    matches: args => args[0]?.toLowerCase() === 'new',
    run: (ctx, args) => topicNew(ctx, args, deps),
  })
  registerCommand({
    name: 'topic', kind: 'write', usage: '/topic remove <név>', description: 'egy elnevezett téma elfelejtése (csak a helyi sor)', help: topicHelpText,
    matches: args => args[0]?.toLowerCase() === 'remove',
    run: (ctx, args) => topicRemove(ctx, args, deps),
  })
}
