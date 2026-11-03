import { test, expect } from 'claude-code/testing'
import { emojisFrom, DEFAULT_EMOJIS, keyNames, targetsOf } from '../hooks/register'

// The engine stand-ins: every op the mod calls is answered here, beneath it, so
// nothing touches the disk, the network, a session or a timer.
const STATE_DIR = '/install/agents/alpha/.claude/channels/telegram'
const TOKEN = '123456:test-token-not-real'
const REPLY = 'mcp__plugin_telegram_telegram__reply'
const ORIGIN = { kind: 'channel', server: 'plugin:telegram:telegram' }

type Opts = {
  env?: Record<string, string | undefined>
  store?: Record<string, unknown>
  /** HTTP status for the Nth (1-based) Bot API call; default 200. */
  status?: (n: number) => number
  /** The reply tool's result. */
  replyResult?: Record<string, unknown>
  /** The react tool's result. */
  reactResult?: Record<string, unknown>
  /** The 0.3.3 `after` step is ON as configured. Without it the engine forces `after=` (empty) onto the emoji
   *  setting, so every 0.3.2 test below keeps running UNCHANGED against the step-off path (the bit-identity of `after=`). */
  after?: boolean
  /** Every Bot API call hangs forever. */
  hang?: boolean
  /** The Nth (1-based) Bot API call answers only after this many ms. */
  slow?: { n: number; ms: number }
  /** Files present before the session (path -> text), e.g. an existing pending file. */
  files?: Record<string, string>
  /** fs.write fails. */
  writeFails?: boolean
  /** fs.write fails for the paths this predicate picks. */
  failWrite?: (path: string) => boolean
  /** the pending rename (/bin/mv) fails */
  mvFails?: boolean
  /** A simulated Telegram -- each Bot API call LANDS (sets the message's reaction) after its own delay,
   *  then answers; a failed call (500) does not land. The agent's react tool lands its emoji the same way. */
  sim?: { fetchMs: (n: number) => number; answerMs?: (n: number) => number; failed?: (n: number) => boolean; landedFail?: (n: number) => boolean;
    hangs?: (n: number) => boolean; reactMs?: () => number; reactOk?: () => boolean; reactLandedFail?: () => boolean }
}

/** The emoji setting with the `after` step switched off (a shell-style quoted value keeps its quotes around the items). */
function legacyEmojis(v: string | undefined): string {
  let t = (v ?? '').trim()
  const q = t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]
  if (q) t = t.slice(1, -1).trim()
  return (t ? t + ',' : '') + 'after='
}

function engine(on: any, opts: Opts = {}) {
  // The 0.2.x tests keep the agent's own emoji (KEEP_AGENT=1); the 0.3.0 default (cleared) is tested apart
  const env = opts.env ?? { MARVEEN_TELEGRAM_REACTION: '1', TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' }
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const calls: { url: string; body: any }[] = []
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const order: string[] = []
  const tg = new Map<string, string>()   // the simulated Telegram: chat:message -> the reaction it shows ('' = none)
  const out = { n: 0 }                    // simulated calls not answered yet
  const landedReacts: { key: string; emoji: string }[] = []   // the agent's reacts that LANDED, in order
  const logs: string[] = []   // the $.ui.log lines (the warnings shown in the session transcript)
  on('ui.log', ($: any, e: any) => {
    logs.push(typeof e?.text === 'string' ? e.text : JSON.stringify(e))
    return { value: undefined }
  })
  on('env.get', ($: any, e: { name: string }) => ({
    value: e.name === 'MARVEEN_TELEGRAM_REACTION_EMOJIS' && !opts.after ? legacyEmojis(env[e.name]) : env[e.name],
  }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', ($: any, e: { path: string }) => {
    if (e.path === `${STATE_DIR}/.env`) return { value: `TELEGRAM_BOT_TOKEN=${TOKEN}\n` }
    if (files.has(e.path)) return { value: files.get(e.path) }
    throw new Error('ENOENT')
  })
  on('fs.write', ($: any, e: { path: string; text: string }) => {
    if (opts.writeFails || (opts.failWrite && opts.failWrite(e.path))) throw new Error('EACCES')
    files.set(e.path, e.text)
    order.push('write:' + e.path.slice(STATE_DIR.length + 1).replace(/\.tmp-\d+-\d+$/, '.tmp'))
    return { value: undefined }
  })
  // The atomic pending write renames a tmp file over the pending file
  on('process.run', ($: any, e: { argv: string[] }) => {
    const [cmd, , src, dst] = e.argv
    if (cmd === '/bin/rm') {
      files.delete(src)
      order.push('rm:' + src.slice(STATE_DIR.length + 1).replace(/\.tmp-\d+-\d+$/, '.tmp'))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd !== '/bin/mv' || opts.mvFails || !files.has(src)) {
      return { value: { exitCode: 1, stdout: '', stderr: 'mv failed', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    files.set(dst, files.get(src)!)
    files.delete(src)
    order.push('mv:' + dst.slice(STATE_DIR.length + 1))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', ($: any, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('http.fetch', ($: any, e: { url: string; init: any }) => {
    calls.push({ url: e.url, body: JSON.parse(e.init.body) })
    if (opts.sim) {
      const n = calls.length
      const b = JSON.parse(e.init.body)
      const fail = opts.sim.failed ? opts.sim.failed(n) : false
      const landedFail = !fail && opts.sim.landedFail ? opts.sim.landedFail(n) : false   // landed, but answered 500
      if (opts.sim.hangs && opts.sim.hangs(n)) return new Promise(() => {})   // never answers (may or may not have landed)
      out.n += 1
      // the request LANDS at one moment and is ANSWERED later (landed earlier, answered later)
      const land = opts.sim.fetchMs(n)
      const answer = land + (opts.sim.answerMs ? opts.sim.answerMs(n) : 0)
      setTimeout(() => { if (!fail) tg.set(`${b.chat_id}:${b.message_id}`, b.reaction[0]?.emoji ?? '') }, land)
      return new Promise(r => setTimeout(() => {
        out.n -= 1
        r({ value: { status: fail || landedFail ? 500 : 200, headers: {}, body: '{}' } })
      }, answer))
    }
    if (opts.hang) return new Promise(() => {})
    if (opts.slow && calls.length === opts.slow.n) {
      return new Promise(r => setTimeout(() => r({ value: { status: 200, headers: {}, body: '{"ok":true}' } }), opts.slow!.ms))
    }
    const status = opts.status ? opts.status(calls.length) : 200
    return { value: { status, headers: {}, body: '{"ok":true}' } }
  })
  on('session.start', ($: any, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.submit', ($: any, e: { text: string }) => {
    order.push('engine:prompt.submit')   // here the engine runs the UserPromptSubmit settings hooks
    return { text: e.text }
  })
  // the classic UserPromptSubmit event, beneath the mod: no settings hook answers it here
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.start', ($: any, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', ($: any, e: { tool: string; input: any }) =>
    opts.sim && /__react$/.test(e.tool) ? new Promise(r => {
      const ok = opts.sim!.reactOk ? opts.sim!.reactOk() : true
      const landed = ok || (opts.sim!.reactLandedFail ? opts.sim!.reactLandedFail() : false)   // a failed react that landed
      out.n += 1
      setTimeout(() => {
        if (landed) {
          tg.set(`${e.input.chat_id}:${e.input.message_id}`, e.input.emoji ?? '')
          landedReacts.push({ key: `${e.input.chat_id}:${e.input.message_id}`, emoji: e.input.emoji ?? '' })
        }
        out.n -= 1
        r(ok ? { result: { content: [{ type: 'text', text: 'reacted' }] } } : { result: { isError: true } })
      }, opts.sim!.reactMs ? opts.sim!.reactMs() : 0)
    }) : e.tool === REPLY ? (opts.replyResult ?? { result: { content: [{ type: 'text', text: 'sent' }] } })
      : /__react$/.test(e.tool) && opts.reactResult ? opts.reactResult : { result: { stdout: 'ok' } })
  on('turn.complete', () => ({ text: '' }))
  return { calls, store, files, order, tg, out, landedReacts, logs }
}

// The mod's Bot API calls are a chain it does not await: let it drain.
const settle = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

const tag = (chat = '111', mid = 5) => `<channel source="plugin:telegram:telegram" chat_id="${chat}" message_id="${mid}" user="u" ts="2026-10-10T20:00:00Z">`
const start = ($: any) => $.session.start({ cwd: '/anywhere', surface: null, isInteractive: true })
const submit = ($: any, text = `${tag()}\nhello\n</channel>`, origin: unknown = ORIGIN) => $.prompt.submit({ text, origin })
const turn = ($: any, id = 't1') => $.turn.start({ text: 'hello', turnId: id })
const tool = ($: any, name = 'Bash', input: Record<string, unknown> = { command: 'ls' }, id = 'u1') =>
  $.tool.call({ tool: name, input, tool_use_id: id })
const reply = ($: any, chat = '111', id = 'r1') => tool($, REPLY, { chat_id: chat, text: 'answer' }, id)
const done = ($: any, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...extra })

/** The emoji each call set ('' = cleared), in order. */
const ladder = (calls: { body: any }[]) => calls.map(c => (c.body.reaction[0]?.emoji ?? ''))

test('loaded = on -- without MARVEEN_TELEGRAM_REACTION the mod works (the engine .env CHANNEL_PLUGINS_EXTRA loads it)', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR } })
  await start($)
  await submit($)
  await settle()
  expect(ladder(calls)).toEqual(['👀'])
})

