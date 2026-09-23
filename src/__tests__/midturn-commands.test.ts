// src/web/midturn-commands.ts (CMDHOOKMIDROUND, ELSOKOR922 Phase 7): the
// dashboard answers an owner command that arrived while the main session was
// mid-turn. The fixture lines are the exact shapes measured in the test
// instance's transcript on 2026-09-23 (09:19-09:20, four commands during a
// memoria-heartbeat turn). The tail runs on a real file, appended the way
// Claude Code appends, so offset/partial-line/rotation bugs show up here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseQueuedChannelCommand, midTurnTick, newTailState, type MidTurnDeps, type TailState,
} from '../web/midturn-commands.js'
import type { DispatchResult } from '../web/routes/commands.js'

const OWNER = '8659214323'

function channelPrompt(body: string, attrs = `source="plugin:telegram:telegram" chat_id="${OWNER}" message_id="373" user="${OWNER}" user_id="${OWNER}" ts="2026-09-23T07:20:11.000Z"`): string {
  return `<channel ${attrs}>\n${body}\n</channel>`
}

function queuedLine(prompt: string, originKind = 'channel'): string {
  return JSON.stringify({
    parentUuid: '335db95d-9ce0-4910-80a1-529ec3a65b16',
    isSidechain: false,
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: originKind, server: 'plugin:telegram:telegram' }, isMeta: true },
    type: 'attachment',
    timestamp: '2026-09-23T07:20:29.310Z',
  })
}

function enqueueLine(prompt: string): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-23T07:20:11.864Z', sessionId: 's', content: prompt })
}

describe('parseQueuedChannelCommand', () => {
  it('the measured queued_command line -> the command', () => {
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/board')))).toEqual({ chatId: OWNER, messageId: '373', text: '/board', forwarded: false })
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/board', `source="plugin:telegram:telegram" chat_id="${OWNER}" message_id="5" forwarded="1"`)))?.forwarded).toBe(true)
  })

  it('a command with arguments keeps them', () => {
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/model opus 30m')))?.text).toBe('/model opus 30m')
  })

  it('the enqueue line is NOT a trigger (an idle session writes it too, and the hook handles that one)', () => {
    expect(parseQueuedChannelCommand(enqueueLine(channelPrompt('/board')))).toBeNull()
  })

  it('rejects: non-channel origin, plain text, two blocks, a multi-line body, a non-telegram source, no chat_id', () => {
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/board'), 'user'))).toBeNull()
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('szia, mi újság?')))).toBeNull()
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/status') + channelPrompt('/board')))).toBeNull()
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/status\nés még valami')))).toBeNull()
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/status', `source="plugin:slack:slack" chat_id="${OWNER}"`)))).toBeNull()
    expect(parseQueuedChannelCommand(queuedLine(channelPrompt('/status', 'source="plugin:telegram:telegram"')))).toBeNull()
  })

  it('a truncated or garbage line is null, never a throw', () => {
    const full = queuedLine(channelPrompt('/board'))
    expect(parseQueuedChannelCommand(full.slice(0, full.length - 10))).toBeNull()
    expect(parseQueuedChannelCommand('{"attachment": "queued_command"')).toBeNull()
    expect(parseQueuedChannelCommand('null')).toBeNull()
  })
})

