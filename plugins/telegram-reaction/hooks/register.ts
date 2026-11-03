import type { EngineInterface, Register } from 'claude-code'

// telegram-reaction -- an OPT-IN Claude Code mod: the progress of a Telegram
// turn shows as a reaction on the user's OWN message, instead of a separate
// "✍️ working on it…" placeholder message:
//
//   👀  received        prompt.submit from the Telegram channel
//   🤔  working         turn.start, or the first tool call that is not the reply
//   ✍️  writing         the Telegram `reply` tool is about to run
//   👨‍💻  after           the `reply` tool SUCCEEDED -- the answer is out, the turn is
//                       still running; it STAYS while the turn goes on (more tool
//                       calls, more replies)
//   (cleared)           the turn completed -- not the first reply: an agent often
//                       answers in several messages, and the user reads the
//                       reaction as "still working" until the turn is over
//
// The reaction only ever moves forward (👀 -> 🤔 -> ✍️ -> 👨‍💻); it never flips back.
// The `after` step is switched off with MARVEEN_TELEGRAM_REACTION_EMOJIS='after=': then the 0.3.2 behaviour is
// unchanged to the call (✍️ stays to the turn end; the step does not even move the pending stage).
//
// Each step's emoji can be changed or the step skipped:
// MARVEEN_TELEGRAM_REACTION_EMOJIS='received=👀,working=🤔,writing=✍️,after=👨‍💻' -- a step left out keeps its default; an empty
// value ('working=') skips the step: no change at that point (the previous reaction stays; at the first step: none
// yet). The first three empty turn the mod off (the cleanup still runs; `after` alone does not keep it on). An unknown step, a malformed item or an emoji
// Telegram does not accept as a reaction is a loud warning in the session transcript ($.ui.log), and that step keeps
// its default. Read at session start: a change needs a restart of the main agent.
//
// The agent's OWN reaction (its react tool) is cleared at the turn end too, by default (a reaction left on a message
// is listed by Telegram as unread); MARVEEN_TELEGRAM_REACTION_KEEP_AGENT=1 keeps it (the 0.2.x behaviour). Either way
// the message stays the agent's: no stage of ours on it again.
//
// Where it is loaded it is ON: when installed as a plugin next to an unmodified engine, it is switched on for the
// main agent through the engine's .env CHANNEL_PLUGINS_EXTRA; MARVEEN_TELEGRAM_REACTION=0
// turns it off, FLEET_FORBID_LIVE=1 (a test process tree) makes it inert. The
// engine's stock placeholder hook (scripts/hooks/telegram_progress.py) is kept off
// through its own dedup marker, and the mod records the pending reply in the
// stock hook's format, so the Stop hook's delivery enforcement and the watchdog keep
// working unchanged (see claimForFactoryHook).
//
// What it never does: it never denies or rewrites an event, and it delays only
// one: prompt.submit waits for the claim. Every Bot API call is fire-and-forget
// on ONE serial chain, and it sends the DESIRED reaction of its message as it is
// when the call runs (our stage, the agent's own emoji once the agent reacted on
// the message itself, or none) -- never an earlier snapshot. When the agent's
// own react succeeds, the chain writes the agent's emoji again after everything
// it holds. A call with no certain answer leaves the message "unknown": a call
// that timed out syncs its message again when it finally settles (it may have
// landed after newer calls), and like a failed clear it is retried at the next
// turn end and the next session start. So once the chain is drained and every
// request has settled, each message carries its desired reaction.
//
// The bot token comes from <TELEGRAM_STATE_DIR>/.env, the same file the
// telegram plugin and the placeholder hooks read. It is held in memory only:
// never stored, logged or shown.

// The steps of a turn, in their only order (the rank is the STEP's, not the emoji's: two steps may share an emoji).
export const STEPS = ['received', 'working', 'writing', 'after'] as const
export type Step = (typeof STEPS)[number]
const RANK: Record<Step, number> = { received: 0, working: 1, writing: 2, after: 3 }
export const DEFAULT_EMOJIS: Readonly<Record<Step, string>> = { received: '👀', working: '🤔', writing: '✍️', after: '👨‍💻' }
// the steps of the 0.3.2 ladder: all of them empty turns the mod off (the `after` step alone never keeps it on)
const LADDER_032 = ['received', 'working', 'writing'] as const
// The Bot API ReactionTypeEmoji whitelist, as the telegram plugin 0.0.7's own dependency types it (@grammyjs/types
// 3.25.0, message.d.ts, read 2026-10-12). Compared without the variation selector U+FE0F: the default ✍️ carries it,
// the list does not, and Telegram takes both.
const ALLOWED_REACTIONS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]
const noVs = (e: string) => e.replace(/\uFE0F/g, '')
const ALLOWED_BY_FORM = new Map(ALLOWED_REACTIONS.map(e => [noVs(e), e]))
/** User text in a warning is cut to WARN_ITEM_MAX code points -- a 5000-emoji item must not
 *  write itself into the transcript at full length */