test('FLEET_FORBID_LIVE=1 (a test process tree) makes the mod inert: nothing reaches the Bot API', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION: '1', FLEET_FORBID_LIVE: '1' } })
  await start($)
  await submit($)
  await turn($)
  await reply($)
  await done($)
  await settle()
  expect(calls).toEqual([])
})

test('MARVEEN_TELEGRAM_REACTION=0 turns it off: nothing reaches the Bot API', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION: '0' } })
  await start($)
  await submit($)
  await turn($)
  await reply($)
  await done($)
  await settle()
  expect(calls).toEqual([])
})

test('the full ladder on the user message: 👀 -> 🤔 -> ✍️ -> cleared at the turn end', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await tool($)            // 🤔 already: no second call
  await settle()
  await reply($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️'])   // the reply is not the end: no clear yet
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', ''])
  expect(calls.every(c => c.body.chat_id === '111' && c.body.message_id === 5)).toBe(true)
  expect(calls.every(c => c.url === `https://api.telegram.org/bot${TOKEN}/setMessageReaction`)).toBe(true)
})

test('a tool call before turn.start also moves 👀 to 🤔, and the reaction never steps back', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await tool($)
  await settle()
  await reply($, '999')    // another chat: nothing for chat 111
  await settle()
  await turn($)            // already 🤔: no call
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔'])
})

test('only a Telegram channel delivery counts: other origins and quoted tags get no reaction', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  const seen: number[] = []
  await submit($, `please look at this: ${tag()}`)                      // the tag is not at the start
  await settle(); seen.push(calls.length)
  await submit($, `${tag()}\nx`, { kind: 'channel', server: 'plugin:slack:slack' })
  await settle(); seen.push(calls.length)
  await submit($, `${tag()}\nx`, { kind: 'user' })                       // typed by hand
  await settle(); seen.push(calls.length)
  await submit($, `${tag()}\nx`, { kind: 'mcp', server: 'plugin:telegram:telegram' })   // not a channel delivery
  await settle(); seen.push(calls.length)
  await $.prompt.submit({ text: `${tag()}\nx` })                        // no origin at all
  await settle(); seen.push(calls.length)
  expect(seen).toEqual([0, 0, 0, 0, 0])
})

test('every hook passes the engine result through unchanged', async ($: any, on: any) => {
  engine(on)
  await start($)
  const text = `${tag()}\nhello\n</channel>`
  expect(await submit($, text)).toEqual({ text })
  expect(await tool($)).toEqual({ result: { stdout: 'ok' } })
  expect(await reply($)).toEqual({ result: { content: [{ type: 'text', text: 'sent' }] } })
})

test('a failed reply moves to ✍️ like any reply; the turn end clears it', async ($: any, on: any) => {
  const { calls } = engine(on, { replyResult: { result: { isError: true } } })
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await reply($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️'])
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', ''])
})

test('a subagent turn ending does not clear the main turn', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await turn($)
  await done($, { agentId: 'sub-1' })
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔'])
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', ''])
})

test('a reply moves only its own chat to ✍️; nothing is cleared before the turn end, then both are', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($, `${tag('111', 5)}\na`)
  await submit($, `${tag('222', 7)}\nb`)
  await settle()
  await reply($, '222')
  await settle()
  expect(calls.filter(c => c.body.reaction.length === 0)).toEqual([])
  expect(calls.filter(c => c.body.reaction[0]?.emoji === '✍️').map(c => c.body.chat_id)).toEqual(['222'])
  await done($)
  await settle()
  expect(calls.filter(c => c.body.reaction.length === 0).map(c => c.body.chat_id).sort()).toEqual(['111', '222'])
})

test('a turn that answers in several messages keeps ✍️ to the end: more tool calls and replies never clear it', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await turn($)
  await reply($)
  await settle()
  await tool($)             // the agent works on after its first message
  await reply($)            // and sends another one
  await tool($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️'])
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', ''])
})

test('a failed clear is repeated by the closing pass of the same turn end; failing again it waits for the next one', async ($: any, on: any) => {
  // calls: 1 👀, 2 🤔, 3 clear (fails), 4 the closing pass (fails), 5 the next turn end (ok)
  const { calls, store } = engine(on, { status: n => (n === 3 || n === 4 ? 502 : 200) })
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '', ''])
  expect(store.get(`retries@${STATE_DIR}`)).toHaveLength(1)
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '', '', ''])
  expect(store.get(`retries@${STATE_DIR}`)).toEqual([])
})

