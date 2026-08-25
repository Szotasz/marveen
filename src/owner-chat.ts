// Where does a one-way notification go? (OWNERCHAT803)
//
// Measured on a fresh wizard install (ai-bootcamp-vps100, 2026-08-03): the
// pairing succeeds and the channel plugin works -- inbound chat is fine -- but
// the main .env still carries the installer default `ALLOWED_CHAT_ID=0`,
// because only the TERMINAL install path writes the paired chat back into it
// (install-macos.sh:1266). Every one-way send therefore went to chat 0, which
// the Bot API answers with 400 "chat not found". Measured against the live API,
// not assumed.
//
// The reason nobody noticed: the interactive path does not use this value at
// all. The plugin gates inbound on the channel's own access.json, so the
// install looks healthy from the user's side while the daily digest, the
// welcome message for a newly created agent, and every system alert land
// nowhere.
//
// TWO THINGS THIS MODULE DELIBERATELY DOES NOT DO
//
// 1. It does not write anything back into .env. That was the other candidate
//    fix, and it is the more dangerous one: `memories.chat_id` is written AND
//    filtered with ALLOWED_CHAT_ID (db.ts saveAgentMemory / recentMemories /
//    getMemoriesForChat), and there is no migration for that column. Changing
//    the value on a running install would silently orphan every memory written
//    before the change -- on a fresh install, the user's entire first session.
//    Measured on the fleet DB: the same FTS query returns 963 rows under the
//    real chat id and 0 under "0".
// 2. It therefore does not touch the memory key. The memory store keeps using
//    ALLOWED_CHAT_ID exactly as before. Fixing that is a separate card with a
//    migration, and must never ship in the same release as this.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWED_CHAT_ID, CHANNEL_CHAT_ID, MAIN_AGENT_ID } from './config.js'
import { channelStateDir, type ChannelProviderType } from './channel-provider.js'

/**
 * The .env value that names the owner chat for a given provider. ALLOWED_CHAT_ID
 * is the Telegram key; every other provider has its own (SLACK_CHANNEL_ID,
 * DISCORD_CHANNEL_ID, ... -- getChannelChatId), surfaced as CHANNEL_CHAT_ID.
 * A Slack-bound install routinely keeps a stale numeric Telegram id in
 * ALLOWED_CHAT_ID; feeding that to chat.postMessage earns a permanent
 * `channel_not_found`, so the provider's own key must win there.
 */
export function configuredOwnerChatFor(
  provider: ChannelProviderType,
  env: { allowedChatId: string; channelChatId: string } = { allowedChatId: ALLOWED_CHAT_ID, channelChatId: CHANNEL_CHAT_ID },
): string {
  return provider === 'telegram' ? env.allowedChatId : env.channelChatId
}

/**
 * Normalise a configured chat id to "set" or "not set".
 *
 * `"0"` is the installer's placeholder, and it is the whole reason this bug
 * survived: every existing guard tested for EMPTINESS (`!ALLOWED_CHAT_ID`,
 * `!ALLOWED_CHAT_ID.trim()`), and `"0"` is neither empty nor falsy. Measured:
 * `!"0"` is false and `!"0".trim()` is false, so the code's own
 * "suppressed: empty ALLOWED_CHAT_ID (config error)" branches never fired on
 * exactly the installs that needed them -- the send went out and earned a 400
 * instead. One place decides what "not set" means, so a future consumer cannot
 * reinvent the same hole.
 */
export function normalizeChatId(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (v === '0') return null
  return v
}

/**
 * The chat id the owner actually reads, or null when this install has none.
 *
 * Order: the configured value first (so an operator who set it by hand, and
 * every install that predates the wizard, keeps behaving identically), then
 * the main agent's channel allowlist -- the same access.json the plugin
 * enforces on inbound, so a resolved id is deliverable by construction.
 *
 * Returning null is a real answer: "this install has no owner chat". Callers
 * must skip the send rather than pass a placeholder on to the API.
 */
export function resolveOwnerChatId(
  readAccessFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
  configured: string | null = ALLOWED_CHAT_ID,
  provider: ChannelProviderType = 'telegram',
): string | null {
  const fromEnv = normalizeChatId(configured)
  if (fromEnv) return fromEnv
  try {
    // `provider` defaults to 'telegram' so every existing caller (daily digest,
    // welcome/avatar messages, command-task, inbound-probe) is byte-identical.
    // The schedule-runner passes CHANNEL_PROVIDER so a Slack-bound main agent
    // resolves the owner from its slack/access.json instead of a (missing)
    // telegram one.
    const raw = JSON.parse(readAccessFile(join(channelStateDir(provider), 'access.json'))) as Record<string, unknown>
    // Same shape and same "first allowlist entry" heuristic as
    // schedule-runner's resolveBoundChatId, which already resolves the main
    // agent from this exact file. access.json has no owner field; with more
    // than one entry the first is a guess, which is why the caller-facing
    // behaviour stays "best effort delivery", never "authorisation".
    if (Array.isArray(raw.allowFrom)) {
      for (const entry of raw.allowFrom) {
        const id = normalizeChatId(typeof entry === 'number' ? String(entry) : (entry as string))
        if (id) return id
      }
    }
    // Telegram/Discord keep allowed groups under `groups`, Slack under
    // `channels` -- the same allowFrom -> groups -> channels heuristic as
    // schedule-runner's chatIdFromAccessConfig, so a Slack main agent bound
    // only to a channel (empty DM allowlist) resolves an owner here too, not
    // just in the task-prompt path.
    for (const mapKey of ['groups', 'channels'] as const) {
      const map = raw[mapKey]
      if (!map || typeof map !== 'object') continue
      for (const key of Object.keys(map as Record<string, unknown>)) {
        const id = normalizeChatId(key)
        if (id) return id
      }
    }
  } catch {
    // No access.json, unreadable, or not JSON: no owner chat. Not an error --
    // an install with no channel configured is a legitimate state.
  }
  return null
}
