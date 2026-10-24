import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The REAL reader (plugins/worksource/server.mjs) over stdio, modelled on its
// own verify.mjs. The point: a `from: scheduler` item -- what the schedule
// runner writes -- gets NO other treatment than any routed item. Same verbatim
// content, same router provenance stamp, same meta shape. If the reader ever
// grew a scheduler-specific branch (extra rights, different framing), this is
// the test that would catch it.

type JsonRpc = {
  jsonrpc?: string
  id?: number
  method?: string
  params?: { content?: string; meta?: Record<string, string> } & Record<string, unknown>
  result?: { isError?: boolean } & Record<string, unknown>
}

const serverPath = join(process.cwd(), 'plugins', 'worksource', 'server.mjs')
const root = mkdtempSync(join(tmpdir(), 'worksource-scheduler-'))
mkdirSync(join(root, 'pending'), { recursive: true })

let child: ChildProcessWithoutNullStreams | null = null

afterAll(() => {
  child?.kill()
  rmSync(root, { recursive: true, force: true })
})

describe('the worksource reader treats a scheduler item exactly like any routed item', () => {
  it('delivers both verbatim, stamped router, with the same meta shape', { timeout: 20_000 }, async () => {
    child = spawn('node', [serverPath], {
      env: { ...process.env, WORKSOURCE_AGENT_ID: 'sched-test-agent', WORKSOURCE_DIR: root, WORKSOURCE_POLL_MS: '300' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const inbox: JsonRpc[] = []
    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) { try { inbox.push(JSON.parse(line)) } catch { /* framing noise */ } }
      }
    })
    const send = (msg: unknown): void => { child?.stdin.write(JSON.stringify(msg) + '\n') }
    const waitFor = (pred: (m: JsonRpc) => boolean, what: string, ms = 8_000): Promise<JsonRpc> =>
      new Promise((resolve, reject) => {
        const started = Date.now()
        const tick = setInterval(() => {
          const hit = inbox.find(pred)
          if (hit) { clearInterval(tick); resolve(hit) }
          else if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`timeout waiting for ${what}`)) }
        }, 50)
      })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sched-test', version: '0' } },
    })
    const init = await waitFor((m) => m.id === 1, 'initialize result')
    expect(init.result).toBeDefined()
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    // Item 1: the shape the SCHEDULER writes (scheduledWorksourceMeta).
    const C = 'SCHED-BODY-1'
    writeFileSync(join(root, 'pending', 'sched-a.json'), JSON.stringify({
      content: C,
      meta: { from: 'scheduler', message_id: 'sched-x-1', task: 't', category: 'scheduled-task' },
    }))
    const sched = await waitFor(
      (m) => m.method === 'notifications/claude/channel' && m.params?.meta?.work_id === 'sched-a',
      'scheduler item notification',
    )

    // Acknowledge it exactly as verify.mjs does: tools/call work_complete.
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'work_complete', arguments: { work_id: 'sched-a', result: 'done' } } })
    const ack = await waitFor((m) => m.id === 2, 'work_complete result')
    expect(ack.result?.isError).not.toBe(true)

    // Item 2: a plain PEER-AGENT item, same body, for the comparison.
    writeFileSync(join(root, 'pending', 'peer-b.json'), JSON.stringify({
      content: C,
      meta: { from: 'peer-agent', message_id: 101, task: 't', category: 'scheduled-task' },
    }))
    const peer = await waitFor(
      (m) => m.method === 'notifications/claude/channel' && m.params?.meta?.work_id === 'peer-b',
      'peer item notification',
    )

    // Verbatim, not framed: a framed delivery would carry the untrusted wrap.
    expect(sched.params?.content).toBe(C)
    expect(peer.params?.content).toBe(C)
    // Both recognized as ROUTED (from + message_id present), so no extra
    // trust and no extra suspicion for the scheduler's item.
    expect(sched.params?.meta?.provenance).toBe('router')
    expect(peer.params?.meta?.provenance).toBe('router')
    // Same key set: the reader stamps the same four keys (ts, work_id, agent,
    // provenance) on top of the caller's meta for both.
    expect(Object.keys(sched.params?.meta ?? {}).sort()).toEqual(Object.keys(peer.params?.meta ?? {}).sort())
    // And the values differ ONLY where the two items genuinely differ: the
    // sender, its message id, the queue's own work id, and the timestamp.
    const differing = Object.keys(sched.params?.meta ?? {})
      .filter((k) => sched.params?.meta?.[k] !== peer.params?.meta?.[k])
    expect(differing.every((k) => ['from', 'message_id', 'work_id', 'ts'].includes(k))).toBe(true)
    for (const k of ['from', 'message_id', 'work_id']) {
      expect(differing).toContain(k)
    }
  })
})