test('reactions a crashed session left behind are cleared on the next session start', async ($: any, on: any) => {
  const { calls, store } = engine(on, { store: { [`pending@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, stage: '🤔' }, { chat_id: '111', message_id: 3, stage: '✍️' }], 'pending@/other/bot': [{ chat_id: '111', message_id: 9, stage: '👀' }] } })
  await start($)
  await settle()
  // also the ✍️ of a session that died after its reply, before the turn end
  expect(calls.map(c => [c.body.chat_id, c.body.message_id, c.body.reaction])).toEqual([['111', 4, []], ['111', 3, []]])
  expect(store.get(`retries@${STATE_DIR}`)).toEqual([])
})

test('the bot token stays in memory: never in the store', async ($: any, on: any) => {
  const { store } = engine(on, { status: n => (n === 3 ? 502 : 200) })
  await start($)
  await submit($)
  await turn($)
  await done($)
  await settle()
  expect(JSON.stringify([...store.entries()]).includes(TOKEN)).toBe(false)
  expect(JSON.stringify([...store.entries()]).includes('123456')).toBe(false)
})

test('a hanging Bot API never holds the agent: every hook returns at once', async ($: any, on: any) => {
  const { calls } = engine(on, { hang: true })
  await start($)
  expect(await submit($, `${tag()}\nhi`)).toEqual({ text: `${tag()}\nhi` })
  expect(await reply($)).toEqual({ result: { content: [{ type: 'text', text: 'sent' }] } })
  await settle()
  expect(calls.length).toBe(1)   // the chain waits on the first call; nothing piles up in parallel
})

test('no token file: the mod stays quiet', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { MARVEEN_TELEGRAM_REACTION: '1', TELEGRAM_STATE_DIR: '/elsewhere' } })
  await start($)
  await submit($)
  await turn($)
  await done($)
  await settle()
  expect(calls).toEqual([])
})

// prompt.submit waits for the stock-hook claim (it must land before the settings hooks), so the
// queued 👀 always goes out before turn.start stages 🤔 -- the full ladder, one Bot API call more than the old
// coalesced ['🤔']. The forward-only rule still holds (no step back to 👀).
test('with the claim awaited in prompt.submit, 👀 goes out first, then 🤔 -- never back', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await turn($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔'])
})

test('a repeated delivery of the same message never steps the reaction back to 👀', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await submit($)          // the same chat_id + message_id again
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔'])
})

test('the live reaction is kept in the store, so a crashed session can be cleaned up on the next start', async ($: any, on: any) => {
  const { store } = engine(on)
  await start($)
  await submit($)
  await settle()
  // The store keeps the STEP (an older session's emoji-valued entry is read by chat/message only, see above)
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '111', message_id: 5, stage: 'received' }])
  await reply($)
  await settle()
  // after the reply the turn is still on: a session that dies NOW (no turn end) leaves ✍️ in the store
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '111', message_id: 5, stage: 'writing' }])
  await done($)
  await settle()
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([])
})

test('a batched delivery: every message in it gets the reaction, and is cleared', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($, `${tag('111', 5)}\na\n</channel>\n${tag('111', 6)}\nb\n</channel>`)
  await settle()
  await done($)
  await settle()
  expect(calls.map(c => [c.body.message_id, c.body.reaction[0]?.emoji ?? ''])).toEqual([[5, '👀'], [6, '👀'], [5, ''], [6, '']])
})

test('only the reply tool counts as the reply: a tool merely named like it does not', async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await tool($, 'mcp__telegram_archive__reply_count', { chat_id: '111' })
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔'])
})

test("after its reply the agent's own reaction takes over the message: no clear of ours at the turn end", async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await reply($)
  await settle()
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await done($)
  await settle()
  // The agent's emoji is written once more on our chain (after everything it held), never cleared
  expect(ladder(calls)).toEqual(['👀', '✍️', '👍'])
})

test("a FAILED own reaction (e.g. an emoji Telegram rejects) does not take the message over: the turn end still clears ✍️", async ($: any, on: any) => {
  const { calls, store } = engine(on, { reactResult: { result: { isError: true } } })
  await start($)
  await submit($)
  await settle()
  await reply($)
  await settle()
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '✅' })
  await settle()
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '111', message_id: 5, stage: 'writing' }])
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '✍️', ''])
})

test("the agent's own reaction (the channel's react tool) is left alone: no stage, no clear", async ($: any, on: any) => {
  const { calls } = engine(on)
  await start($)
  await submit($)
  await settle()
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await settle()
  await turn($)
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '👍'])   // no 🤔 stage, no clear; the agent's emoji written again on our chain
})

const FAST = { MARVEEN_TELEGRAM_REACTION: '1', TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_FETCH_MS: '100', MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Until the chain is drained and every simulated request answered (also the syncs a late answer queues). */
async function quiet(out: { n: number }) {
  let calm = 0
  for (let i = 0; calm < 3 && i < 2000; i++) {   // a slow cascade of late answers may take seconds (measured: 8 s)
    await settle()
    await sleep(15)
    await settle()
    calm = out.n === 0 ? calm + 1 : 0
  }
  if (calm < 3) throw new Error(`quiet(): ${out.n} simulated request(s) never answered`)   // never a silent pass
}

test("the agent's react does not wait; our set still on the wire lands AFTER the agent's reaction, and the chain then writes the agent's emoji again", async ($: any, on: any) => {
  // call 1 (👀) lands at 50 ms (inside the 100 ms timeout); the agent's 👍 lands at once
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: n => (n === 1 ? 50 : 0) } })
  await start($)
  await submit($)
  const t0 = Date.now()
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  expect(Date.now() - t0).toBeLessThan(40)       // no waiting in the hook
  expect(tg.get('111:5')).toBe('👍')
  await quiet(out)                                 // our 👀 landed after it -- then the chain wrote 👍 again
  expect(ladder(calls)).toEqual(['👀', '👍'])
  expect(tg.get('111:5')).toBe('👍')               // BEFORE any turn end
})

test("our set TIMED OUT and lands after the agent's reaction: its late answer syncs the message, the agent's emoji wins", async ($: any, on: any) => {
  // call 1 (👀) lands at 250 ms, the timeout is 100 ms
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: n => (n === 1 ? 250 : 0) } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await quiet(out)
  expect(tg.get('111:5')).toBe('👍')
  expect(ladder(calls)).toEqual(['👀', '👍', '👍'])   // the 2nd 👍: the late 👀 answer re-synced the message
})

test("a request that never answers: the turn-end retry pass writes the desired reaction again anyway (it may have landed late)", async ($: any, on: any) => {
  // call 1 (👀) never answers; the agent's 👍 hand-over (call 2) is fine; the turn end's retry pass writes 👍 again (call 3)
  const { calls, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, hangs: n => n === 1 } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await sleep(130)
  await quiet(out)
  expect(ladder(calls)).toEqual(['👀', '👍'])
  await done($)
  await quiet(out)
  expect(ladder(calls)).toEqual(['👀', '👍', '👍'])
})

test("the retry queue in the store carries the DESIRED reaction (the agent's emoji), so a new session restores it, not a clear", async ($: any, on: any) => {
  // call 2 (the hand-over write of 👍) fails
  const { store, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, failed: n => n === 2 } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await quiet(out)
  expect((store.get(`retries@${STATE_DIR}`) as any[]).map(r => [r.message_id, r.emoji])).toEqual([[5, '👍']])
})

test("a late answer arrives while a NEWER write is still out: that write must not mark the message known (the late one may have landed after it)", async ($: any, on: any) => {
  // call 1 (👀): lands at 150 ms, answers at 170 (timed out at 100); call 2 (the hand-over 👍, sent at ~100 ms): lands at
  // ~105, answers at ~190 (inside its timeout) -- so 👀 lands AFTER 👍, and its answer comes BEFORE 👍's answer
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: n => (n === 1 ? 150 : 5), answerMs: n => (n === 1 ? 20 : n === 2 ? 85 : 0) } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await quiet(out)
  expect(tg.get('111:5')).toBe('👍')
  expect(ladder(calls)).toEqual(['👀', '👍', '👍'])
})

test('a hanging request of an earlier session never stalls the chain: the new reactions still go out', async ($: any, on: any) => {
  const { calls } = engine(on, { env: FAST, store: { [`retries@${STATE_DIR}`]: [{ chat_id: '222', message_id: 7, tries: 0, first: Date.now() }] },
    sim: { fetchMs: () => 0, hangs: n => n === 1 } })
  await start($)
  await submit($)
  await sleep(150)
  await settle()
  expect(ladder(calls)).toEqual(['', '👀'])   // the old clear hangs; after its timeout the chain goes on
})

test("a FAILED agent react that still landed on a message the agent ALREADY owns: uncertain, the closing pass writes the agent's earlier emoji again", async ($: any, on: any) => {
  // the first react (👍) succeeds -> the agent owns the message, 👍 confirmed; the second (❤) fails but lands
  let n = 0
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, reactOk: () => ++n === 1, reactLandedFail: () => true } })
  await start($)
  await submit($)
  await quiet(out)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await quiet(out)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '❤' }, 'x2')
  await quiet(out)
  expect(tg.get('111:5')).toBe('❤')   // it landed although the tool call failed
  await done($)
  await quiet(out)
  expect(tg.get('111:5')).toBe('👍')
  expect(ladder(calls)).toEqual(['👀', '👍', '👍'])
})

test("a RE-DELIVERY of a message the agent took over does not take it back: no stage, no clear, the agent's emoji stays", async ($: any, on: any) => {
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0 } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await quiet(out)
  await submit($)          // the same message delivered again
  await turn($)
  await done($)
  await quiet(out)
  expect(tg.get('111:5')).toBe('👍')
  expect(ladder(calls)).toEqual(['👀', '👍'])
})

test("a stage of a dead turn is never persisted for a restore: a failed 👀 is queued as a CLEAR", async ($: any, on: any) => {
  const { store, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, failed: n => n === 1 } })
  await start($)
  await submit($)
  await quiet(out)
  expect((store.get(`retries@${STATE_DIR}`) as any[]).map(r => [r.message_id, r.emoji])).toEqual([[5, null]])
})

test("a message in both the stored retry queue and the stored pending list is cleared ONCE at the session start", async ($: any, on: any) => {
  const { calls } = engine(on, { store: { [`retries@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, tries: 2, first: Date.now(), emoji: null }],
    [`pending@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, stage: '🤔' }] } })
  await start($)
  await settle()
  expect(calls.map(c => [c.body.message_id, c.body.reaction])).toEqual([[4, []]])
})

test("an earlier session's queued clear (500 at the start) and the agent reacting on that message now: the agent's emoji stays", async ($: any, on: any) => {
  // call 1: the session-start retry of 111:4 fails (500); the agent reacts 👍 on 111:4; the turn end must not clear it
  const { tg, out, store } = engine(on, { env: FAST, store: { [`retries@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, tries: 0, first: Date.now(), emoji: null }] },
    sim: { fetchMs: () => 0, failed: n => n === 1 } })
  tg.set('111:4', '🤔')
  await start($)
  await quiet(out)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 4, emoji: '👍' })
  await quiet(out)
  await done($)
  await quiet(out)
  expect(tg.get('111:4')).toBe('👍')
  expect(tg.get('111:5')).toBe('')
  for (let i = 0; i < 3; i++) { await done($, { turnId: `t${i + 2}` }); await quiet(out) }
  expect(tg.get('111:4')).toBe('👍')
  expect((store.get(`retries@${STATE_DIR}`) as any[]).length).toBe(0)
})

test("a RE-DELIVERY in a LATER turn (after the turn-end prune) does not take the message back from the agent", async ($: any, on: any) => {
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0 } })
  await start($)
  await submit($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await done($)
  await quiet(out)
  await submit($)                // the next turn: the same message delivered again
  await turn($, 't2')
  await done($, { turnId: 't2' })
  await quiet(out)
  expect(tg.get('111:5')).toBe('👍')
  expect(ladder(calls)).toEqual(['👀', '👍'])
})

test('8 messages, every first write and every turn-end clear fails: the closing pass of the SAME turn end clears all 8', async ($: any, on: any) => {
  const mids = [1, 2, 3, 4, 5, 6, 7, 8]
  // calls 1-8: the 👀s (500), 9-16: the turn-end clears (500), 17-24: the closing pass (ok)
  const { tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, failed: n => n <= 16 } })
  for (const m of mids) tg.set(`111:${m}`, '✍️')
  await start($)
  await submit($, mids.map(m => `${tag('111', m)}\nhi\n</channel>`).join('\n'))
  await quiet(out)
  await done($)
  await quiet(out)
  expect(mids.map(m => tg.get(`111:${m}`))).toEqual(mids.map(() => ''))
})

