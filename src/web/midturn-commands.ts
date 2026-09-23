// Owner commands that arrive while the main session is mid-turn (CMDHOOKMIDROUND).
//
// Measured on the test bot, ELSOKOR922 Phase 7 (2026-09-23 09:19-09:20): four
// commands typed during a 3.5-minute memoria-heartbeat turn produced ZERO lines
// in commands-hook.log. Claude Code does not run UserPromptSubmit for a message
// that arrives mid-turn: the transcript gets a `queue-operation enqueue` line,
// then -- at the next tool boundary -- an `attachment` of type `queued_command`
// with `origin.kind: "channel"`, and the model answers it by hand, in a paid
// turn. On an idle session the same message is `enqueue` + `dequeue` and the
// hook blocks it; no `queued_command` line is written. So that line is the
// unambiguous "the hook never saw this" signal, and it never races the hook.
//
// This watcher tails the main transcript for those lines and dispatches them
// exactly like the hook would (a write refused for a busy session lands in the
// pending-write queue and runs at the turn end). The model still sees the
// message; the hook's SessionStart branch tells it these are answered here.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_PROVIDER, CHANNEL_TOKEN, MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { getProvider } from '../channel-provider.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { markIfTestRun } from '../test-run-marker.js'
import { logger } from '../logger.js'
import { projectsDirFor } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'
import { dispatchForChat } from './routes/commands.js'

const CHANNEL_RX = /<channel\s+([^>]*)>([\s\S]*?)<\/channel>/g
const COMMAND_RX = /^\/[A-Za-z][A-Za-z0-9_]{0,31}(?:@[A-Za-z0-9_]+)?(?:\s|$)/
const TELEGRAM_SOURCE_RX = /\bsource="[^"]*telegram[^"]*"/i
const TELEGRAM_MAX_TEXT = 4096
const SEEN_MAX = 200
// A read larger than this is a transcript rewrite, not a tail: skip to the end.
const MAX_READ_BYTES = 4 * 1024 * 1024

export interface MidTurnCommand {
  chatId: string
  messageId: string | null
  text: string
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? m[1] : null
}

// One transcript line -> the command it carries, or null. Same acceptance as
// the hook's main(): exactly one <channel> block, a telegram source, a chat_id,
// and a single-line body that starts with /word.
export function parseQueuedChannelCommand(line: string): MidTurnCommand | null {
  if (!line.includes('queued_command')) return null
  let entry: unknown
  try { entry = JSON.parse(line) } catch { return null }
  const att = (entry as { attachment?: Record<string, unknown> } | null)?.attachment
  if (!att || att.type !== 'queued_command') return null
  const origin = att.origin as { kind?: unknown } | undefined
  if (origin?.kind !== 'channel' || typeof att.prompt !== 'string') return null
  const blocks = [...att.prompt.matchAll(CHANNEL_RX)]
  if (blocks.length !== 1) return null
  const attrs = blocks[0][1]
  const body = blocks[0][2].trim()
  if (!COMMAND_RX.test(body) || body.includes('\n')) return null
  if (!TELEGRAM_SOURCE_RX.test(attrs)) return null
  const chatId = attr(attrs, 'chat_id')
  if (!chatId) return null
  return { chatId, messageId: attr(attrs, 'message_id'), text: body }
}

export interface TailState {
  file: string | null
  offset: number
  partial: string
  seen: string[]
}

export function newTailState(): TailState {
  return { file: null, offset: 0, partial: '', seen: [] }
}

export function newestJsonl(dir: string): string | null {
  let best: string | null = null
  let bestMtime = -1
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue
    let m: number
    try { m = statSync(join(dir, f)).mtimeMs } catch { continue }
    if (m > bestMtime) { bestMtime = m; best = join(dir, f) }
  }
  return best
}

// Advance the tail over `file` and return the new complete lines. The first
// file seen after boot starts at its END (no replay of history the model has
// long answered); a file that appears later is a new session and is read from
// the start. A shrunk file (rewritten) restarts at its end.
export function readNewLines(state: TailState, file: string | null, firstRun: boolean): string[] {
  if (!file) return []
  let size: number
  try { size = statSync(file).size } catch { return [] }
  if (file !== state.file) {
    state.file = file
    state.partial = ''
    state.offset = firstRun ? size : 0
  }
  if (size < state.offset || size - state.offset > MAX_READ_BYTES) {
    if (size < state.offset) logger.warn({ file }, 'midturn-commands: transcript shrank, tail restarted at its end')
    else logger.warn({ file, bytes: size - state.offset }, 'midturn-commands: transcript jumped, skipped to its end')
    state.offset = size
    state.partial = ''
    return []
  }
  if (size === state.offset) return []
  const buf = Buffer.alloc(size - state.offset)
  const fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, buf.length, state.offset) } finally { closeSync(fd) }
  state.offset = size
  const text = state.partial + buf.toString('utf-8')
  const lines = text.split('\n')
  state.partial = lines.pop() ?? ''
  return lines
}

