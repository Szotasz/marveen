import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  searchMemories,
  recentMemories,
  touchMemory,
  saveMemory,
  decayMemories as dbDecay,
  getMemoriesForChat,
  listKanbanCardsSummary,
  type Memory,
} from './db.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
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

export async function buildMemoryContext(
  chatId: string,
  userMessage: string
): Promise<string> {
  const ftsResults = searchMemories(userMessage, chatId, 3)
  const recent = recentMemories(chatId, 5)

  const seen = new Set<number>()
  const combined: Memory[] = []

  for (const m of [...ftsResults, ...recent]) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push(m)
    }
  }

  if (combined.length === 0) return ''

  for (const m of combined) {
    touchMemory(m.id)
  }

  const lines = combined.map((m) => `- ${m.content} (${m.sector})`)
  return `[Memoria kontextus]\n${lines.join('\n')}`
}

const STATUS_HU: Record<string, string> = {
  planned: 'Tervezett',
  in_progress: 'Folyamatban',
  waiting: 'Várakozik',
  done: 'Kész',
}

const PRIORITY_HU: Record<string, string> = {
  urgent: '🔴',
  high: '🟠',
  normal: '⚪',
  low: '🔵',
}

export function buildKanbanContext(): string {
  const cards = listKanbanCardsSummary()
  if (cards.length === 0) return ''

  const grouped: Record<string, string[]> = {}
  for (const c of cards) {
    const key = STATUS_HU[c.status] ?? c.status
    if (!grouped[key]) grouped[key] = []
    const assignee = c.assignee ? ` (${c.assignee})` : ''
    grouped[key].push(`  ${PRIORITY_HU[c.priority] ?? '⚪'} ${c.title}${assignee} [${c.id}]`)
  }

  const lines = Object.entries(grouped).map(([status, items]) => `${status}:\n${items.join('\n')}`)
  return `[Kanban tabla]\n${lines.join('\n')}`
}

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
    saveMemory(chatId, content, 'semantic')
    logger.debug({ chatId }, 'Szemantikus emlek mentve')
  }
  // Non-semantic turns are NOT saved individually -- they go into daily digest
}

export function runDecaySweep(): void {
  dbDecay()
  logger.info('Memoria leepulesi sopres vegrehajtva')
}

// --- Daily digest ---

export async function runDailyDigest(chatId: string): Promise<string | null> {
  // Collect today's episodic memories (last 24h)
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  const allRecent = getMemoriesForChat(chatId, 50)
  const todayMemories = allRecent.filter((m) => m.created_at >= oneDayAgo)

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
    saveMemory(chatId, `[Napi naplo ${today}] ${digest}`, 'episodic')
    logger.info({ chatId, digestCwd, digestConfigDir }, `Napi naplo mentve: ${today}`)
    return digest
  } catch (err) {
    logger.error({ err }, 'Napi naplo generalas hiba')
    return null
  }
}