test("the agent reacts on a message the mod never tracked, then that message is delivered: the agent's emoji stays (no stage, no clear)", async ($: any, on: any) => {
  const { calls, tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0 } })
  await start($)
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 9, emoji: '👍' })
  await quiet(out)
  await submit($, `${tag('111', 9)}\nhi\n</channel>`)
  await turn($)
  await done($)
  await quiet(out)
  expect(tg.get('111:9')).toBe('👍')
  expect(calls.length).toBe(0)   // nothing to write: the agent's reaction is the desired one and it is known
})

test("6 queued messages of an earlier session (the start pass writes 5); the agent reacts on the 6th BEFORE its retry: the agent's emoji stays", async ($: any, on: any) => {
  const q = [1, 2, 3, 4, 5, 6].map(m => ({ chat_id: '111', message_id: m, tries: 0, first: Date.now(), emoji: null }))
  const { tg, out } = engine(on, { env: FAST, store: { [`retries@${STATE_DIR}`]: q }, sim: { fetchMs: () => 0 } })
  for (const m of [1, 2, 3, 4, 5, 6]) tg.set(`111:${m}`, '🤔')
  await start($)
  await quiet(out)
  expect([1, 2, 3, 4, 5, 6].map(m => tg.get(`111:${m}`))).toEqual(['', '', '', '', '', '🤔'])   // 5 per start pass
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 6, emoji: '👍' })
  await quiet(out)
  await done($)
  await quiet(out)
  expect(tg.get('111:6')).toBe('👍')
})

test("a message in both stored lists whose clear FAILS at the session start is tried ONCE in that pass (no duplicate entry hammering it)", async ($: any, on: any) => {
  const { calls, out, store } = engine(on, { env: FAST, store: { [`retries@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, tries: 2, first: Date.now(), emoji: null }],
    [`pending@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, stage: '🤔' }] }, sim: { fetchMs: () => 0, failed: n => n === 1 } })
  await start($)
  await quiet(out)
  expect(calls.length).toBe(1)
  expect(((store.get(`retries@${STATE_DIR}`) as any[]) ?? []).length).toBe(1)   // still queued, once
})

test('switched OFF, a crashed session\'s leftover reaction is still cleared at the session start (no new reactions)', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION: '0' },
    store: { [`pending@${STATE_DIR}`]: [{ chat_id: '111', message_id: 9, stage: '🤔' }] } })
  await start($)
  await settle()
  await submit($)
  await settle()
  expect(calls.map(c => [c.body.message_id, c.body.reaction[0]?.emoji ?? ''])).toEqual([[9, '']])
})

test('a set that timed out may still land after the clear: its late answer clears again, and the retry queue keeps it until then', async ($: any, on: any) => {
  // calls: 1 👀 (lands at 300 ms, the timeout is 100 ms), 2 clear, 3 the closing pass (forced: a request is still out),
  // 4 the clear its late answer queued
  const { calls, store, tg, out } = engine(on, { env: FAST, sim: { fetchMs: n => (n === 1 ? 300 : 0) } })
  await start($)
  await submit($)
  await sleep(150)
  await done($)
  await settle()
  await sleep(5)
  await settle()
  expect(store.get(`retries@${STATE_DIR}`)).toHaveLength(1)   // still out: kept
  expect(tg.get('111:5')).toBe('')
  await quiet(out)
  expect(tg.get('111:5')).toBe('')                            // the late 👀 landed, then was cleared again
  expect(ladder(calls)).toEqual(['👀', '', '', ''])
  await done($)
  await settle()
  expect(store.get(`retries@${STATE_DIR}`)).toEqual([])      // known right now: dropped without a call
  expect(calls.length).toBe(4)
})


// The stock placeholder hook's dedup contract -- the mod claims the message BEFORE the engine runs
// the UserPromptSubmit settings hooks, and records the pending reply in the stock hook's format.
const PROGRESS = `${STATE_DIR}/progress`

test('the claim marker and the pending entry are written BEFORE the settings hooks run (the dedup contract)', async ($: any, on: any) => {
  const { files, order } = engine(on)
  await start($)
  await submit($)
  const i = order.indexOf('engine:prompt.submit')
  // The pending entry FIRST (tmp + rename), the dedup marker only after it
  expect(order.slice(0, i)).toEqual(['write:progress/sess-1.json.tmp', 'mv:progress/sess-1.json', 'write:progress/seen-sess-1-5.marker'])
  expect(files.get(`${PROGRESS}/seen-sess-1-5.marker`)).toBe('')
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([{ chat_id: '111', src_mid: '5' }])
})

test('an existing pending file is kept and extended; the same message is not recorded twice', async ($: any, on: any) => {
  const old = [{ chat_id: '999', message_id: 7, src_mid: '3' }]
  const { files } = engine(on, { files: { [`${PROGRESS}/sess-1.json`]: JSON.stringify(old) } })
  await start($)
  await submit($)
  await submit($)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([...old, { chat_id: '111', src_mid: '5' }])
})

// TELEGRAM_TOPICS_ENABLED (the stock #1893): a message from a topic carries message_thread_id on its channel tag; the stock
// placeholder hook records it in the pending entry, and the fallback senders (Stop enforcer, watchdog) reply into that
// topic. The mod's own pending entry must carry it too -- otherwise, with topics on, the fallback reply would land in the
// main chat.
const topicTag = (thread = 12) =>
  `<channel source="plugin:telegram:telegram" chat_id="111" message_id="5" message_thread_id="${thread}" user="u" ts="2026-10-10T20:00:00Z">`

test('a message from a topic: the pending entry carries its message_thread_id (as a number, like the stock hook)', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($, `${topicTag(12)}\nhello\n</channel>`)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([{ chat_id: '111', src_mid: '5', message_thread_id: 12 }])
  expect(files.get(`${PROGRESS}/seen-sess-1-5.marker`)).toBe('')
})

test('without a topic the pending file is byte for byte the old one (no message_thread_id key)', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($)
  expect(files.get(`${PROGRESS}/sess-1.json`)).toBe('[{"chat_id":"111","src_mid":"5"}]')
})

// The stock WATCHDOG (telegram_progress_watchdog.py) gets no hook event: it finds the agent's transcript only through the
// transcript_path the stock submit hook stamps on each pending entry. The stock hook skips on the mod's marker, so the mod
// stamps it itself: prompt.submit has no transcript path, the classic UserPromptSubmit input does (runs inside next(e) of
// prompt.submit, ahead of the settings hooks).
const TRANSCRIPT = '/home/u/.claude/projects/x/sess-1.jsonl'
const classicSubmit = ($: any, transcript_path: string | undefined = TRANSCRIPT) =>
  $.classic.UserPromptSubmit(transcript_path === undefined ? { prompt: 'hello' } : { prompt: 'hello', transcript_path })

test('transcript_path: the classic UserPromptSubmit input stamps it on the pending entry the claim wrote (the watchdog finds the transcript through it)', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($)
  await classicSubmit($)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([{ chat_id: '111', src_mid: '5', transcript_path: TRANSCRIPT }])
  expect(files.get(`${PROGRESS}/seen-sess-1-5.marker`)).toBe('')   // the marker is still there: the stock hook still skips
})

test('transcript_path: a topic message keeps its message_thread_id next to the stamped path', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($, `${topicTag(12)}\nhello\n</channel>`)
  await classicSubmit($)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([{ chat_id: '111', src_mid: '5', message_thread_id: 12, transcript_path: TRANSCRIPT }])
})

test('transcript_path: only the entries THIS claim wrote are stamped; a foreign entry and an already stamped one are left alone', async ($: any, on: any) => {
  const foreign = { chat_id: '999', message_id: 7, src_mid: '3' }
  const stamped = { chat_id: '111', src_mid: '5', transcript_path: '/other.jsonl' }
  const { files } = engine(on, { files: { [`${PROGRESS}/sess-1.json`]: JSON.stringify([foreign, stamped]) } })
  await start($)
  await submit($)          // the same message is already recorded: no second entry
  await classicSubmit($)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([foreign, stamped])
})

test('transcript_path: a prompt that is not a Telegram delivery stamps nothing, and writes no pending file', async ($: any, on: any) => {
  const { files, order } = engine(on)
  await start($)
  await submit($, `${tag()}\nx`, { kind: 'channel', server: 'plugin:slack:slack' })
  await classicSubmit($)
  await $.prompt.submit({ text: 'typed by the person', origin: { kind: 'user' } })
  await classicSubmit($)
  expect(files.has(`${PROGRESS}/sess-1.json`)).toBe(false)
  expect(order.filter(x => x.startsWith('write:') || x.startsWith('mv:'))).toEqual([])
})

test('transcript_path: one claim is stamped once -- a later classic event of another prompt rewrites nothing', async ($: any, on: any) => {
  const { files, order } = engine(on)
  await start($)
  await submit($)
  await classicSubmit($)
  const writes = order.filter(x => x === 'mv:progress/sess-1.json').length
  await classicSubmit($, '/changed.jsonl')
  expect(order.filter(x => x === 'mv:progress/sess-1.json').length).toBe(writes)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)[0].transcript_path).toBe(TRANSCRIPT)
})