const WARN_ITEM_MAX = 64
const WARN_LINES_MAX = 8
const cut = (t: string) => { const cp = [...t]; return cp.length > WARN_ITEM_MAX ? cp.slice(0, WARN_ITEM_MAX).join('') + '…' : t }

/** MARVEEN_TELEGRAM_REACTION_EMOJIS -> the emoji of each step ('' = the step is skipped) and the warnings to show.
 *  Missing or empty: the defaults. Each item is <step>=<emoji>; an unknown step or a malformed item is skipped, an emoji
 *  Telegram does not accept leaves that step at its default -- all of them with a warning, never silently. */
export function emojisFrom(value: unknown): { emojis: Record<Step, string>; warnings: string[] } {
  const emojis: Record<Step, string> = { ...DEFAULT_EMOJIS }
  const warnings: string[] = []
  let text = typeof value === 'string' ? value.trim() : ''
  // a value written shell-style ('...' or "...") is taken without its outer quotes
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text[text.length - 1] === text[0]) text = text.slice(1, -1).trim()
  if (!text) return { emojis, warnings }
  const given = new Set<string>()
  for (const raw of text.split(',')) {
    const item = raw.trim()
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq < 1) {
      warnings.push(`"${cut(item)}" is not <step>=<emoji> -- ignored`)
      continue
    }
    const name = item.slice(0, eq).trim()
    const emoji = item.slice(eq + 1).trim()
    if (!(STEPS as readonly string[]).includes(name)) {
      warnings.push(`unknown step "${cut(name)}" (received, working, writing, after) -- ignored`)
      continue
    }
    const step = name as Step
    if (given.has(step)) warnings.push(`"${step}" is given more than once -- the last one counts`)
    given.add(step)
    if (emoji === '') {
      emojis[step] = ''
      continue
    }
    const allowed = ALLOWED_BY_FORM.get(noVs(emoji))
    if (!allowed) {
      emojis[step] = DEFAULT_EMOJIS[step]
      warnings.push(`"${step}=${cut(emoji)}": Telegram does not accept this as a reaction -- the default ${DEFAULT_EMOJIS[step]} stays`)
      continue
    }
    // the default keeps its exact form (the one measured live); any other emoji is sent in the Bot API list's form
    emojis[step] = noVs(emoji) === noVs(DEFAULT_EMOJIS[step]) ? DEFAULT_EMOJIS[step] : allowed
  }
  // the number of lines is capped as well: 5000 malformed items must not write 5000 lines into the transcript
  if (warnings.length > WARN_LINES_MAX) warnings.splice(WARN_LINES_MAX, warnings.length - WARN_LINES_MAX, `... and ${warnings.length - WARN_LINES_MAX} more`)
  return { emojis, warnings }
}

// A module constant on purpose: a base taken from the environment could carry
// the bot token to another host. Tests answer $.http.fetch beneath the mod.
const API_BASE = 'https://api.telegram.org'
const FETCH_MS = 8_000
const FETCH_MIN_MS = 100
const RETRY_MAX_TRIES = 20
const RETRY_MAX_AGE_MS = 48 * 3600 * 1000
const RETRY_PER_RUN = 5
// the closing pass of a turn end writes every uncertain message of the turn (up to this bound), not 5
const RETRY_CLOSE_MAX = 50
// records are kept past the turn end -- a message the agent took over must not be taken back by a later
// re-delivery, and a recently delivered message stays known -- bounded: at most this many, none untouched for longer
// than RETRY_MAX_AGE_MS (the oldest go first)
const KEEP_MAX = 100

// A channel delivery STARTS with a Telegram channel tag; a batched delivery then
// carries one tag per message (the placeholder hook records all of them, too).
// Text that does not start with a tag -- e.g. a pasted or quoted tag -- does not
// count: reacting to it would mark an old, already answered message.
const LEADING_TAG = /^\s*<channel\b[^>]*\bsource="[^"]*telegram[^"]*"[^>]*>/
const ANY_TAG = /<channel\b[^>]*\bsource="[^"]*telegram[^"]*"[^>]*>/g

type Target = { chat_id: string; message_id: number; stage: Step }
type Retry = { chat_id: string; message_id: number; tries: number; first: number; emoji?: string | null; agent?: boolean }
type Rec = { chat_id: string; message_id: number; desired: string | null; confirmed: string | null; known: boolean; inflight: number; agent: boolean; gen: number; since?: number }

const key = (t: { chat_id: string; message_id: number }) => `${t.chat_id}:${t.message_id}`

type Src = { chat_id: string; message_id: number; message_thread_id?: number }

/** The (chat_id, message_id) of every message in a Telegram channel delivery -- plus its message_thread_id when it came
 *  from a topic (TELEGRAM_TOPICS_ENABLED, the same attribute and pattern as the stock placeholder hook); [] for anything
 *  else. */
export function targetsOf(text: unknown): Src[] {
  const t = typeof text === 'string' ? text : ''
  if (!LEADING_TAG.test(t)) return []
  const out: Src[] = []
  for (const tag of t.match(ANY_TAG) ?? []) {
    const chat = /\bchat_id="([^"]+)"/.exec(tag)
    const mid = /\bmessage_id="(-?\d+)"/.exec(tag)
    const tid = /\bmessage_thread_id="(\d+)"/.exec(tag)
    if (chat && mid) out.push({ chat_id: chat[1]!, message_id: Number(mid[1]), ...(tid ? { message_thread_id: Number(tid[1]) } : {}) })
  }
  return out
}

