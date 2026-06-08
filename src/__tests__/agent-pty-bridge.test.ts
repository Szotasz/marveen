import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { execSync } from 'node:child_process'
import { issueTicket, consumeTicket } from '../web/pty-ticket.js'
import { attachWsUpgradeHandler } from '../web/agent-pty-bridge.js'

const UID = Date.now()
const TEST_AGENT = `bridge-${UID}`
const TEST_SESSION = `agent-${TEST_AGENT}`
let server: http.Server
let port: number

const sessionNameFn = (name: string) => `agent-${name}`

beforeAll(async () => {
  execSync(`tmux new-session -d -s '${TEST_SESSION}' 'cat'`, { stdio: 'ignore' })
  server = http.createServer((_, res) => { res.writeHead(404); res.end() })
  attachWsUpgradeHandler(server, consumeTicket, sessionNameFn, {
    pingIntervalMs: 200,
    pongTimeoutMs: 300,
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
}, 30000)

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { execSync(`tmux kill-session -t '${TEST_SESSION}'`, { stdio: 'ignore' }) } catch {}
})

function wsCloseCode(path: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.on('close', (code) => resolve(code))
    ws.on('error', () => resolve(-1))
    setTimeout(() => { ws.terminate(); resolve(-2) }, 4000)
  })
}

async function connectWs(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise(r => {
    if (ws.readyState === WebSocket.CLOSED) return r()
    ws.once('close', () => r())
    ws.close()
  })
}

describe('agent-pty-bridge', () => {
  it('invalid/short ticket returns close 4401', async () => {
    const code = await wsCloseCode('/ws/agent-pty?ticket=badticket')
    expect(code).toBe(4401)
  })

  it('valid ticket for non-existent session returns 4404', async () => {
    const deadAgent = `ghost-${UID}`
    const ticket = issueTicket(deadAgent, Math.floor(Date.now() / 1000))
    const code = await wsCloseCode(`/ws/agent-pty?ticket=${ticket}`)
    expect(code).toBe(4404)
  })

  it('connects successfully with valid ticket and real tmux session', async () => {
    const ticket = issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000))
    const ws = await connectWs(`/ws/agent-pty?ticket=${ticket}&cols=80&rows=24`)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeAndWait(ws)
  }, 5000)

  it('resize message is forwarded without error', async () => {
    const ticket = issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000))
    const ws = await connectWs(`/ws/agent-pty?ticket=${ticket}`)
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }))
    await new Promise(r => setTimeout(r, 300))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeAndWait(ws)
  }, 3000)

  it('reuses same ticket on second connect returns 4401 (single-use)', async () => {
    const ticket = issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000))
    const ws1 = await connectWs(`/ws/agent-pty?ticket=${ticket}`)
    await closeAndWait(ws1)
    const code = await wsCloseCode(`/ws/agent-pty?ticket=${ticket}`)
    expect(code).toBe(4401)
  }, 5000)

  it('URL agent param is ignored — session comes only from the consumed ticket', async () => {
    const ticket = issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000))
    const ws = await connectWs(`/ws/agent-pty?ticket=${ticket}&agent=ghost-${UID}-attacker`)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeAndWait(ws)
  }, 5000)

  it('a 4th concurrent viewer on the same session is rejected with 4429; slot frees after disconnect', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const t1 = issueTicket(TEST_AGENT, nowS)
    const t2 = issueTicket(TEST_AGENT, nowS)
    const t3 = issueTicket(TEST_AGENT, nowS)
    const t4 = issueTicket(TEST_AGENT, nowS)
    const ws1 = await connectWs(`/ws/agent-pty?ticket=${t1}`)
    const ws2 = await connectWs(`/ws/agent-pty?ticket=${t2}`)
    const ws3 = await connectWs(`/ws/agent-pty?ticket=${t3}`)
    expect(ws1.readyState).toBe(WebSocket.OPEN)
    expect(ws2.readyState).toBe(WebSocket.OPEN)
    expect(ws3.readyState).toBe(WebSocket.OPEN)

    const code = await wsCloseCode(`/ws/agent-pty?ticket=${t4}`)
    expect(code).toBe(4429)

    await closeAndWait(ws1)
    await new Promise(r => setTimeout(r, 150))
    const t5 = issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000))
    const ws5 = await connectWs(`/ws/agent-pty?ticket=${t5}`)
    expect(ws5.readyState).toBe(WebSocket.OPEN)

    await closeAndWait(ws2)
    await closeAndWait(ws3)
    await closeAndWait(ws5)
  }, 10000)

  it('keepalive: a dead connection (no pong) is torn down and its viewer slot is freed', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const t1 = issueTicket(TEST_AGENT, nowS)
    // Connect with autoPong:false and override the 'ping' listener so the
    // client never replies. This simulates a dead-but-alive TCP connection
    // from the server's perspective (no pong arrives → pong-timeout fires).
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/ws/agent-pty?ticket=${t1}`, {
        autoPong: false,
      } as any)
      w.once('open', () => resolve(w))
      w.once('error', reject)
    })
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const closed: number = await new Promise((resolve) => {
      ws.once('close', (code: number) => resolve(code))
      setTimeout(() => resolve(-1), 3000)
    })
    // After ~500ms (200ms ping + 300ms pong-timeout) the server should close
    // with a deliberate code (1011 in this implementation). -1 means we never
    // saw a close event within 3s — that would be the bug we are guarding against.
    expect(closed).not.toBe(-1)

    // Slot should now be free: open 3 fresh tickets and verify all succeed.
    await new Promise(r => setTimeout(r, 100))
    const tt = [
      issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000)),
      issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000)),
      issueTicket(TEST_AGENT, Math.floor(Date.now() / 1000)),
    ]
    const wss: WebSocket[] = []
    for (const t of tt) {
      const w = await connectWs(`/ws/agent-pty?ticket=${t}`)
      expect(w.readyState).toBe(WebSocket.OPEN)
      wss.push(w)
    }
    for (const w of wss) await closeAndWait(w)
  }, 8000)
})