test('transcript_path: no local transcript (empty path) -> the entry stays as the claim wrote it', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($)
  await classicSubmit($, '')
  expect(files.get(`${PROGRESS}/sess-1.json`)).toBe('[{"chat_id":"111","src_mid":"5"}]')
})

test('transcript_path: a failing stamp write blocks nothing and leaves the claimed entry intact (the Known limit then applies)', async ($: any, on: any) => {
  let armed = false
  const { files } = engine(on, { failWrite: p => armed && p.includes('/progress/sess-1.json') })
  await start($)
  await submit($)
  armed = true
  await classicSubmit($)
  expect(files.get(`${PROGRESS}/sess-1.json`)).toBe('[{"chat_id":"111","src_mid":"5"}]')
  expect(files.get(`${PROGRESS}/seen-sess-1-5.marker`)).toBe('')
})

test('transcript_path: two deliveries before the classic event are both stamped by it (the path is the session\'s)', async ($: any, on: any) => {
  const { files } = engine(on)
  await start($)
  await submit($, `${tag('111', 5)}\na\n</channel>`)
  await submit($, `${tag('111', 6)}\nb\n</channel>`)
  await classicSubmit($)
  expect(JSON.parse(files.get(`${PROGRESS}/sess-1.json`)!)).toEqual([
    { chat_id: '111', src_mid: '5', transcript_path: TRANSCRIPT },
    { chat_id: '111', src_mid: '6', transcript_path: TRANSCRIPT },
  ])
})

test('targetsOf: message_thread_id per tag, only when present', async () => {
  expect(targetsOf(`${topicTag(77)}\nx\n</channel>`)).toEqual([{ chat_id: '111', message_id: 5, message_thread_id: 77 }])
  const plain = targetsOf(`${tag()}\nx\n</channel>`)
  expect(plain).toEqual([{ chat_id: '111', message_id: 5 }])
  expect('message_thread_id' in plain[0]!).toBe(false)
})

test('the pending write fails -> no dedup marker either (the stock hook posts its placeholder and records its own pending entry)', async ($: any, on: any) => {
  const { files, order } = engine(on, { failWrite: p => p.includes('/progress/sess-1.json') })
  await start($)
  await submit($)
  expect(order.filter(x => x.includes('.marker'))).toEqual([])
  expect(files.has(`${PROGRESS}/seen-sess-1-5.marker`)).toBe(false)
  expect(order).toContain('engine:prompt.submit')   // the prompt still enters
})

test('the rename of the pending file fails -> no dedup marker', async ($: any, on: any) => {
  const { files } = engine(on, { mvFails: true })
  await start($)
  await submit($)
  expect(files.has(`${PROGRESS}/seen-sess-1-5.marker`)).toBe(false)
  expect(files.has(`${PROGRESS}/sess-1.json`)).toBe(false)
  // The tmp file is removed again, nothing is left in progress/
  expect([...files.keys()].filter(k => k.startsWith(`${PROGRESS}/`))).toEqual([])
})

test('no claim with the switch at 0, and none for another origin', async ($: any, on: any) => {
  const off = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION: '0' } })
  await start($)
  await submit($)
  await submit($, `${tag()}\nx`, { kind: 'channel', server: 'plugin:slack:slack' })
  expect(off.order.filter(x => x.startsWith('write:progress/'))).toEqual([])
})

test('a failed claim write never blocks: the prompt goes on and the reaction is still staged', async ($: any, on: any) => {
  const { calls, order } = engine(on, { writeFails: true })
  await start($)
  const text = `${tag()}\nhello\n</channel>`
  expect(await submit($, text)).toEqual({ text })
  await settle()
  expect(order).toContain('engine:prompt.submit')
  expect(calls.some(c => /setMessageReaction/.test(c.url))).toBe(true)
})

// The INVARIANT, as a seeded property: random delays (about a third of the calls time out and land late),
// random failures (500, not landed), several messages in one delivery and a second chat, an agent reacting on some of
// them (its react slow or failing too), and a failed clear a previous session left in the retry queue. Once the chain
// is drained and every request has answered -- plus the retry passes of the next turn ends -- every message shows
// exactly its desired reaction: the agent's last successful emoji where it reacted, none everywhere else.
const STEPS_ = ['received', 'working', 'writing']
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The same property with KEEP_AGENT=0 (the 0.3.0 default) on a subset of seeds -- the oracle: every
// message a finished main turn touched ends with no reaction; the earlier session's agent emoji is not restored; a
// message the mod never tracked ends with no reaction either (a react judged FAILED that still landed is
// cleared too; with KEEP_AGENT=1 the 0.2.x rule below holds)
const B1_SEEDS: [number, boolean][] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597].map(x => [x, true] as [number, boolean])
  .concat([2, 5, 13, 34, 89, 233].map(x => [x, false] as [number, boolean]))
for (const [seed, keep] of B1_SEEDS) {
  test(`desired-state property (seed ${seed}${keep ? '' : ', KEEP_AGENT=0'}): after the drain every message shows its desired reaction`, { timeoutMs: 120_000 }, async ($: any, on: any) => {
    const R = rng(seed)
    // A random emoji setting from its OWN generator (the scenario draws stay those of the seed):
    // steps skipped or changed, two steps sharing an emoji; never all three empty (that is "off", tested apart)
    const C = rng(seed * 7919 + 1)
    const pool = ['👀', '🤔', '✍️', '🔥', '👍', '']
    let cfg = ''
    do cfg = STEPS_.map(st => `${st}=${pool[Math.floor(C() * pool.length)]}`).join(',')
    while (/^received=,working=,writing=$/.test(cfg))
    // The oracle also generates 1-8 messages, several turns with re-deliveries after the turn-end prune, an
    // earlier session's queue (a live message among them, and one carrying the agent's emoji) and a react on a message the
    // mod never tracked. The desired value comes ONLY from the scenario: the agent's last successful react, else none.
    const n = 1 + Math.floor(R() * 8)
    const msgs = Array.from({ length: n }, (_, i) => ({ chat: R() < 0.7 ? '111' : '333', mid: 10 + i }))
    const elo = msgs[Math.floor(R() * n)]!
    const queue: any[] = [{ chat_id: '222', message_id: 7, tries: 0, first: Date.now() },
      { chat_id: '222', message_id: 9, tries: 0, first: Date.now(), emoji: '👍' }]
    if (R() < 0.5) queue.push({ chat_id: elo.chat, message_id: elo.mid, tries: 0, first: Date.now(), emoji: null })
    const { tg, out, store, landedReacts } = engine(on, {
      env: { ...FAST, MARVEEN_TELEGRAM_REACTION_EMOJIS: cfg, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: keep ? '1' : '0' },
      store: { [`retries@${STATE_DIR}`]: queue },
      sim: { fetchMs: () => Math.floor(R() * 160), answerMs: () => Math.floor(R() * 120), failed: () => R() < 0.08, landedFail: () => R() < 0.08,
             reactMs: () => Math.floor(R() * 120), reactOk: () => R() > 0.2, reactLandedFail: () => R() < 0.5 },
    })
    tg.set('222:7', '🤔')     // a previous session's leftover, to be cleared
    tg.set('222:9', '❤')      // the agent's earlier emoji was 👍 there (queued), to be restored
    tg.set('444:1', '')       // never tracked by the mod
    const want = new Map<string, string>([['222:7', ''], ['222:9', keep ? '👍' : ''], ['444:1', '']])
    let ok444 = false
    let last444ok = ''
    for (const m of msgs) want.set(`${m.chat}:${m.mid}`, '')
    const keys = [...msgs.map(m => ({ chat: m.chat, mid: m.mid })), { chat: '222', mid: 9 }, { chat: '444', mid: 1 }]
    await start($)
    const turns = 1 + Math.floor(R() * 3)
    for (let t = 0; t < turns; t++) {
      const sub = t === 0 ? msgs : msgs.filter(() => R() < 0.6)              // later turns: re-deliveries
      if (sub.length) await submit($, sub.map(m => `${tag(m.chat, m.mid)}\nhi\n</channel>`).join('\n'))
      await turn($, `t${t}`)
      const steps = 2 + Math.floor(R() * 4)
      for (let i = 0; i < steps; i++) {
        const pick = R()
        if (pick < 0.1 && sub.length) await submit($, `${tag(sub[0]!.chat, sub[0]!.mid)}\nagain\n</channel>`)   // a re-delivery
        else if (pick < 0.3) await tool($, 'Bash', { command: 'ls' }, `u${t}-${i}`)
        else if (pick < 0.55) await reply($, R() < 0.5 ? '111' : '333', `r${t}-${i}`)
        else {
          const m = keys[Math.floor(R() * keys.length)]!
          const emoji = ['👍', '🔥', '❤'][Math.floor(R() * 3)]!
          const r: any = await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: m.chat, message_id: m.mid, emoji }, `x${t}-${i}`)
          if (!r?.result?.isError) {
            want.set(`${m.chat}:${m.mid}`, keep ? emoji : '')
            if (m.chat === '444') { ok444 = true; last444ok = emoji }
          }
        }
        if (R() < 0.5) await sleep(Math.floor(R() * 60))
      }
      await done($, { turnId: `t${t}` })
      await quiet(out)
    }
    // 444:1 was never delivered (the mod never tracked it): what the agent's reacts left there is decided by KEEP_AGENT
    const l444 = landedReacts.filter(x => x.key === '444:1')
    // KEEP_AGENT=0: no emoji stays at the turn end, WITHOUT exception -- a react judged failed that still
    // landed on an untracked message included. KEEP_AGENT=1: once a react succeeded the message is the agent's -> its
    // last SUCCESSFUL emoji (a later failed-but-landed one is overwritten); never a success -> whatever landed last stays
    want.set('444:1', !keep ? '' : ok444 ? last444ok : l444.length ? l444[l444.length - 1]!.emoji : '')
    const queued = () => new Set(((store.get(`retries@${STATE_DIR}`) as any[]) ?? []).map(r => `${r.chat_id}:${r.message_id}`))
    for (const [k, v] of want) if (!queued().has(k)) expect([k, tg.get(k) ?? '']).toEqual([k, v])
    for (let i = 0; i < 25 && queued().size; i++) {   // the next turn ends repeat what is left
      await done($, { turnId: `z${i}` })
      await quiet(out)
    }
    expect(queued().size).toBe(0)
    for (const [k, v] of want) expect([k, tg.get(k) ?? '']).toEqual([k, v])
  })
}

