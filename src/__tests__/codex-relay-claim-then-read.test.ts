// The claim (rename) must take ownership of the request NAME before the relay reads a single byte,
// and the bytes must come from the claimed copy (#2652 review C2 / dual-review R1 blocker A3: the old
// read-then-claim order let a daemon read the ORIGINAL entry, lose the claim, then claim a NEWER
// entry at the same freed name and forward the STALE bytes -- original forwarded twice, new one
// lost). The preload writes a marker exactly when the relay opens the claimed copy while the
// requests/ name is already gone; the test asserts both the marker and a single forward.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const READ_AFTER_CLAIM_PRELOAD = fileURLToPath(new URL('./fixtures/relay-read-after-claim-preload.mjs', import.meta.url))
const AGENT = 'relay-agent'

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

type Seen = { method?: string; url?: string; body: string }

describe('relay claims the request before reading it', () => {
  it('reads the request from the claimed copy while the requests/ name is already gone, and forwards it exactly once', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-ctr-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const tokenFile = join(work, 'agent.token')
    const auditPath = join(work, 'audit.log')
    const token = `tok-${randomBytes(16).toString('hex')}`
    writeFileSync(tokenFile, `${token}\n`)
    const seen: Seen[] = []
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(READ_AFTER_CLAIM_PRELOAD).href,
      RELAY_MJS,
      '--agent', AGENT, '--relay-dir', relayDir, '--token-file', tokenFile,
      '--dashboard-url', dashboardUrl, '--audit-log', auditPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    try {
      await waitFor(() => (existsSync(join(relayDir, 'relay.ready')) ? true : null))
      writeFileSync(join(requestsDir, 'race2.json'), JSON.stringify({
        id: 'race2', method: 'POST', path: '/api/daily-log',
        body: { agent_id: AGENT, content: 'claim-then-read-race2' },
      }))
      // The forwarded dashboard hit AND the marker the preload wrote when the relay opened the
      // claimed copy with the requests/ name already gone.
      await waitFor(() => (seen.some(s => (s.url ?? '') === '/api/daily-log' && s.body.includes('claim-then-read-race2')) ? true : null))
      await waitFor(() => (existsSync(join(relayDir, 'read-after-claim.ok')) ? true : null))
      // A stray duplicate forward would land within a poll tick or two.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(seen.filter(s => (s.url ?? '') === '/api/daily-log' && s.body.includes('claim-then-read-race2'))).toHaveLength(1)
      expect(existsSync(join(relayDir, 'read-after-claim.ok'))).toBe(true)
      expect(existsSync(join(requestsDir, 'race2.json'))).toBe(false)
    } finally {
      child.kill('SIGTERM')
      await exited(child)
      await new Promise(resolve => server.close(resolve))
      rmSync(work, { recursive: true, force: true })
    }
  }, 60_000)
})