describe('midTurnTick', () => {
  let dir: string
  let file: string
  let state: TailState
  let sent: Array<{ chatId: string; text: string }>
  let dispatched: string[]
  let dispatchImpl: (text: string) => Promise<DispatchResult>
  let deps: MidTurnDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'midturn-'))
    file = join(dir, 'sess-a.jsonl')
    writeFileSync(file, queuedLine(channelPrompt('/status')) + '\n') // history: must NOT be replayed
    state = newTailState()
    sent = []
    dispatched = []
    dispatchImpl = async (text) => ({ handled: true, outcome: 'ran', replies: [`válasz: ${text}`] })
    deps = {
      transcriptDir: () => dir,
      ownerChatId: () => OWNER,
      dispatch: vi.fn(async (text: string) => { dispatched.push(text); return dispatchImpl(text) }) as unknown as MidTurnDeps['dispatch'],
      send: async (chatId, text) => { sent.push({ chatId, text }) },
      now: () => 1,
      sleep: async () => {},
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('boot: the existing transcript is not replayed; a later mid-turn command is answered once', async () => {
    expect(await midTurnTick(state, deps, true)).toBe(0)
    expect(dispatched).toEqual([])
    appendFileSync(file, enqueueLine(channelPrompt('/board')) + '\n' + queuedLine(channelPrompt('/board')) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
    expect(dispatched).toEqual(['/board'])
    expect(sent).toEqual([{ chatId: OWNER, text: 'válasz: /board' }])
    expect(await midTurnTick(state, deps)).toBe(0)
  })

  it('dispatches as the MAIN session and without deferWrites (a busy write goes to the pending queue)', async () => {
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/gyors')) + '\n')
    await midTurnTick(state, deps)
    expect(deps.dispatch).toHaveBeenCalledWith('/gyors', OWNER, OWNER, 1, true, false, false)
  })

  it('the same message_id twice (a re-written line) runs once', async () => {
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/board')) + '\n' + queuedLine(channelPrompt('/board')) + '\n')
    await midTurnTick(state, deps)
    expect(dispatched).toEqual(['/board'])
  })

  it('a line split across two appends is read once it is complete', async () => {
    await midTurnTick(state, deps, true)
    const line = queuedLine(channelPrompt('/queue'))
    appendFileSync(file, line.slice(0, 50))
    expect(await midTurnTick(state, deps)).toBe(0)
    appendFileSync(file, line.slice(50) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
    expect(dispatched).toEqual(['/queue'])
  })

  it('not ours (handled:false): nothing is sent, the model keeps it', async () => {
    dispatchImpl = async () => ({ handled: false, outcome: 'unknown', replies: [] })
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/kanban')) + '\n')
    expect(await midTurnTick(state, deps)).toBe(0)
    expect(sent).toEqual([])
  })

  it('a garbage line in between does not stop the tail', async () => {
    await midTurnTick(state, deps, true)
    appendFileSync(file, '{not json\n' + queuedLine(channelPrompt('/board')) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
  })

  it('a dispatch that throws is logged; the next command still runs', async () => {
    await midTurnTick(state, deps, true)
    dispatchImpl = async () => { throw new Error('boom') }
    appendFileSync(file, queuedLine(channelPrompt('/board', `source="plugin:telegram:telegram" chat_id="${OWNER}" message_id="1"`)) + '\n')
    expect(await midTurnTick(state, deps)).toBe(0)
    dispatchImpl = async (text) => ({ handled: true, outcome: 'ran', replies: [text] })
    appendFileSync(file, queuedLine(channelPrompt('/status', `source="plugin:telegram:telegram" chat_id="${OWNER}" message_id="2"`)) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
  })

  it('a failed send is logged, not thrown', async () => {
    deps.send = async () => { throw new Error('network') }
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/board')) + '\n')
    await expect(midTurnTick(state, deps)).resolves.toBe(0)
  })

  it('a new session file is read from its start; the old one is left', async () => {
    await midTurnTick(state, deps, true)
    const next = join(dir, 'sess-b.jsonl')
    writeFileSync(next, queuedLine(channelPrompt('/board')) + '\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(next, later, later)
    expect(await midTurnTick(state, deps)).toBe(1)
    expect(dispatched).toEqual(['/board'])
  })

  it('a shrunk (rewritten) transcript restarts at its end, no replay', async () => {
    await midTurnTick(state, deps, true)
    writeFileSync(file, queuedLine(channelPrompt('/x')).slice(0, 20) + '\n')
    expect(await midTurnTick(state, deps)).toBe(0)
    appendFileSync(file, queuedLine(channelPrompt('/board')) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
  })

  it('no transcript directory: nothing happens, no throw', async () => {
    deps.transcriptDir = () => join(dir, 'nincs')
    await expect(midTurnTick(state, deps, true)).resolves.toBe(0)
  })

  it('a transient send failure is retried; the reply still goes out', async () => {
    let fails = 1
    deps.send = async (chatId, text) => {
      if (fails-- > 0) throw new Error('connect ETIMEDOUT')
      sent.push({ chatId, text })
    }
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/runs')) + '\n')
    expect(await midTurnTick(state, deps)).toBe(1)
    expect(sent).toEqual([{ chatId: OWNER, text: 'válasz: /runs' }])
  })

  it('gives up after SEND_ATTEMPTS, logged, no throw', async () => {
    let tries = 0
    deps.send = async () => { tries++; throw new Error('down') }
    await midTurnTick(state, deps, true)
    appendFileSync(file, queuedLine(channelPrompt('/runs')) + '\n')
    await expect(midTurnTick(state, deps)).resolves.toBe(0)
    expect(tries).toBe(3)
  })
})