// ── the emoji of each step can be changed or the step skipped ──
const withEmojis = (v: string) => ({ env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_EMOJIS: v } })
const fullTurn = async ($: any) => {
  await start($); await submit($); await settle()
  await turn($); await settle()
  await tool($); await settle()
  await reply($); await settle()
  await done($); await settle()
}

test('emojisFrom: defaults, per-step change, skip, and loud fallback for a bad item', () => {
  for (const v of [undefined, null, '', '   ', 7]) {
    expect(emojisFrom(v)).toEqual({ emojis: { ...DEFAULT_EMOJIS }, warnings: [] })
  }
  expect(emojisFrom('received=🔥, working=👍 ,writing=🎉').emojis).toEqual({ received: '🔥', working: '👍', writing: '🎉', after: '👨‍💻' })
  expect(emojisFrom('working=🔥')).toEqual({ emojis: { received: '👀', working: '🔥', writing: '✍️', after: '👨‍💻' }, warnings: [] })
  expect(emojisFrom('working=,').emojis).toEqual({ received: '👀', working: '', writing: '✍️', after: '👨‍💻' })
  // an emoji Telegram does not take: that step keeps its default, with a warning naming it
  const bad = emojisFrom('writing=🦖,received=🔥')
  expect(bad.emojis).toEqual({ received: '🔥', working: '🤔', writing: '✍️', after: '👨‍💻' })
  expect(bad.warnings.length).toBe(1)
  expect(bad.warnings[0]).toContain('writing=🦖')
  // unknown step, malformed item: ignored with a warning, the rest applies
  const odd = emojisFrom('foo=🔥,nonsense,=👍,working=🎉')
  expect(odd.emojis).toEqual({ received: '👀', working: '🎉', writing: '✍️', after: '👨‍💻' })
  expect(odd.warnings.length).toBe(3)
  // the variation selector does not matter; a non-default is sent in the Bot API list's form, a default keeps its own
  expect(emojisFrom('writing=✍').emojis.writing).toBe('✍️')
  expect(emojisFrom('received=❤\uFE0F').emojis.received).toBe('❤')
  // a shell-style quoted value: the outer quotes go
  expect(emojisFrom("'working=🔥'")).toEqual({ emojis: { received: '👀', working: '🔥', writing: '✍️', after: '👨‍💻' }, warnings: [] })
  expect(emojisFrom('"received=,writing=🎉"').emojis).toEqual({ received: '', working: '🤔', writing: '🎉', after: '👨‍💻' })
  // given twice: the last counts, with a warning
  const twice = emojisFrom('working=🔥,working=👍')
  expect(twice.emojis.working).toBe('👍')
  expect(twice.warnings.length).toBe(1)
})

test('MARVEEN_TELEGRAM_REACTION_EMOJIS changes every step of the ladder', async ($: any, on: any) => {
  const { calls, logs } = engine(on, withEmojis('received=🔥,working=👍,writing=🎉'))
  await fullTurn($)
  expect(ladder(calls)).toEqual(['🔥', '👍', '🎉', ''])
  expect(logs).toEqual([])
})

test('a skipped middle step (working=) makes no change there -- 👀 stays until ✍️', async ($: any, on: any) => {
  const { calls } = engine(on, withEmojis('working='))
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', '✍️', ''])
})

test('a skipped first step (received=) sets nothing at the delivery, but still keeps the placeholder off', async ($: any, on: any) => {
  const { calls, files } = engine(on, withEmojis('received='))
  await start($); await submit($); await settle()
  expect(ladder(calls)).toEqual([])
  expect(files.has(`${STATE_DIR}/progress/seen-sess-1-5.marker`)).toBe(true)
  await turn($); await settle()
  await reply($); await settle()
  await done($); await settle()
  expect(ladder(calls)).toEqual(['🤔', '✍️', ''])
})

test('two steps may share an emoji (working=👀): the rank is the step\'s, the chain stays right', async ($: any, on: any) => {
  const { calls } = engine(on, withEmojis('working=👀'))
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', '✍️', ''])
})

test('an emoji Telegram rejects is a loud warning in the transcript, and that step keeps its default', async ($: any, on: any) => {
  const { calls, logs } = engine(on, withEmojis('writing=🦖'))
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', ''])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('MARVEEN_TELEGRAM_REACTION_EMOJIS')
  expect(logs[0]).toContain('writing=🦖')
})

test('all three steps empty = off -- no reaction, no claim, but the leftover cleanup still runs', async ($: any, on: any) => {
  const { calls, files } = engine(on, {
    env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'received=,working=,writing=' },
    store: { [`pending@${STATE_DIR}`]: [{ chat_id: '111', message_id: 4, stage: '🤔' }] },
  })
  await start($); await settle()
  expect(calls.map(c => [c.body.message_id, ladder([c])[0]])).toEqual([[4, '']])   // the crashed session's reaction cleared
  await submit($); await turn($); await reply($); await done($); await settle()
  expect(calls.length).toBe(1)                                                     // nothing new
  expect([...files.keys()].some(k => k.includes('/progress/'))).toBe(false)        // no claim: the stock placeholder stays
})

test('with skipped steps the agent takes over a message that has no record yet -- out of pending AND the store (a crash must not clear its emoji later)', async ($: any, on: any) => {
  const { store, calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'received=,working=', MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' } })
  await start($)
  await submit($, `${tag('111', 5)}\nhi\n</channel>\n${tag('333', 6)}\nhi\n</channel>`)
  await turn($)
  await reply($, '333')   // the other chat's ✍️ goes out -> the store now holds BOTH pending messages
  await settle()
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '111', message_id: 5, stage: 'working' }, { chat_id: '333', message_id: 6, stage: 'writing' }])
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' }, 'x1')
  await settle()
  // a restart now would not queue a clear of the agent's 👍
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '333', message_id: 6, stage: 'writing' }])
  await reply($, '111'); await done($); await settle()
  expect(calls.filter(c => c.body.message_id === 5)).toEqual([])   // nothing of ours on the agent's message
  expect(ladder(calls.filter(c => c.body.message_id === 6))).toEqual(['✍️', ''])
})

// ── the agent's own emoji is cleared at the turn end by default ──
const REACT = 'mcp__plugin_telegram_telegram__react'
const DEF = { env: { TELEGRAM_STATE_DIR: STATE_DIR } }   // no KEEP_AGENT: the 0.3.0 default

test('default: the agent\'s own emoji on the delivered message is cleared at the turn end too', async ($: any, on: any) => {
  const { calls } = engine(on, DEF)
  await start($); await submit($); await turn($); await reply($); await settle()
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1'); await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', '❤'])   // the agent's emoji is the desired one during the turn
  await done($); await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', '❤', ''])
})

test('default: an emoji the agent put on a message the mod never tracked is cleared at the turn end', async ($: any, on: any) => {
  const { calls } = engine(on, DEF)
  await start($); await submit($); await turn($)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '👍' }, 'x1')
  await reply($); await done($); await settle()
  expect(ladder(calls.filter(c => c.body.message_id === 9))).toEqual([''])
})

test('default: the cleared message stays the agent\'s -- a re-delivery in a later turn gets no stage of ours', async ($: any, on: any) => {
  const { calls } = engine(on, DEF)
  await start($); await submit($); await turn($)
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1')
  await done($); await settle()
  const n = calls.length
  await submit($); await turn($, 't2'); await reply($); await done($, { turnId: 't2' }); await settle()
  expect(calls.slice(n).filter(c => c.body.message_id === 5)).toEqual([])
})

