import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  saveMemory,
  decayMemories as dbDecay,
  pruneAuditLogs,
  pruneTokenUsage,
  pruneConversationLog,
  pruneOtelSpans,
  pruneAgentMessages,
  pruneToolCallLogRetention,
  checkpointAndCompact,
  getMemoriesForChat,
} from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { MAIN_AGENT_ID } from './config.js'
import { wrapUntrusted, UNTRUSTED_PREAMBLE } from './prompt-safety.js'

// Dedicated cwd for the daily-digest sub-agent. We can't reuse PROJECT_ROOT
// here -- the Marveen Telegram channels session runs claude --continue in
// PROJECT_ROOT, and the SDK's per-cwd session/lock state collides with it
// when two Claude Code processes share the same project dir, dropping the
// channels plugin every night at 23:00. A throwaway dir under the user's
// `~/.claude/projects/` tree avoids the collision while keeping the SDK
// happy (it expects a writable cwd to place its session jsonl into).
//
// We honor TMPDIR via os.tmpdir() as a last-resort fallback so a hardened
// host with a read-only home still has somewhere to land.
function ensureDigestCwd(): string {
  const candidates = [join(homedir(), '.claude', 'tmp', 'marveen-digest'), join(tmpdir(), 'marveen-digest')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch { /* try next */ }
  }
  // Last resort: tmpdir itself. Worst case we share with whatever else is
  // in /tmp, but that still doesn't collide with the Marveen project dir.
  return tmpdir()
}

// The daily digest sub-agent inherits the host's CLAUDE_CONFIG_DIR
// (~/.claude/) by default, which means it loads the user's globally
// enabled plugins -- including telegram@claude-plugins-official. The
// Telegram Bot API only allows ONE active getUpdates connection per
// token, so the sub-agent's plugin steals the connection from the
// long-running marveen-channels session, which then logs as
// "plugin lecsatlakozott" at 23:00 every night when runDailyDigest
// fires. Workaround: hand the sub-agent a private CLAUDE_CONFIG_DIR
// with `enabledPlugins: {}` so it never spawns the Telegram MCP. The
// dir is created idempotently on first use; the settings.json is
// written only if missing so the user can edit it later if needed.
function ensureDigestConfigDir(): string {
  const candidates = [
    join(homedir(), '.claude', 'tmp', 'marveen-digest-config'),
    join(tmpdir(), 'marveen-digest-config'),
  ]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const settingsPath = join(dir, 'settings.json')
      if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }, null, 2))
      }
      return dir
    } catch { /* try next */ }
  }
  return tmpdir()
}

// Semantic: user preferences, facts about themselves, persistent info
const SEMANTIC_PATTERN =
  /\b(my|i am|i'm|i prefer|remember|always|never|az en|nekem|szeretem|nem szeretem|mindig|soha|emlekezzel|en|kedvenc|utokalok|fontos|ne felejtsd|jegyezd meg)\b/i

// Skip: trivial messages not worth remembering
const SKIP_PATTERN = /^(ok|igen|nem|koszi|kosz|hello|szia|hi|hey|thx|thanks|jo|oke|persze|rendben|ja|aha|\.+|!+|\?+)$/i

// buildMemoryContext used to live here: 3 FTS hits + 5 recent rows as a
// [Memoria kontextus] block. It never had a caller, from the first release
// (f24eacc8) on, and it did not read the agent tiers at all: it filtered on
// chat_id (the old Telegram-chat rows) and bumped salience on every hit. Removed
// rather than wired (HOTMEMHAMIS925). Whether an agent's hot/warm memory should
// load on its own is a product decision; if yes, it needs a new loader keyed on
// agent_id + category with a size cap, not this function.

// buildKanbanContext used to live here: it rendered EVERY unarchived card's
// FULL title into a [Kanban tabla] block (no limit, no truncation -- ~1 MB of
// titles on the live board, KANBANCTXDEAD824). Nothing ever called it, in src,
// dist or any plugin. Removed rather than fixed: an unbounded full-board dump
// is the wrong contract for agent context, and whoever wires kanban context in
// the future should start from the heartbeat-summary shape (counts first,
// titles truncated server-side -- see buildHeartbeatSummaryResponse).

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  // Skip trivial, short, or command messages
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return
  if (SKIP_PATTERN.test(userMsg.trim())) return

  // Only save semantic memories (user preferences, facts) automatically
  // Episodic memories come from daily digest and session checkpoints
  if (SEMANTIC_PATTERN.test(userMsg)) {
    const content = `Felhasznalo: ${userMsg.slice(0, 500)}\nAsszisztens: ${assistantMsg.slice(0, 500)}`
    saveMemory(chatId, content, 'semantic', undefined, MAIN_AGENT_ID)
    logger.debug({ chatId }, 'Szemantikus emlek mentve')
  }
  // Non-semantic turns are NOT saved individually -- they go into daily digest
}

