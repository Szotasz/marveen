#!/usr/bin/env node
/**
 * End-to-end check of the worksource channel over REAL stdio MCP framing.
 *
 * Not a unit test: it starts server.mjs as a child process, speaks the protocol
 * to it, and asserts on what comes back and what lands on disk. The point is to
 * prove the CONTRACT -- that a queued file becomes a claude/channel
 * notification, and that the acknowledgment takes it off the queue -- before any
 * agent is pointed at it.
 *
 * Run: node plugins/worksource/verify.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'worksource-verify-'))
mkdirSync(join(root, 'pending'), { recursive: true })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`)
}

const server = spawn('node', [join(import.meta.dirname, 'server.mjs')], {
  env: { ...process.env, WORKSOURCE_AGENT_ID: 'verify-agent', WORKSOURCE_DIR: root, WORKSOURCE_POLL_MS: '300' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const send = (msg) => server.stdin.write(JSON.stringify(msg) + '\n')
const inbox = []
let buf = ''
server.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) { try { inbox.push(JSON.parse(line)) } catch { /* framing noise */ } }
  }
})

const waitFor = (pred, what, ms = 8000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      const hit = inbox.find(pred)
      if (hit) { clearInterval(tick); resolve(hit) }
      else if (Date.now() - started > ms) { clearInterval(tick); reject(new Error(`timeout waiting for ${what}`)) }
    }, 50)
  })

try {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } },
  })
  const init = await waitFor((m) => m.id === 1, 'initialize result')
  check('server initializes', init.result != null)
  check(
    'declares the claude/channel capability',
    init.result?.capabilities?.experimental?.['claude/channel'] != null,
    'without it a delivery would arrive as tool output, not as a turn',
  )
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = await waitFor((m) => m.id === 2, 'tools/list result')
  check('exposes work_complete', (tools.result?.tools ?? []).some((t) => t.name === 'work_complete'))

  // The actual thing: a file in pending/ must become a channel notification.
  writeFileSync(
    join(root, 'pending', 'job-1.json'),
    JSON.stringify({ content: 'Route review 7970: Google Workspace storage at 96%.', meta: { review_id: '7970' } }),
  )
  const note = await waitFor((m) => m.method === 'notifications/claude/channel', 'channel notification')
  check('a queued file arrives as a channel notification', note.params?.content?.includes('7970'))
  check('the work_id travels with it', note.params?.meta?.work_id === 'job-1', `got ${note.params?.meta?.work_id}`)
  check('caller-supplied meta survives', note.params?.meta?.review_id === '7970')
  check('the item is in flight, not still pending', existsSync(join(root, 'active', 'job-1.json')))

  // A malformed id must be refused rather than sanitised: a rewritten id would
  // acknowledge the wrong item.
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'work_complete', arguments: { work_id: '../escape' } } })
  const bad = await waitFor((m) => m.id === 3, 'malformed-id result')
  check('refuses a traversal-shaped work_id', bad.result?.isError === true)

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'work_complete', arguments: { work_id: 'job-1', result: 'routed to um' } } })
  const ack = await waitFor((m) => m.id === 4, 'work_complete result')
  check('acknowledges the item', ack.result?.isError !== true)
  check('the item leaves the in-flight set', !existsSync(join(root, 'active', 'job-1.json')))
  const done = existsSync(join(root, 'done', 'job-1.json')) ? JSON.parse(readFileSync(join(root, 'done', 'job-1.json'), 'utf8')) : null
  check('the result is recorded', done?.result === 'routed to um')

  // Acknowledging twice must fail loudly rather than silently succeed.
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'work_complete', arguments: { work_id: 'job-1' } } })
  const twice = await waitFor((m) => m.id === 5, 'double-ack result')
  check('a second acknowledgment is rejected', twice.result?.isError === true)

  // The crash path, and the reason an item is only finished when the agent says
  // so: an item handed over but never acknowledged must come back after a
  // restart. Silently losing work would make this worse than the keyboard.
  server.kill()
  await new Promise((r) => setTimeout(r, 200))
  mkdirSync(join(root, 'active'), { recursive: true })
  writeFileSync(join(root, 'active', 'job-2.json'), JSON.stringify({ content: 'unacknowledged work' }))
  inbox.length = 0
  const restarted = spawn('node', [join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, WORKSOURCE_AGENT_ID: 'verify-agent', WORKSOURCE_DIR: root, WORKSOURCE_POLL_MS: '300' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let rbuf = ''
  restarted.stdout.on('data', (chunk) => {
    rbuf += chunk.toString()
    let nl
    while ((nl = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, nl).trim()
      rbuf = rbuf.slice(nl + 1)
      if (line) { try { inbox.push(JSON.parse(line)) } catch { /* framing noise */ } }
    }
  })
  restarted.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } },
  }) + '\n')
  await waitFor((m) => m.id === 1, 'restart initialize')
  restarted.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const redelivered = await waitFor(
    (m) => m.method === 'notifications/claude/channel' && m.params?.meta?.work_id === 'job-2',
    're-delivery of the unacknowledged item',
  )
  check('an unacknowledged item is re-delivered after a restart', redelivered != null)
  restarted.kill()
} catch (err) {
  check('run completed without timing out', false, String(err.message))
} finally {
  server.kill()
  rmSync(root, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok)
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