test('KEEP_AGENT=1 keeps the agent\'s own emoji (the 0.2.x behaviour)', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' } })
  await start($); await submit($); await turn($); await reply($); await settle()
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1')
  await done($); await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', '❤'])
})

test('default: a subagent\'s turn end does not clear the agent\'s emoji -- the main turn end does', async ($: any, on: any) => {
  const { calls } = engine(on, DEF)
  await start($); await submit($); await turn($)
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1')
  await done($, { agentId: 'sub-1' }); await settle()
  expect(ladder(calls).slice(-1)).toEqual(['❤'])
  await done($); await settle()
  expect(ladder(calls).slice(-1)).toEqual([''])
})

test('diagnostic: a react judged FAILED is named in the transcript (key names only, no content)', async ($: any, on: any) => {
  const { logs } = engine(on, { ...DEF, reactResult: { result: { isError: true, content: [{ type: 'text', text: 'SECRET-CONTENT' }] } } })
  await start($); await submit($); await turn($)
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '🦖' }, 'x1'); await settle()
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('judged FAILED')
  expect(logs[0]).toContain('result keys: result')
  expect(logs[0]).not.toContain('SECRET-CONTENT')
})

test('default: an earlier session\'s queued agent emoji is NOT restored -- it is cleared at the start', async ($: any, on: any) => {
  const { calls } = engine(on, { ...DEF, store: { [`retries@${STATE_DIR}`]: [{ chat_id: '222', message_id: 9, tries: 0, first: Date.now(), emoji: '👍' }] } })
  await start($); await settle()
  expect(calls.map(c => [c.body.message_id, ladder([c])[0]])).toEqual([[9, '']])
  // and it is still the agent's: a delivery of it gets no stage of ours
  await submit($, `${tag('222', 9)}\nhi\n</channel>`); await settle()
  expect(calls.length).toBe(1)
})

test('KEEP_AGENT=1: the queued agent emoji IS restored (the 0.2.x behaviour)', async ($: any, on: any) => {
  const { calls } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' },
    store: { [`retries@${STATE_DIR}`]: [{ chat_id: '222', message_id: 9, tries: 0, first: Date.now(), emoji: '👍' }] } })
  await start($); await settle()
  expect(calls.map(c => [c.body.message_id, ladder([c])[0]])).toEqual([[9, '👍']])
})

test('default: a session that dies after the agent\'s react leaves it queued with NO emoji -- the next start clears it', async ($: any, on: any) => {
  const { store } = engine(on, DEF)
  await start($); await submit($); await turn($); await settle()
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1')
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '👍' }, 'x2'); await settle()
  const q = (store.get(`retries@${STATE_DIR}`) as any[]).map(r => [r.message_id, r.emoji ?? null, r.agent])
  expect(q).toEqual([[5, null, true], [9, null, true]])
})

test('keyNames: schema-like names only, at most 8, never a value', () => {
  expect(keyNames({ result: { content: 'SECRET' }, deny: undefined })).toBe('result,deny')
  expect(keyNames({ 'a secret sentence': 1, ok: 2 })).toBe('?,ok')
  expect(keyNames(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])))).toBe('k0,k1,k2,k3,k4,k5,k6,k7,…')
  expect(keyNames(null)).toBe('object')
  expect(keyNames('x')).toBe('string')
})

test('default: an agent react queued WHILE a retry pass runs stays queued (a crash before the turn end still clears it)', async ($: any, on: any) => {
  const { store } = engine(on, { ...DEF, slow: { n: 1, ms: 50 },
    store: { [`retries@${STATE_DIR}`]: [{ chat_id: '222', message_id: 7, tries: 0, first: Date.now(), emoji: null }] } })
  await start($)                     // the start pass is now waiting on the slow first call
  await submit($); await turn($)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '👍' }, 'x1')
  await new Promise(r => setTimeout(r, 120)); await settle()
  const q = ((store.get(`retries@${STATE_DIR}`) as any[]) ?? []).map(r => [r.message_id, r.emoji ?? null, r.agent])
  expect(q).toContainEqual([9, null, true])
})

test('default: an owed agent react ALREADY queued when a later pass starts (a second session.start) stays queued', async ($: any, on: any) => {
  // since the incoming list the test above holds without the settled-but-owed keep; here the entry is in the queue
  // BEFORE the pass, so only that keep holds it (a crash before the turn end must still clear the emoji)
  const { store, out } = engine(on, { env: { ...FAST, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '0' } })
  await start($); await submit($); await quiet(out)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '👍' }, 'x1'); await quiet(out)
  await start($); await quiet(out)                         // e.g. /clear: a new session in the same process, a new pass
  const q = ((store.get(`retries@${STATE_DIR}`) as any[]) ?? []).map(r => [r.message_id, r.emoji ?? null, r.agent])
  expect(q).toContainEqual([9, null, true])
})

// ── retry-pass and untracked-message edge cases ──
test('KEEP_AGENT=0 -- a react judged FAILED that still LANDED on a message the mod never tracked is cleared at the turn end', async ($: any, on: any) => {
  const { tg, out, logs } = engine(on, { env: { ...FAST, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '0' },
    sim: { fetchMs: () => 0, reactOk: () => false, reactLandedFail: () => true } })
  await start($); await submit($); await quiet(out)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '❤' }, 'x1'); await quiet(out)
  expect(tg.get('111:9')).toBe('❤')                         // landed although judged failed
  await done($); await quiet(out)
  expect(tg.get('111:9')).toBe('')
  expect(logs.some(l => l.includes('untracked -- cleared at the turn end'))).toBe(true)
})

test('with KEEP_AGENT=1 the same landed emoji on an untracked message stays (the 0.2.x rule)', async ($: any, on: any) => {
  const { tg, out } = engine(on, { env: FAST, sim: { fetchMs: () => 0, reactOk: () => false, reactLandedFail: () => true } })
  await start($); await submit($); await quiet(out)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '❤' }, 'x1'); await quiet(out)
  await done($); await quiet(out)
  expect(tg.get('111:9')).toBe('❤')
})

test('KEEP_AGENT=0 -- the untracked, failed-but-landed react is queued as the agent\'s BEFORE the turn end (a crash still clears it)', async ($: any, on: any) => {
  const { store, out } = engine(on, { env: { ...FAST, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '0' },
    sim: { fetchMs: () => 0, reactOk: () => false, reactLandedFail: () => true } })
  await start($); await submit($); await quiet(out)
  await tool($, REACT, { chat_id: '111', message_id: 9, emoji: '❤' }, 'x1'); await quiet(out)
  const q = ((store.get(`retries@${STATE_DIR}`) as any[]) ?? []).map(r => [r.message_id, r.emoji ?? null, r.agent])
  expect(q).toContainEqual([9, null, true])
})

test('KEEP_AGENT=0 -- a failed-but-landed react on a RUNNING message with no record yet keeps it ours: the ladder goes on, the turn end clears', async ($: any, on: any) => {
  // received is skipped, so the pending message has no record when the agent reacts on it before turn.start
  const { tg, out } = engine(on, { env: { ...FAST, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '0', MARVEEN_TELEGRAM_REACTION_EMOJIS: 'received=' },
    sim: { fetchMs: () => 0, reactOk: () => false, reactLandedFail: () => true } })
  await start($); await submit($); await quiet(out)
  expect(tg.get('111:5') ?? '').toBe('')                    // the skipped first step wrote nothing
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1'); await quiet(out)
  expect(tg.get('111:5')).toBe('❤')                         // landed although judged failed
  await turn($); await quiet(out)
  expect(tg.get('111:5')).toBe('🤔')                         // still ours: the ladder goes on
  await done($); await quiet(out)
  expect(tg.get('111:5')).toBe('')
})

test('user text in a warning is cut (a 5000-emoji item does not write itself into the transcript)', async () => {
  const long = '🤔'.repeat(5000)
  for (const v of [`received=${long}`, `${long}=👀`, `${long}`]) {
    const { warnings } = emojisFrom(v)
    expect(warnings.length).toBe(1)
    expect([...warnings[0]!].length < 200).toBe(true)        // code points (an emoji is 2 UTF-16 units)
    expect(warnings[0]!.includes('…')).toBe(true)
  }
  expect(emojisFrom('received=🦖').warnings[0]!.includes('🦖')).toBe(true)   // a short value is named in full
  const many = emojisFrom(Array.from({ length: 5000 }, (_, i) => `x${i}`).join(',')).warnings
  expect(many.length).toBe(9)                                 // 8 lines + one "... and 4992 more"
  expect(many[8]).toBe('... and 4992 more')
})