export function runDecaySweep(): void {
  dbDecay()
  pruneAuditLogs()
  const tokenRowsPruned = pruneTokenUsage()
  const convRowsPruned = pruneConversationLog()
  const spanRowsPruned = pruneOtelSpans()
  const agentMsgRowsPruned = pruneAgentMessages()
  const toolCallRowsPruned = pruneToolCallLogRetention()
  // Compaction runs last: the deletes above are what create the free pages and
  // WAL frames it reclaims.
  const compact = checkpointAndCompact()
  logger.info(
    {
      tokenRowsPruned,
      convRowsPruned,
      spanRowsPruned,
      agentMsgRowsPruned,
      toolCallRowsPruned,
      walFramesLeft: compact.walFramesLeft,
      checkpointBusy: compact.checkpointBusy,
      vacuumed: compact.vacuumed,
    },
    'Memoria leepulesi sopres vegrehajtva',
  )
}

// --- Daily digest ---

// The digest is saved as an episodic memory and runs once a day, so the previous
// night's digest sits exactly on the next window's lower edge. Counted as input it
// lifted a quiet day over the threshold, and the model wrote yesterday's summary up
// again as today's. Digests are never input.
export const DAILY_DIGEST_PREFIX = '[Napi naplo '

// Milliseconds from `now` to the next local 23:00, the digest's hour. Worked out
// again for every run: a fixed 24 h interval keeps the first run's UTC offset and
// drifts an hour at each daylight-saving change until the next restart.
export function msUntilNextDigest(now: Date = new Date()): number {
  const target = new Date(now)
  target.setHours(23, 0, 0, 0)
  if (target <= now) {
    target.setDate(target.getDate() + 1)
    target.setHours(23, 0, 0, 0)
  }
  return target.getTime() - now.getTime()
}

// Arms the digest timer for the next local 23:00 and re-arms it after every run.
// The re-arm sits in a finally: if runDigest throws synchronously (resolving the
// owner chat, for instance), the next night must still be scheduled -- otherwise
// the digest stops until the next restart. The throw is logged, not rethrown: an
// exception escaping a timer callback would take the whole process down.
// onArm receives each new timer handle (so shutdown can clear it) and its delay.
export function armDailyDigest(
  runDigest: () => void,
  onArm: (timer: NodeJS.Timeout, msUntil: number) => void,
  afterRun = false,
): void {
  // After a run, look from a minute later: a timer that fires a hair early must
  // not find "23:00 today" still ahead and run twice.
  const slack = afterRun ? 60_000 : 0
  const msUntil = msUntilNextDigest(new Date(Date.now() + slack)) + slack
  const timer = setTimeout(() => {
    try {
      runDigest()
    } catch (err) {
      logger.error({ err }, 'Napi naplo hiba')
    } finally {
      armDailyDigest(runDigest, onArm, true)
    }
  }, msUntil)
  onArm(timer, msUntil)
}

export async function runDailyDigest(chatId: string): Promise<string | null> {
  // Collect today's episodic memories (last 24h)
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  // MEMCHATID1123: the day's rows from the whole store; the chat id only names where the digest is saved.
  const allRecent = getMemoriesForChat(50)
  const todayMemories = allRecent.filter(
    (m) => m.created_at >= oneDayAgo && !m.content.startsWith(DAILY_DIGEST_PREFIX),
  )

  if (todayMemories.length < 2) {
    logger.info({ chatId, count: todayMemories.length }, 'Napi naplo: tul keves emlek, kihagyjuk')
    return null
  }

  // Each memory is wrapped individually: the stored content originated in
  // Telegram messages that could have come through the assistant from a third
  // party (a forwarded message, a quoted email). Treat every record as data.
  const memoryLines = todayMemories
    .map((m) => `- ${wrapUntrusted('memory-record', m.content.slice(0, 200))}`)
    .join('\n')

  const prompt = `${UNTRUSTED_PREAMBLE}
Az alabbi egy AI asszisztens mai emlekei egy felhasznaloval folytatott beszelgetesekbol.
Irj egy tomor napi osszefoglalot (max 5-8 mondat), ami megragadja:
1. Milyen feladatokon dolgoztak
2. Milyen fontos dontesek szulettek
3. Mi maradt nyitva / mi a kovetkezo lepes

Csak az osszefoglalot add vissza, semmi mast. Magyarul irj.

Mai emlekek:
${memoryLines}`

  try {
    const digestCwd = ensureDigestCwd()
    const digestConfigDir = ensureDigestConfigDir()
    const { text } = await runAgent(prompt, undefined, undefined, false, digestCwd, {
      CLAUDE_CONFIG_DIR: digestConfigDir,
    })
    if (!text) return null

    const digest = text.trim()
    const today = new Date().toLocaleDateString('hu-HU')
    saveMemory(chatId, `${DAILY_DIGEST_PREFIX}${today}] ${digest}`, 'episodic', undefined, MAIN_AGENT_ID)
    logger.info({ chatId, digestCwd, digestConfigDir }, `Napi naplo mentve: ${today}`)
    return digest
  } catch (err) {
    logger.error({ err }, 'Napi naplo generalas hiba')
    return null
  }
}
