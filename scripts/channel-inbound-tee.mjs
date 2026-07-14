#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const childArgs = process.argv.slice(2)
if (childArgs.length === 0) {
  console.error('channel-inbound-tee: missing child command')
  process.exit(2)
}

const [command, ...args] = childArgs
const child = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stateDir = process.env.TELEGRAM_STATE_DIR || ''
const inboxPath = stateDir ? join(stateDir, 'inbox-pending.jsonl') : ''
let warnedInboxWrite = false
let lineBuffer = ''
const decoder = new StringDecoder('utf8')

function warnInboxWrite(err) {
  if (warnedInboxWrite) return
  warnedInboxWrite = true
  const msg = err instanceof Error ? err.message : String(err)
  writeSync(2, `channel-inbound-tee: could not append inbound inbox: ${msg}\n`)
}

function teeLine(line) {
  if (!inboxPath) return

  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }

  if (!frame || typeof frame !== 'object') return
  if (frame.method !== 'notifications/claude/channel') return
  if (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)) return

  try {
    mkdirSync(dirname(inboxPath), { recursive: true })
    appendFileSync(
      inboxPath,
      JSON.stringify({
        receivedAt: Math.floor(Date.now() / 1000),
        params: frame.params,
      }) + '\n',
      'utf8',
    )
  } catch (err) {
    warnInboxWrite(err)
  }
}

function inspectChunk(chunk) {
  lineBuffer += decoder.write(chunk)
  for (;;) {
    const idx = lineBuffer.indexOf('\n')
    if (idx < 0) break
    const line = lineBuffer.slice(0, idx).replace(/\r$/, '')
    lineBuffer = lineBuffer.slice(idx + 1)
    teeLine(line)
  }
}

child.stdout.on('data', (chunk) => {
  writeSync(1, chunk)
  inspectChunk(chunk)
})

child.stderr.on('data', (chunk) => {
  writeSync(2, chunk)
})

// EPIPE guard: the child can die between our destroyed-check and the write
// (e.g. plugin crash); an unhandled 'error' on its stdin would crash the relay.
child.stdin.on('error', () => {})

process.stdin.on('data', (chunk) => {
  if (!child.stdin.destroyed) child.stdin.write(chunk)
})

process.stdin.on('end', () => {
  if (!child.stdin.destroyed) child.stdin.end()
})

process.stdin.on('close', () => {
  if (!child.stdin.destroyed) child.stdin.end()
})

child.on('error', (err) => {
  writeSync(2, `channel-inbound-tee: child spawn failed: ${err.message}\n`)
  process.exit(127)
})

// 'close' (not 'exit'): it fires only after the child's stdio streams are
// fully drained, so a final stdout burst right before death still passes
// through before we tear down.
child.on('close', (code, signal) => {
  const tail = decoder.end()
  if (tail) lineBuffer += tail
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  // Exit EXPLICITLY: the open parent stdin would otherwise keep this relay
  // alive as a zombie after a plugin crash (exitCode alone never applies while
  // the loop is held). All passthrough writes are writeSync -> already flushed.
  process.exit(code ?? 0)
})