test('a retryLater for a message the RUNNING retry pass already processed is not lost -- the turn end clears it', async ($: any, on: any) => {
  // the start pass: X (222:7) is cleared first and dropped; while it awaits the SLOW second entry (222:8) the agent
  // reacts on X -- judged failed, but it lands. Before the fix X fell out of the queue and the emoji stayed.
  const { tg, out } = engine(on, {
    env: { ...FAST, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '0' },
    store: { [`retries@${STATE_DIR}`]: [{ chat_id: '222', message_id: 7, tries: 0, first: Date.now(), emoji: null },
                                        { chat_id: '222', message_id: 8, tries: 0, first: Date.now(), emoji: null }] },
    sim: { fetchMs: (n: number) => (n === 2 ? 80 : 0), reactOk: () => false, reactLandedFail: () => true },
  })
  tg.set('222:7', '🤔'); tg.set('222:8', '🤔')
  await start($)
  await sleep(20)                                           // the pass is now awaiting the slow 2nd call
  expect(tg.get('222:7')).toBe('')                          // X was cleared and dropped by this pass
  await tool($, REACT, { chat_id: '222', message_id: 7, emoji: '❤' }, 'x1')
  expect(tg.get('222:8')).toBe('🤔')                        // the pass was STILL running at the react
  await quiet(out)
  expect(tg.get('222:7')).toBe('❤')
  await done($); await quiet(out)
  expect(tg.get('222:7')).toBe('')
})

test('a KEEP_AGENT value other than 0/1 is named (no value in the line), and the default applies', async ($: any, on: any) => {
  const { calls, logs } = engine(on, { env: { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: 'yes-please' } })
  await start($); await submit($); await turn($); await reply($); await settle()
  await tool($, REACT, { chat_id: '111', message_id: 5, emoji: '❤' }, 'x1')
  await done($); await settle()
  expect(logs.some(l => l.includes('MARVEEN_TELEGRAM_REACTION_KEEP_AGENT is neither 0 nor 1'))).toBe(true)
  expect(logs.some(l => l.includes('yes-please'))).toBe(false)
  expect(ladder(calls).slice(-1)).toEqual([''])             // cleared: the default
})

test('emojisFrom corner cases -- ZWJ, skin tone, JSON shape, a very long item, a blank value', () => {
  expect(emojisFrom('writing=❤‍🔥').emojis.writing).toBe('❤‍🔥')                       // a ZWJ sequence on the list
  expect(emojisFrom('writing=❤️‍🔥').emojis.writing).toBe('❤‍🔥')                      // ... with FE0F: the list's form
  expect(emojisFrom('working=👨‍💻').emojis.working).toBe('👨‍💻')
  const skin = emojisFrom('working=👍🏻')                                              // a skin tone is not on the list
  expect(skin.emojis.working).toBe('🤔'); expect(skin.warnings.length).toBe(1)
  const json = emojisFrom('{"received":"👀","working":"🔥"}')                          // JSON is not the format
  expect(json.emojis).toEqual({ ...DEFAULT_EMOJIS }); expect(json.warnings.length).toBeGreaterThan(0)
  const long = emojisFrom('working=' + '🔥'.repeat(5000))                              // long: rejected, no crash
  expect(long.emojis.working).toBe('🤔'); expect(long.warnings.length).toBe(1)
  expect(emojisFrom('working=   ').emojis.working).toBe('')                          // blank = skipped
  expect(emojisFrom('writing=👀').emojis.writing).toBe('👀')                           // another step's default: fine
})

// ── 0.3.3: the 4th step -- 👨‍💻 once the reply is OUT, cleared at the turn end ──
// Every test above runs with the `after` step OFF (the engine forces `after=`), i.e. the whole 0.3.2 suite is the proof that an
// empty `after` leaves the behaviour as it was. The tests below switch the step on (`after: true`) and set the config themselves.
const AFTER_ENV = { TELEGRAM_STATE_DIR: STATE_DIR, MARVEEN_TELEGRAM_REACTION_KEEP_AGENT: '1' }
const AFTER = '👨‍💻'

test('emojisFrom: `after` defaults to 👨‍💻, can be changed or emptied, a bad value falls back loudly', () => {
  expect(DEFAULT_EMOJIS.after).toBe(AFTER)
  expect(emojisFrom(undefined).emojis.after).toBe(AFTER)
  expect(emojisFrom('after=🔥').emojis.after).toBe('🔥')
  expect(emojisFrom('after=').emojis.after).toBe('')
  expect(emojisFrom('after=').warnings).toEqual([])
  const bad = emojisFrom('after=🦖')
  expect(bad.emojis.after).toBe(AFTER)
  expect(bad.warnings.length).toBe(1)
  expect(bad.warnings[0]).toContain('after=🦖')
  // the unknown-step warning names the new step
  expect(emojisFrom('later=🔥').warnings[0]).toContain('after')
})

test('after step: the full ladder with the new step: 👀 -> 🤔 -> ✍️ -> (reply out) 👨‍💻 -> cleared at the turn end', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: AFTER_ENV })
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await tool($)
  await settle()
  await reply($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', AFTER])   // the turn is still running: no clear yet
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', AFTER, ''])
  expect(calls.every(c => c.body.chat_id === '111' && c.body.message_id === 5)).toBe(true)
})

test('after step: a FAILED reply never reaches 👨‍💻 -- the message stays at ✍️ to the turn end', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: AFTER_ENV, replyResult: { result: { isError: true } } })
  await start($)
  await submit($)
  await settle()
  await turn($)
  await settle()
  await reply($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️'])
  await done($)
  await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', ''])
})

test('after step: a turn that answers in several messages keeps 👨‍💻 to the end -- the second reply does not step it back to ✍️', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: AFTER_ENV })
  await start($); await submit($); await settle()
  await turn($); await settle()
  await reply($, '111', 'r1'); await settle()
  await tool($); await settle()
  await reply($, '111', 'r2'); await settle()
  await tool($); await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', AFTER])
  await done($); await settle()
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', AFTER, ''])
})

test('after step: a reply moves only its own chat to 👨‍💻', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: AFTER_ENV })
  await start($)
  await submit($, `${tag('111', 5)}\nhello\n</channel>\n${tag('222', 6)}\nhi\n</channel>`)
  await settle()
  await reply($, '222'); await settle()
  expect(calls.filter(c => c.body.reaction[0]?.emoji === AFTER).map(c => c.body.chat_id)).toEqual(['222'])
  await done($); await settle()
  // both are cleared at the turn end
  expect(calls.filter(c => c.body.reaction.length === 0).map(c => c.body.chat_id).sort()).toEqual(['111', '222'])
})

test('after step: `after=` (empty) is the 0.3.2 behaviour to the call -- exactly these Bot API calls, nothing else', async ($: any, on: any) => {
  const { calls, logs } = engine(on, { after: true, env: { ...AFTER_ENV, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'after=' } })
  await fullTurn($)
  const body = (emoji: string) => ({ chat_id: '111', message_id: 5, reaction: emoji ? [{ type: 'emoji', emoji }] : [] })
  expect(calls.map(c => c.body)).toEqual([body('👀'), body('🤔'), body('✍️'), body('')])
  expect(calls.every(c => c.url === `https://api.telegram.org/bot${TOKEN}/setMessageReaction`)).toBe(true)
  expect(logs).toEqual([])
})

test('after step: a custom `after` emoji is used (after=🔥)', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: { ...AFTER_ENV, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'after=🔥' } })
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', '🔥', ''])
})

test('after step: a bad `after` value is a loud warning and the default 👨‍💻 applies', async ($: any, on: any) => {
  const { calls, logs } = engine(on, { after: true, env: { ...AFTER_ENV, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'after=🦖' } })
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', '🤔', '✍️', AFTER, ''])
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('after=🦖')
})

test('after step: the three original steps empty still turn the mod off -- `after` alone does not keep it on', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: { ...AFTER_ENV, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'received=,working=,writing=' } })
  await fullTurn($)
  expect(ladder(calls)).toEqual([])
})

test('after step: after 👨‍💻 the agent\'s own reaction still takes the message over (KEEP_AGENT): its emoji is the last word, no clear of ours', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: AFTER_ENV })
  await start($); await submit($); await settle()
  await reply($); await settle()
  await tool($, 'mcp__plugin_telegram_telegram__react', { chat_id: '111', message_id: 5, emoji: '👍' })
  await done($); await settle()
  expect(ladder(calls)).toEqual(['👀', '✍️', AFTER, '👍'])
})

test('after step: a skipped `writing` step does not block `after` -- 👀 stays until the reply is out, then 👨‍💻', async ($: any, on: any) => {
  const { calls } = engine(on, { after: true, env: { ...AFTER_ENV, MARVEEN_TELEGRAM_REACTION_EMOJIS: 'working=,writing=' } })
  await fullTurn($)
  expect(ladder(calls)).toEqual(['👀', AFTER, ''])
})

test('after step: the store keeps the `after` step too, so a session that dies after the reply leaves a clearable entry', async ($: any, on: any) => {
  const { store } = engine(on, { after: true, env: AFTER_ENV })
  await start($); await submit($); await settle()
  await reply($); await settle()
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([{ chat_id: '111', message_id: 5, stage: 'after' }])
  await done($); await settle()
  expect(store.get(`pending@${STATE_DIR}`)).toEqual([])
})