export interface MidTurnDeps {
  transcriptDir: () => string
  ownerChatId: () => string | null
  dispatch: typeof dispatchForChat
  send: (chatId: string, text: string) => Promise<void>
  now: () => number
  sleep?: (ms: number) => Promise<void>
}

export const SEND_ATTEMPTS = 3
const SEND_RETRY_MS = 1500

// Measured on the test bot (2026-09-23 15:00): one `connect ETIMEDOUT` to
// api.telegram.org and the /runs answer was gone, silently. A reply the
// command already produced is worth two more tries.
async function sendWithRetry(deps: MidTurnDeps, chatId: string, text: string): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.send(chatId, text)
      return
    } catch (err) {
      if (attempt >= SEND_ATTEMPTS) throw err
      logger.warn({ err, attempt }, 'midturn-commands: reply send failed, retrying')
      await sleep(SEND_RETRY_MS * attempt)
    }
  }
}

// One tick: read the new transcript lines, dispatch every mid-turn command
// once. Never throws: a bad line, a failed dispatch or a failed send is logged
// and the next tick runs as usual.
export async function midTurnTick(state: TailState, deps: MidTurnDeps, firstRun = false): Promise<number> {
  let lines: string[]
  try {
    lines = readNewLines(state, newestJsonl(deps.transcriptDir()), firstRun)
  } catch (err) {
    logger.warn({ err }, 'midturn-commands: transcript read failed')
    return 0
  }
  let handled = 0
  for (const line of lines) {
    const cmd = parseQueuedChannelCommand(line)
    if (!cmd) continue
    const key = `${cmd.chatId}:${cmd.messageId ?? cmd.text}`
    if (cmd.messageId && state.seen.includes(key)) continue
    state.seen.push(key)
    if (state.seen.length > SEEN_MAX) state.seen.splice(0, state.seen.length - SEEN_MAX)
    try {
      const result = await deps.dispatch(cmd.text, cmd.chatId, deps.ownerChatId(), deps.now(), true, false)
      if (!result.handled) {
        logger.info({ text: cmd.text, outcome: result.outcome }, 'midturn-commands: not ours, left to the model')
        continue
      }
      for (const r of result.replies) if (r) await sendWithRetry(deps, cmd.chatId, r)
      handled++
      logger.info(
        { text: cmd.text, outcome: result.outcome, messageId: cmd.messageId, reply: result.replies.join('\n---\n').slice(0, 2000) },
        'midturn-commands: answered a command that arrived mid-turn',
      )
    } catch (err) {
      logger.warn({ err, text: cmd.text }, 'midturn-commands: dispatch or reply failed')
    }
  }
  return handled
}

function chunks(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_TEXT) out.push(text.slice(i, i + TELEGRAM_MAX_TEXT))
  return out.length ? out : ['']
}

const liveDeps: MidTurnDeps = {
  transcriptDir: () => projectsDirFor(PROJECT_ROOT, configDirFor(MAIN_AGENT_ID)),
  ownerChatId: () => resolveOwnerChatId(),
  dispatch: dispatchForChat,
  // Plain text, like the hook: a command reply is not HTML-formatted.
  send: async (chatId, text) => {
    if (!CHANNEL_TOKEN) throw new Error('no channel token')
    const provider = getProvider(CHANNEL_PROVIDER)
    for (const c of chunks(markIfTestRun(text))) await provider.sendMessage(CHANNEL_TOKEN, chatId, c)
  },
  now: () => Date.now(),
}

export const MIDTURN_POLL_MS = 3000

export function startMidTurnCommandWatcher(deps: MidTurnDeps = liveDeps): NodeJS.Timeout {
  const state = newTailState()
  let first = true
  let running = false
  const tick = () => {
    if (running) return
    running = true
    midTurnTick(state, deps, first)
      .catch(err => logger.warn({ err }, 'midturn-commands: tick failed'))
      .finally(() => { first = false; running = false })
  }
  tick()
  const t = setInterval(tick, MIDTURN_POLL_MS)
  t.unref?.()
  return t
}
