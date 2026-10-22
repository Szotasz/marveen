import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/contacts.mjs against a fake dashboard on 127.0.0.1 (port 0, never
// 18800/18899). Checks method/path/headers/body, that the token never reaches
// stdout/stderr, and that a non-2xx response is a non-zero exit.
const CLI = join(__dirname, '..', '..', 'scripts', 'contacts.mjs')
const TOKEN = 'tok-' + 'S3CRET'.repeat(4)

interface Seen { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body: string }
let server: Server
let port = 0
let dir = ''
let tokenFile = ''
let seen: Seen
let reply: { status: number; json: unknown } = { status: 200, json: {} }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'contacts-cli-'))
  tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, TOKEN + '\n')
  server = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: b }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect([0, 18800, 18899]).not.toContain(port)
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function run(args: string[], tokenPath = tokenFile): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, MARVEEN_BASE_URL: `http://127.0.0.1:${port}`, CONTACTS_TOKEN_FILE: tokenPath },
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => { out += c })
    p.stderr.on('data', (c) => { err += c })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

describe('contacts.mjs', () => {
  it('add: POST /api/contacts with brainy header, bearer, JSON body; token not echoed', async () => {
    reply = { status: 201, json: { ok: true, id: 7 } }
    const r = await run(['add', '--domain', 'business', '--name', 'Kiss Anna', '--field', 'email', '--value', 'a@example.com', '--source', 'owner', '--source-date', '2026-10-22'])
    expect(r.code).toBe(0)
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/api/contacts')
    expect(seen.headers['x-agent-id']).toBe('brainy')
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(seen.body)).toEqual({
      domain: 'business', display_name: 'Kiss Anna',
      values: [{ field: 'email', value: 'a@example.com', source: 'owner', source_date: '2026-10-22' }],
    })
    expect(r.out).toContain('"id": 7')
    expect(r.out + r.err).not.toContain(TOKEN)
  })

  it('value: POST /api/contacts/<id>/values', async () => {
    reply = { status: 201, json: { ok: true, id: 9 } }
    const r = await run(['value', '--id', '7', '--field', 'phone', '--value', '+36 1 234', '--source', 'doc:szerzodes', '--source-date', '2026-10-22'])
    expect(r.code).toBe(0)
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/api/contacts/7/values')
    expect(JSON.parse(seen.body)).toEqual({ field: 'phone', value: '+36 1 234', source: 'doc:szerzodes', source_date: '2026-10-22' })
  })

  it('find: GET with domain and q in the query, no body', async () => {
    reply = { status: 200, json: { contacts: [] } }
    const r = await run(['find', '--domain', 'family', '--q', 'Kiss Anna', '--limit', '5'])
    expect(r.code).toBe(0)
    expect(seen.method).toBe('GET')
    expect(seen.url).toBe('/api/contacts?domain=family&q=Kiss+Anna&limit=5')
    expect(seen.body).toBe('')
    expect(seen.headers['x-agent-id']).toBe('brainy')
  })

  it('show: GET /api/contacts/<id>?domain=', async () => {
    reply = { status: 200, json: { id: 3 } }
    const r = await run(['show', '--domain', 'business', '--id', '3'])
    expect(r.code).toBe(0)
    expect(seen.url).toBe('/api/contacts/3?domain=business')
  })

  it('retract: POST /api/contacts/values/<id>/retract', async () => {
    reply = { status: 201, json: { ok: true, id: 12 } }
    const r = await run(['retract', '--value-id', '9', '--source', 'owner', '--source-date', '2026-10-22'])
    expect(r.code).toBe(0)
    expect(seen.url).toBe('/api/contacts/values/9/retract')
    expect(JSON.parse(seen.body)).toEqual({ source: 'owner', source_date: '2026-10-22' })
  })

  it('non-2xx: non-zero exit, status and error field only, no token, no sent value', async () => {
    reply = { status: 400, json: { error: 'invalid or missing source' } }
    const r = await run(['value', '--id', '7', '--field', 'email', '--value', 'leak@example.com', '--source', 'bad'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('HTTP 400: invalid or missing source')
    expect(r.out + r.err).not.toContain(TOKEN)
    expect(r.out + r.err).not.toContain('leak@example.com')
  })

  it('403 exits non-zero with the status and error field', async () => {
    reply = { status: 403, json: { error: 'forbidden' } }
    const r = await run(['find', '--domain', 'business'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('HTTP 403: forbidden')
  })

  it('usage: --domain missing for find/show/add is exit 2 and sends nothing', async () => {
    seen = { headers: {}, body: '', url: undefined }
    for (const args of [['find'], ['show', '--id', '1'], ['add', '--name', 'X', '--source', 'owner']]) {
      const r = await run(args)
      expect(r.code).toBe(2)
    }
    expect(seen.url).toBeUndefined()
  })

  it('missing token file: non-zero exit without a request', async () => {
    seen = { headers: {}, body: '', url: undefined }
    const r = await run(['find', '--domain', 'business'], join(dir, 'nope'))
    expect(r.code).toBe(1)
    expect(seen.url).toBeUndefined()
  })
})
