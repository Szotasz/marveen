// SLACKDUP1111: Slack redelivered one human message six more times, minutes apart (2026-11-11, 16:00-16:14 CET).
// The Stop hook dropped every seen-<sid>-<ts>.marker at the end of each turn, so each copy read as a new message
// in the next turn: a new "working on it" placeholder, and the Stop hook asked for a new reply to a message the
// agent had already answered. The three real hooks run here (submit, reply-clear, Stop) against a local Slack Web
// API stub, in the order of the measured case.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hooks')
const SID = 'sess-slackdup'
const CHAT = 'C0SLACKDUP1'
const THREAD = '1794375326.617149'
const MSG_TS = '1794409245.376499'
const REPLY_TOOL = 'mcp__plugin_slack-channel_slack__reply'

let server: Server
let base = ''
let calls: { method: string; body: string }[] = []
let state = ''

function runHook(hook: string, input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [join(HOOKS, hook)], {
      env: { ...process.env, SLACK_STATE_DIR: state, SLACK_API_BASE: base, MARVEEN_LANG: 'en' },
      timeout: 20_000,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    child.stdin?.end(JSON.stringify(input))
  })
}

const channelBlock = (ts: string) =>
  `<channel source="plugin:slack-channel:slack" chat_id="${CHAT}" message_id="${ts}" user="owner" ts="${ts}" thread_ts="${THREAD}">hi</channel>`
const submit = (ts: string) => runHook('slack_progress.py', { prompt: channelBlock(ts), session_id: SID, transcript_path: '' })
const reply = () => runHook('slack_progress_reply_clear.py', { session_id: SID, tool_name: REPLY_TOOL, tool_input: { chat_id: CHAT, thread_ts: THREAD, text: 'answer' } })
const stop = () => runHook('slack_progress_clear.py', { session_id: SID, transcript_path: '', stop_hook_active: false })
const posts = () => calls.filter(c => c.method === 'chat.postMessage').length
const pending = (): unknown[] => {
  try { return JSON.parse(readFileSync(join(state, 'progress', `${SID}.json`), 'utf-8')) } catch { return [] }
}
const marker = (ts: string) => join(state, 'progress', `seen-${SID}-${ts}.marker`)

beforeEach(async () => {
  calls = []
  let n = 0
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const method = (req.url || '').split('/').pop() || ''
      calls.push({ method, body })
      n++
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(method === 'chat.postMessage' ? { ok: true, ts: `1794409999.00010${n}` } : { ok: true }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  state = mkdtempSync(join(tmpdir(), 'slackdup-progress-'))
  mkdirSync(join(state, 'progress'), { recursive: true })
  writeFileSync(join(state, '.env'), 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n')
})

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  rmSync(state, { recursive: true, force: true })
})

describe('a redelivered Slack message after an answered turn (SLACKDUP1111)', () => {
  it('gets no new placeholder, and the Stop hook asks for no new reply', async () => {
    // Turn 1: the message arrives, a placeholder goes up, the agent answers, the turn ends.
    await submit(MSG_TS)
    expect(posts()).toBe(1)
    expect(pending()).toHaveLength(1)
    await reply()
    expect(pending()).toHaveLength(0)
    expect(await stop()).toBe('')
    expect(existsSync(marker(MSG_TS)), 'the seen marker outlives the turn').toBe(true)

    // Turn 2: Slack hands the same message over again, minutes later.
    await submit(MSG_TS)
    expect(posts(), 'no second placeholder for the same ts').toBe(1)
    expect(pending()).toHaveLength(0)
    expect(await stop(), 'no block: nothing is owed for an answered message').toBe('')
    expect(readFileSync(join(state, 'progress', 'debug.log'), 'utf-8')).toContain(`dedup skip src=${MSG_TS}`)
  })

  it('a new message in the same thread still gets its placeholder, and is still enforced', async () => {
    await submit(MSG_TS)
    await reply()
    await stop()
    await submit('1794409300.000100')
    expect(posts()).toBe(2)
    expect(pending()).toHaveLength(1)
    const out = await stop()
    expect(JSON.parse(out)).toMatchObject({ decision: 'block' })
  })

  it('a marker older than an hour is removed at Stop, a fresh one is kept', async () => {
    const old = '1794400000.000001'
    writeFileSync(marker(old), '')
    const twoHoursAgo = Date.now() / 1000 - 2 * 3600
    utimesSync(marker(old), twoHoursAgo, twoHoursAgo)
    await submit(MSG_TS)
    await reply()
    await stop()
    const left = readdirSync(join(state, 'progress')).filter(f => f.startsWith('seen-'))
    expect(left).toEqual([`seen-${SID}-${MSG_TS}.marker`])
  })
})