/** The Telegram channel's reply tool, e.g. mcp__plugin_telegram_telegram__reply. */
export function isReplyTool(tool: unknown): boolean {
  return /telegram.*__reply$/.test(String(tool ?? ''))
}

/** The Telegram channel's own react tool: the agent setting a reaction itself. */
export function isReactTool(tool: unknown): boolean {
  return /telegram.*__react$/.test(String(tool ?? ''))
}

/** The chat a reply tool call targets: its input's chat_id (flat as a fallback). */
export function replyChat(e: any): string | null {
  for (const v of [e?.input?.chat_id, e?.chat_id]) {
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return null
}

/** A tool result that clearly failed (deny, isError, or an error-shaped result). */
export function toolSucceeded(r: any): boolean {
  if (!r || r.deny !== undefined || r.isError) return false
  const x = r.result
  if (x && typeof x === 'object' && !Array.isArray(x) && (x.is_error || x.isError || x.ok === false)) return false
  return true
}

/** The per-call timeout: MARVEEN_TELEGRAM_REACTION_FETCH_MS clamped to 100..8000 ms, else 8000. */
export function fetchMs(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(FETCH_MS, Math.max(FETCH_MIN_MS, n)) : FETCH_MS
}

export function tokenFrom(envText: unknown): string | null {
  for (const line of String(envText ?? '').split('\n')) {
    const s = line.trim()
    if (s.startsWith('TELEGRAM_BOT_TOKEN=')) return s.slice('TELEGRAM_BOT_TOKEN='.length).trim() || null
  }
  return null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

// Module state starts over on every load; register() resets it explicitly too.
let enabled = false
let token: string | null = null
let timeoutMs = FETCH_MS
let emojis: Record<Step, string> = { ...DEFAULT_EMOJIS }
let keepAgent = false
// the messages the agent reacted on (successfully) during the current main turn: cleared at its end unless keepAgent
let turnAgent = new Set<string>()
// The store keys carry the bot's state dir: two agents sharing a config dir
// must not clean up each other's reactions with the wrong bot.
let storeKey = (name: string) => name
let pending = new Map<string, Target>()
let retries: Retry[] = []
// ONE WRITER, DESIRED STATE. Every message we ever reacted on has a record: the
// reaction it SHOULD carry (our stage, the agent's own emoji once it took the message over, or none), and what Telegram
// is KNOWN to carry. Every setMessageReaction goes on the one serial chain and sends the desired value as it is when the
// call runs -- never a snapshot taken earlier. A call with no certain answer (timed out, failed) leaves the message
// unknown; a timed-out call that settles later (it may have landed after newer calls) syncs the message again, and it
// is retried like a failed clear. The invariant: once the chain is drained and every request settled, the reaction on
// each message is the desired one.
let records = new Map<string, Rec>()
let chain: Promise<void> = Promise.resolve()

type Outcome = 'ok' | 'failed' | 'timeout'

/** Key names of a result object for the diagnostic line: only schema-like names (a key that looks like data is shown as
 *  '?'), at most 8 -- never a value. */
export function keyNames(v: unknown): string {
  if (!v || typeof v !== 'object') return typeof v
  const ks = Object.keys(v as object)
  const shown = ks.slice(0, 8).map(k => (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) ? k : '?'))
  return shown.join(',') + (ks.length > 8 ? ',…' : '')
}

/** One setMessageReaction call, settled: the fetch is never cut short (no abort exists), only no longer waited for. */
function call($: EngineInterface, chat_id: string, message_id: number, emoji: string | null): Promise<'ok' | 'failed'> {
  if (!token) return Promise.resolve('failed')
  return Promise.resolve()
    .then(() => $.http.fetch(`${API_BASE}/bot${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, message_id, reaction: emoji ? [{ type: 'emoji', emoji }] : [] }),
    }))
    .then((r: any) => (r && r.status === 200 ? 'ok' : 'failed'), () => 'failed' as const)
}

/** Waits at most one fetch timeout; a request still out is counted (`out`) BEFORE its settling is hooked (`late`). */
async function send(p: Promise<'ok' | 'failed'>, out: () => void, late: () => void): Promise<Outcome> {
  const r = await withTimeout(p, timeoutMs)
  if (r !== null) return r
  out()
  p.then(late, late)
  return 'timeout'
}

function persist($: EngineInterface): Promise<void> {
  // a retry carries the reaction its message must end with: the agent's own emoji where the agent took it over, else none
  // (a stage of a dead turn is never restored after a crash)
  // The agent's emoji is carried only with KEEP_AGENT -- by default a dead turn's agent emoji is not
  // restored either (it would never be cleared); the ownership itself travels apart ('agent'), so a re-delivery is no stage
  const out = retries.map(r => {
    const rec = records.get(key(r))
    return rec ? { ...r, emoji: rec.agent && keepAgent ? rec.desired : null, agent: rec.agent } : r
  })
  return Promise.resolve()
    .then(() => $.store.set(storeKey('pending'), [...pending.values()]))
    .then(() => $.store.set(storeKey('retries'), out))
    .catch(() => {})
}

/** Queue work on the one chain; the hook that called it does not wait. */
function enqueue($: EngineInterface, work: () => Promise<void>): void {
  chain = chain.then(work).then(() => persist($)).catch(() => {})
}

const settled = (r: Rec) => r.known && r.confirmed === r.desired && r.inflight === 0

// While a retry pass runs (it awaits writes), a retryLater from a hook must not be lost: the pass
// replaces the queue with what IT keeps at its end, and an X it already processed and dropped is still in the old array
// (so the dedup would skip it). Every call during a pass is ALSO collected here and merged into the pass's result.
let incoming: Retry[] | null = null

function retryLater(r: { chat_id: string; message_id: number }, emoji: string | null = null): void {
  const e: Retry = { chat_id: r.chat_id, message_id: r.message_id, tries: 0, first: Date.now(), emoji }
  if (incoming && !incoming.some(x => key(x) === key(r))) incoming.push(e)
  if (!retries.some(x => key(x) === key(r))) retries.push(e)
}

/** The message's state is no longer known (a late answer, a failed or uncertain call): a NEW generation -- a write still
 *  on the wire may not confirm the old one. */
function unknown(r: Rec): void {
  r.gen += 1
  r.known = false
}

/** The one write: Telegram gets the record's desired reaction AS IT IS NOW. Runs on the chain only. */
async function write($: EngineInterface, k: string, force = false): Promise<Outcome | 'skip'> {
  const r = records.get(k)
  if (!r || (!force && r.known && r.confirmed === r.desired)) return 'skip'
  const want = r.desired
  const gen = r.gen
  const out = await send(call($, r.chat_id, r.message_id, want), () => { r.inflight += 1 }, () => {
    // the timed-out request is back (landed or not, maybe after newer calls): the message is unknown again -> sync
    r.inflight -= 1
    unknown(r)
    if (records.get(k) === r) sync($, k)
    else retryLater(r, r.agent ? r.desired : null)   // the module was reloaded meanwhile: the new one repeats it
  })
  if (out === 'ok' && r.gen === gen) {
    r.confirmed = want
    r.known = true
  } else if (out !== 'ok') {
    unknown(r)
    retryLater(r)   // repeated in the closing pass of the turn end, and later, like a failed clear
  }
  return out
}

/** Bring one message to its desired reaction, on the chain. */
function sync($: EngineInterface, k: string): void {
  enqueue($, async () => { await write($, k) })
}

function record(t: { chat_id: string; message_id: number }): Rec {
  const k = key(t)
  let r = records.get(k)
  if (!r) {
    r = { chat_id: t.chat_id, message_id: t.message_id, desired: null, confirmed: null, known: false, inflight: 0, agent: false, gen: 0 }
    records.set(k, r)
  }
  return r
}

function stage($: EngineInterface, t: { chat_id: string; message_id: number }, step: Step): void {
  if (step === 'after' && !emojis.after) return         // the step is off: nothing changes, not even the pending stage (0.3.2 to the call)
  const k = key(t)
  if (records.get(k)?.agent) return                     // the agent took the message over: no stages again (a re-delivery)
  const cur = pending.get(k)
  if (cur && RANK[cur.stage] >= RANK[step]) return      // forward only
  pending.set(k, { chat_id: t.chat_id, message_id: t.message_id, stage: step })
  const emoji = emojis[step]
  if (!emoji) return   // a skipped step: no change here -- the previous reaction stays (at the first: none yet)
  const r = record(t)
  r.desired = emoji
  r.since = Date.now()
  sync($, k)
}

function clear($: EngineInterface, targets: Target[]): void {
  for (const t of targets) {
    pending.delete(key(t))
    const r = records.get(key(t))
    if (r && !r.agent) r.desired = null
    sync($, key(t))
  }
}

/** A queued message without a record (an earlier session's leftover) gets one -- its stored desired reaction
 *  (the agent's emoji, or none) -- so it is written on the one chain like any other, and a later agent react hands it over. */
function adopt(r: Retry): Rec {
  const rec = record(r)
  // An earlier session's agent emoji is restored only with KEEP_AGENT; by default it is cleared
  rec.desired = keepAgent ? r.emoji ?? null : null
  rec.agent = r.agent === true || r.emoji != null
  if (rec.agent) rec.since = r.first
  return rec
}

/** An agent emoji still shown that the main turn end must clear (KEEP_AGENT=0) -- its queue entry
 *  stays (persisted with no emoji) even while the message is settled, so a session dying before that turn end clears it. */
const owed = (rec: Rec) => !keepAgent && rec.agent && rec.desired !== null

function retryClears($: EngineInterface, perRun = RETRY_PER_RUN): void {
  enqueue($, async () => {
    const now = Date.now()
    const keep: Retry[] = []
    let run = 0
    incoming = []
    let kesz = false
    try {
    for (const r of retries) {
      const k = key(r)
      const rec = records.get(k)
      if (rec && settled(rec)) {                                                       // known right: done
        if (owed(rec)) keep.push(r)                                                    // ...but still to clear at the turn end
        continue
      }
      if (r.tries >= RETRY_MAX_TRIES || now - r.first > RETRY_MAX_AGE_MS) {            // give up -- its record too
        if (rec && !pending.has(k)) records.delete(k)
        continue
      }
      if (!rec && pending.has(k)) continue                                            // live again: not an orphan
      if (run >= perRun) { keep.push(r); continue }
      run += 1
      const rr = rec ?? adopt(r)   // one write path for every message: bounded, generation-checked, late answers synced
      const out = await write($, k, true)
      if (out !== 'ok' || !settled(rr)) keep.push({ ...r, tries: r.tries + 1 })
      else if (owed(rr)) keep.push(r)
    }
    kesz = true
    } finally {
      // the pass's result + every retryLater that arrived DURING it (one entry per message; the next pass decides). A
      // throw inside the pass keeps the WHOLE queue, as before (the not yet visited entries must not be lost).
      const inc = incoming ?? []
      incoming = null
      const alap = kesz ? keep : retries
      retries = alap.concat(inc.filter(x => !alap.some(k => key(k) === key(x))))
    }
  })
}

/** Records stay past the turn end (the agent's take-over survives a later re-delivery, a recently delivered
 *  message stays known); only a known-right, idle record goes, and only when untouched for RETRY_MAX_AGE_MS or beyond
 *  the KEEP_MAX newest. */
function prune($: EngineInterface): void {
  enqueue($, async () => {
    const now = Date.now()
    const idle = (k: string, r: Rec) => settled(r) && !pending.has(k) && !retries.some(x => key(x) === k)
    for (const [k, r] of [...records]) if (idle(k, r) && now - (r.since ?? now) > RETRY_MAX_AGE_MS) records.delete(k)
    const sor = [...records].sort((a, b) => (a[1].since ?? 0) - (b[1].since ?? 0))
    let tobb = sor.length - KEEP_MAX
    for (const [k, r] of sor) {
      if (tobb <= 0) break
      if (idle(k, r)) { records.delete(k); tobb -= 1 }
    }
  })
}

async function stateDir($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('TELEGRAM_STATE_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude/channels/telegram`
  return dir.replace(/\/+$/, '')
}

// Plugin install path: the engine's stock placeholder hook (scripts/hooks/telegram_progress.py) does NOT know about
// the reaction mod, and a plugin does not write the engine's tracked files. The hook does keep a documented dedup
// contract, though: when an O_EXCL marker (<state>/progress/seen-<sid>-<src_mid>.marker) exists it exits with a
// "dedup skip" and posts no placeholder. next(e) of prompt.submit runs the UserPromptSubmit settings hooks (the API's
// contract), so if the mod writes the marker BEFORE that, the stock hook deterministically skips the placeholder. The
// mod itself records the pending entry in the stock format (chat_id + src_mid, WITHOUT a placeholder message_id), so
// the stock Stop enforcement (blocks once, then delivers as a fallback) and the watchdog keep working. A message from a
// topic (TELEGRAM_TOPICS_ENABLED) also carries its message_thread_id, as the stock entry does, so the fallback reply
// goes back into that topic; without a topic the entry is byte for byte the old one. On an error nothing blocks: the
// stock hook posts its placeholder the old way, and the reaction goes out regardless.
export async function claimForFactoryHook($: EngineInterface, targets: Src[]): Promise<void> {
  if (!targets.length) return
  const dir = await stateDir($)
  const sid = await $.session.id()
  const pdir = `${dir}/progress`
  const pendPath = `${pdir}/${sid}.json`
  let pend: any[] = []
  try {
    const v = JSON.parse(await $.fs.read(pendPath))
    if (Array.isArray(v)) pend = v
  } catch {}
  for (const t of targets) {
    if (!pend.some(p => p && String(p.chat_id) === t.chat_id && String(p.src_mid) === String(t.message_id))) {
      pend.push({ chat_id: t.chat_id, src_mid: String(t.message_id),
                  ...(t.message_thread_id !== undefined ? { message_thread_id: t.message_thread_id } : {}) })
    }
  }
  // The pending entry FIRST, atomically (a tmp file renamed over it; $.fs.write creates the progress/ dir).
  // Only then the dedup marker: if the pending write fails, no marker is written either, so the stock hook posts its
  // placeholder and records its own pending entry (the Stop enforcement keeps working) instead of a skipped placeholder
  // with no pending entry. The read-modify-write is not locked against the stock hooks (a short window; README).
  await writePending($, pendPath, pend)
  for (const t of targets) await $.fs.write(`${pdir}/seen-${sid}-${t.message_id}.marker`, '')
  // Accumulated, not replaced: two deliveries close together may both wait for their classic event, and the transcript
  // path is the SESSION's, so either event stamps both. Capped: a classic event that never comes must not grow it.
  claimed = claimed.concat(targets.map(t => ({ chat_id: t.chat_id, src_mid: String(t.message_id) }))).slice(-50)
}

// The atomic pending write: a tmp file renamed over the pending file.
async function writePending($: EngineInterface, pendPath: string, pend: any[]): Promise<void> {
  const tmp = `${pendPath}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  await $.fs.write(tmp, JSON.stringify(pend))
  const mv = await $.process.run(['/bin/mv', '-f', tmp, pendPath])
  if (mv.exitCode !== 0) {
    // No tmp file left behind in progress/ ($.fs has no delete)
    try { await $.process.run(['/bin/rm', '-f', tmp]) } catch {}
    throw new Error('pending rename failed')
  }
}

// The pending entries THIS prompt's claim wrote (the stock submit hook skips on the marker, so it never stamps them).
// prompt.submit's input has no transcript path; the classic UserPromptSubmit input does (BaseHookInput), and that event
// runs inside next(e) of prompt.submit, ahead of the settings hooks. stampTranscript() puts the path on those entries.
let claimed: { chat_id: string; src_mid: string }[] = []

// The stock watchdog finds the agent's transcript ONLY through the transcript_path on a pending entry. Without it a
// round the Stop hook never closes (agent died, reply tool hung) cannot recover the agent's answer.
export async function stampTranscript($: EngineInterface, transcriptPath: unknown): Promise<void> {
  const mine = claimed
  claimed = []
  if (!mine.length || typeof transcriptPath !== 'string' || !transcriptPath) return
  const pendPath = `${await stateDir($)}/progress/${await $.session.id()}.json`
  let pend: any
  try { pend = JSON.parse(await $.fs.read(pendPath)) } catch { return }
  if (!Array.isArray(pend)) return
  let changed = false
  for (const p of pend) {
    if (p && !p.transcript_path && mine.some(m => String(p.chat_id) === m.chat_id && String(p.src_mid) === m.src_mid)) {
      p.transcript_path = transcriptPath
      changed = true
    }
  }
  if (changed) await writePending($, pendPath, pend)
}

async function readToken($: EngineInterface, dir: string): Promise<string | null> {
  try {
    return tokenFrom(await $.fs.read(`${dir}/.env`))
  } catch {
    return null
  }
}

export const register: Register = on => {
  enabled = false
  claimed = []
  token = null
  timeoutMs = FETCH_MS
  emojis = { ...DEFAULT_EMOJIS }
  keepAgent = false
  turnAgent = new Set()
  storeKey = (name: string) => name
  pending = new Map()
  retries = []
  incoming = null   // a register() during a pass starts with no half-collected list
  records = new Map()
  chain = Promise.resolve()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let warnings: string[] = []
    try {
      // When installed as a plugin next to an unmodified engine, the mod is switched on for the main agent through the
      // engine's .env CHANNEL_PLUGINS_EXTRA (enabledPlugins) -- there is no supported way to set the main agent's process
      // env. Hence: LOADED = ON; MARVEEN_TELEGRAM_REACTION=0 explicitly turns it off ('1' and unset: on).
      const on_ = (await $.env.get('MARVEEN_TELEGRAM_REACTION')) !== '0'
      // fleet-forbid-live: in a test process tree (FLEET_FORBID_LIVE=1) the mod is INERT -- it makes no Bot API calls
      const env = { FLEET_FORBID_LIVE: await $.env.get('FLEET_FORBID_LIVE') }
      enabled = false
      if (env.FLEET_FORBID_LIVE === '1') return r
      // Reactions left behind by an earlier session are cleaned up even while the mod is switched OFF (a reaction must
      // not stay orphaned just because the mod was turned off in the meantime); no new reactions while it is off
      const dir = await stateDir($)
      storeKey = (name: string) => `${name}@${dir}`
      token = await readToken($, dir)
      timeoutMs = fetchMs(await $.env.get('MARVEEN_TELEGRAM_REACTION_FETCH_MS'))
      // The emoji of each step; a bad value is a loud warning (never silent), that step keeps its default
      const cfg = emojisFrom(await $.env.get('MARVEEN_TELEGRAM_REACTION_EMOJIS'))
      emojis = cfg.emojis
      warnings = cfg.warnings.map(w => `MARVEEN_TELEGRAM_REACTION_EMOJIS ${w}`)
      const keepRaw = await $.env.get('MARVEEN_TELEGRAM_REACTION_KEEP_AGENT')
      keepAgent = keepRaw === '1'
      // A value other than 0/1 ('true', 'yes', '1 ') is not silently the default -- named,
      // without the value
      if (keepRaw != null && keepRaw !== '' && keepRaw !== '0' && keepRaw !== '1') {
        warnings.push('MARVEEN_TELEGRAM_REACTION_KEEP_AGENT is neither 0 nor 1 -- the default applies (the agent\'s emoji is cleared)')
      }
      // A previous session that ended without its turn end (crash, restart)
      // may have left reactions behind: clear them now.
      const left = await $.store.get(storeKey('pending'))
      const old = await $.store.get(storeKey('retries'))
      if (Array.isArray(old)) {
        for (const x of old) if (x && typeof x.chat_id === 'string' && Number.isFinite(x.message_id)) retryLater(x, x.emoji ?? null)
        retries = retries.map(r => ({ ...r, ...(old.find((x: any) => x && key(x) === key(r)) ?? {}) }))   // keep tries/first
      }
      if (Array.isArray(left)) {
        // one entry per message: a message already queued keeps its own (desired) entry
        for (const t of left) if (t && typeof t.chat_id === 'string' && Number.isFinite(t.message_id)) retryLater(t, null)
      }
      retryClears($)
      // the first three steps skipped = off (`after` alone does not keep it on); the cleanup above still ran
      enabled = on_ && LADDER_032.some(s => emojis[s] !== '')
      // the warnings LAST and not awaited: an op that never returns must not hold back the cleanup or the switch
      for (const w of warnings) void Promise.resolve().then(() => $.ui.log(`telegram-reaction: ${w}`)).catch(() => {})
    } catch {
      enabled = false
    }
    return r
  })

  // Inside next(e) of prompt.submit, ahead of the settings hooks: the input carries the session's transcript path
  on('classic.UserPromptSubmit', async ($, e, next) => {
    try { await stampTranscript($, (e as any).transcript_path) } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const o: any = e.origin
      if (enabled && o && o.kind === 'channel' && /telegram/i.test(String(o.server ?? ''))) {
        const targets = targetsOf(e.text)
        for (const t of targets) stage($, t, 'received')   // synchronous (the stages queued on the chain are still coalesced)
        // BEFORE the stock placeholder hook (next(e) runs the settings hooks): dedup claim + pending
        try { await claimForFactoryHook($, targets) } catch {}
      }
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      if (enabled) for (const t of [...pending.values()]) if (t.stage === 'received') stage($, t, 'working')
    } catch {}
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let replyTo: string | null = null
    let handOver: string | null = null
    let agentEmoji: string | null = null
    try {
      if (enabled && isReactTool(e.tool)) {
        // The agent sets a reaction on a message itself: that message is its
        // own from now on -- no more stages, and no clear at the turn end.
        // Only once the react call SUCCEEDED (below): a failed one (e.g. an
        // emoji Telegram does not allow) leaves our reaction in place, and the
        // turn end must still clear it. Nothing waits here.
        const input: any = e.input ?? {}
        if (input.chat_id !== undefined && Number.isFinite(Number(input.message_id))) {
          handOver = key({ chat_id: String(input.chat_id), message_id: Number(input.message_id) })
          agentEmoji = typeof input.emoji === 'string' && input.emoji ? input.emoji : null
        }
      } else if (enabled && pending.size) {
        if (isReplyTool(e.tool)) {
          replyTo = replyChat(e)
          for (const t of [...pending.values()]) if (replyTo !== null && t.chat_id === replyTo) stage($, t, 'writing')
        } else {
          for (const t of [...pending.values()]) if (t.stage === 'received') stage($, t, 'working')
        }
      }
    } catch {}
    // The reply is not the end of the turn: the reaction stays (✍️, after a successful reply 👨‍💻) until
    // turn.complete clears it. A session that dies after a reply but before the
    // turn end leaves it in the store; the next session start clears it.
    const r = await next(e)
    try {
      // the reply SUCCEEDED -- the answer is out while the turn still runs: the reply's own chat moves to `after`
      // (forward only; a failed reply stays at ✍️; an agent-owned message is left alone by stage())
      if (replyTo !== null && toolSucceeded(r)) {
        for (const t of [...pending.values()]) if (t.chat_id === replyTo) stage($, t, 'after')
      }
      const rec = handOver !== null ? records.get(handOver) : undefined
      if (!rec && handOver !== null && toolSucceeded(r)) {
        // A message the mod does not (or no longer) track: the agent's reaction is on it now (its react
        // succeeded) -- recorded as the agent's, KNOWN (no write needed), so a later re-delivery does not stage it
        const input: any = e.input ?? {}
        const nr = record({ chat_id: String(input.chat_id), message_id: Number(input.message_id) })
        nr.agent = true
        nr.desired = agentEmoji
        nr.confirmed = agentEmoji
        nr.known = true
        nr.since = Date.now()
        // With skipped steps a message can be pending WITHOUT a record -- it is the agent's now: out of
        // pending, and the store updated (sync -> persist; the write itself is skipped, the record is already known)
        if (pending.delete(handOver) || !keepAgent) sync($, handOver)
        turnAgent.add(handOver)
        // By default the agent's emoji must be cleared even if the session dies before the turn end --
        // queued (persisted with no emoji), so the next session start clears it; the closing pass drops it once settled
        if (!keepAgent) retryLater(nr)
      } else if (rec && toolSucceeded(r)) {
        // The agent's reaction becomes the DESIRED one, and our chain writes it again AFTER everything it
        // already holds -- a set of ours still running (or timed out, landing late) can never be the last word
        pending.delete(handOver!)
        rec.agent = true
        rec.since = Date.now()
        rec.desired = agentEmoji
        if (!keepAgent) retryLater(rec)   // a crash before the turn end still clears it (see above)
        // (KEEP_AGENT=0 property) the agent's react CHANGED what Telegram shows -- our confirmed value
        // is stale, so the message is unknown (a new generation): a later desired '' must not be skipped as "already right"
        unknown(rec)
        sync($, handOver!)
        turnAgent.add(handOver!)
      } else if (rec) {
        // a FAILED react may still have landed: the message is uncertain -> the closing pass writes
        // its desired reaction again (the turn-end clear of ours, or the agent's earlier emoji)
        unknown(rec)
        retryLater(rec)
      } else if (handOver !== null && !keepAgent) {
        // A react judged FAILED on a message the mod never tracked may still have LANDED (a
        // misjudged success included) -- by default no emoji stays at the turn end, without exception: the message
        // becomes the agent's with no desired reaction, UNKNOWN (so the clear is written), queued (persisted, a crash
        // still clears it) and cleared at the turn end. The bot only ever writes its own reaction: a clear is harmless.
        const input: any = e.input ?? {}
        const nr = record({ chat_id: String(input.chat_id), message_id: Number(input.message_id) })
        // a message still RUNNING (pending, no record only because its steps so far were skipped)
        // stays OURS: its ladder goes on, and the turn-end clear of pending writes the clear (unknown: not skipped)
        if (!pending.has(handOver)) {
          nr.agent = true
          turnAgent.add(handOver)
        }
        nr.desired = null
        nr.since = Date.now()
        unknown(nr)
        retryLater(nr)
        enqueue($, async () => {})   // persist only (the queue entry); the clear itself is written at the turn end
      }
      if (handOver !== null && !toolSucceeded(r)) {
        // Diagnostic: the agent's react was judged FAILED -- the message is not handed over, so our turn-end
        // clear also removes what the react may have set. The shape only (key names), never the content.
        const shape = keyNames(r)
        const inner = r && typeof r === 'object' && (r as any).result && typeof (r as any).result === 'object'
          ? keyNames((r as any).result) : typeof (r as any)?.result
        const what = !rec ? (keepAgent ? 'untracked -- the mod leaves it alone (KEEP_AGENT=1)' : pending.has(handOver) ? 'ours, still running (no record yet) -- our turn-end clear also removes what the react may have set' : 'untracked -- cleared at the turn end')
          : rec.agent ? (keepAgent ? "already the agent's -- its earlier emoji is written again" : "already the agent's -- cleared at the turn end")
          : 'ours -- our turn-end clear also removes what the react may have set'
        void Promise.resolve().then(() => $.ui.log(`telegram-reaction: the agent's react was judged FAILED (result keys: ${shape}; result.result: ${inner}); the message is ${what}`)).catch(() => {})
      }
    } catch {}
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      // A subagent's turn ending (agentId set) does not end the main loop's turn.
      if (enabled && !e.agentId) {
        // The CLOSING write: the clears first, then the retry pass -- queued after EVERYTHING this turn queued
        // (the clears included), it writes the desired reaction of every message left uncertain (a timed-out or failed
        // call, a failed clear of this turn, a hand-over); what is still uncertain stays queued for the next turn end
        // and session start (at most 20 tries / 48 h, 5 messages per pass).
        clear($, [...pending.values()])
        // The agent's own reactions of this turn are cleared too, unless KEEP_AGENT (it stays the agent's message)
        if (!keepAgent) {
          for (const k of turnAgent) {
            const rec = records.get(k)
            if (rec && rec.agent) {
              rec.desired = null
              sync($, k)
            }
          }
        }
        turnAgent = new Set()
        retryClears($, RETRY_CLOSE_MAX)
        prune($)
      }
    } catch {}
    return r
  })
}
