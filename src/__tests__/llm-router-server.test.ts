import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouterHandler } from '../llm-router/server.js'

// The router as a caller meets it.
//
// The routing decision and the translation are tested next door; what is left
// here is the behaviour that only exists once the pieces are wired: the busy
// slot, the two doors reaching the same rules, and what happens when a machine
// answers the health probe and then fails the actual call.

const okVersion = { ok: true, status: 200, json: async () => ({ version: '0.32.5' }) }
const okChat = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ message: { role: 'assistant', content }, prompt_eval_count: 10, eval_count: 5 }),
})

/** A fetch that answers health for everything and chat with a fixed body. */
const fakeFleet = (chat: any = okChat('hello')) =>
  vi.fn(async (url: string) => (String(url).includes('/api/version') ? okVersion : chat)) as any

const call = async (handle: any, { path = '/v1/chat/completions', headers = {}, body = {} as any } = {}) => {
  const chunks: string[] = []
  let status = 0
  let responseHeaders: Record<string, string> = {}
  const req: any = {
    method: 'POST',
    url: path,
    headers,
    on(event: string, cb: any) {
      if (event === 'data') cb(JSON.stringify(body))
      if (event === 'end') cb()
      return req
    },
  }
  const res: any = {
    writeHead(s: number, h: Record<string, string>) { status = s; responseHeaders = h },
    end(payload: string) { chunks.push(payload) },
  }
  await handle(req, res)
  return { status, headers: responseHeaders, body: JSON.parse(chunks.join('')) }
}

const get = async (handle: any, path: string) => {
  const chunks: string[] = []
  let status = 0
  const req: any = { method: 'GET', url: path, headers: {}, on() { return req } }
  const res: any = { writeHead(s: number) { status = s }, end(p: string) { chunks.push(p) } }
  await handle(req, res)
  return { status, body: JSON.parse(chunks.join('')) }
}

describe('a normal call', () => {
  it('reaches the machine the class names, and reports which one answered', async () => {
    const fetchImpl = fakeFleet()
    const handle = createRouterHandler({ fetchImpl })

    const out = await call(handle, {
      headers: { 'x-task-class': 'hungarian' },
      body: { messages: [{ role: 'user', content: 'szia' }] },
    })

    expect(out.status).toBe(200)
    expect(out.body.x_router_host).toBe('air903max')
    expect(out.body.model).toBe('gemma4:31b-magyar')
    const chatCall = fetchImpl.mock.calls.find((c: any[]) => String(c[0]).includes('/api/chat'))
    expect(JSON.parse(chatCall[1].body)).toMatchObject({ model: 'gemma4:31b-magyar', think: false })
  })

  it('applies the same rules whichever door the caller used', async () => {
    const fetchImpl = fakeFleet()
    const handle = createRouterHandler({ fetchImpl })
    const out = await call(handle, { path: '/api/chat', headers: { 'x-task-class': 'code' }, body: { messages: [] } })
    expect(out.body.model).toBe('laguna-xs.2:fixed')
  })
})

describe('one request per machine, and no queue', () => {
  it('refuses the second call while the first is still running', async () => {
    // The VRAM reality. Waiting would hide the contention; the refusal lets
    // the caller go to the cloud or come back.
    let release: (v: any) => void = () => {}
    const slow = new Promise((resolve) => { release = resolve })
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('/api/version') ? okVersion : slow,
    ) as any
    const handle = createRouterHandler({ fetchImpl })

    const first = call(handle, { headers: { 'x-task-class': 'long-context' }, body: { messages: [] } })
    await new Promise((r) => setTimeout(r, 5))
    const second = await call(handle, { headers: { 'x-task-class': 'long-context' }, body: { messages: [] } })

    expect(second.status).toBe(503)
    expect(second.body.error.code).toBe('all-busy')
    expect(second.headers['Retry-After']).toBeTruthy()

    release(okChat('done'))
    expect((await first).status).toBe(200)
  })

  it('frees the machine again after a failed call, not only a successful one', async () => {
    // A leaked slot would take a machine out of service until restart, and it
    // would do it silently.
    const failing = vi.fn(async (url: string) => {
      if (String(url).includes('/api/version')) return okVersion
      throw new Error('connection reset')
    }) as any
    const handle = createRouterHandler({ fetchImpl: failing })

    const first = await call(handle, { headers: { 'x-task-class': 'long-context' }, body: { messages: [] } })
    expect(first.status).toBe(502)

    const second = await call(handle, { headers: { 'x-task-class': 'long-context' }, body: { messages: [] } })
    expect(second.status).toBe(502)
    expect(second.body.error.code).not.toBe('all-busy')
  })
})

describe('when a machine is not there', () => {
  it('falls back for a class that may, and says who answered', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('192.168.2.189') || u.includes('192.168.2.163')) throw new Error('unreachable')
      if (u.includes('/api/version')) return okVersion
      return okChat('from the small one')
    }) as any
    const handle = createRouterHandler({ fetchImpl })

    const out = await call(handle, { headers: { 'x-task-class': 'structured' }, body: { messages: [] } })
    expect(out.body.x_router_host).toBe('strikex')
  })

  it('refuses long-context work rather than sending it to the slow machine', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('192.168.2.189') || u.includes('192.168.2.163')) throw new Error('unreachable')
      if (u.includes('/api/version')) return okVersion
      return okChat('should never happen')
    }) as any
    const handle = createRouterHandler({ fetchImpl })

    const out = await call(handle, { headers: { 'x-task-class': 'long-context' }, body: { messages: [] } })
    expect(out.status).toBe(503)
    expect(out.body.error.code).toBe('no-local-capacity')
  })

  it('reports an upstream failure as an upstream failure, not as its own', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('/api/version') ? okVersion : { ok: false, status: 500, json: async () => ({}) },
    ) as any
    const handle = createRouterHandler({ fetchImpl })
    const out = await call(handle, { body: { messages: [] } })
    expect(out.status).toBe(502)
    expect(out.body.error.message).toMatch(/air903max answered HTTP 500/)
  })
})

describe('the status endpoint', () => {
  it('says which machines are up and what is busy', async () => {
    const handle = createRouterHandler({ fetchImpl: fakeFleet() })
    const chunks: string[] = []
    let status = 0
    const req: any = { method: 'GET', url: '/health', headers: {}, on() { return req } }
    const res: any = { writeHead(s: number) { status = s }, end(p: string) { chunks.push(p) } }
    await handle(req, res)
    const body = JSON.parse(chunks.join(''))
    expect(status).toBe(200)
    expect(body.up).toMatchObject({ air903max: true, strikex: true })
    expect(body.classes).toContain('hungarian')
  })
})

describe('a request the router cannot parse', () => {
  it('is a 400, not a crash', async () => {
    const handle = createRouterHandler({ fetchImpl: fakeFleet() })
    const req: any = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      on(event: string, cb: any) {
        if (event === 'data') cb('{ this is not json')
        if (event === 'end') cb()
        return req
      },
    }
    let status = 0
    const chunks: string[] = []
    const res: any = { writeHead(s: number) { status = s }, end(p: string) { chunks.push(p) } }
    await handle(req, res)
    expect(status).toBe(400)
  })
})

// The measurement wiring, not the measurement itself.
//
// metrics.ts is tested next door; what can only be checked here is that the
// server actually calls it -- the gap where a working recorder and a working
// server sit side by side and nothing is ever written.
describe('what the router records about itself', () => {
  const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'router-metrics-')), 'metrics.jsonl')

  it('writes a record for a served request, and /metrics reports it', async () => {
    const metricsPath = tmpFile()
    const handle = createRouterHandler({ fetchImpl: fakeFleet(), metricsPath })

    await call(handle, { headers: { 'x-task-class': 'summary' }, body: { messages: [] } })

    const lines = readFileSync(metricsPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ taskClass: 'summary', host: 'air903max', status: 200 })

    const metrics = await get(handle, '/metrics')
    expect(metrics.body).toMatchObject({ requests: 1, served: 1, refused: 0, byClass: { summary: 1 } })
  })

  it('records a refusal with its reason', async () => {
    const metricsPath = tmpFile()
    const handle = createRouterHandler({ fetchImpl: fakeFleet(), metricsPath })

    await call(handle, { headers: { 'x-task-class': 'agent-loop' }, body: { messages: [] } })

    const metrics = await get(handle, '/metrics')
    expect(metrics.body).toMatchObject({ requests: 1, refused: 1, byRefusal: { 'cloud-only': 1 } })
  })

  it('does not fail the request when it cannot write the record', async () => {
    // A full disk must cost the measurement, never the answer.
    const errors: Error[] = []
    const handle = createRouterHandler({
      fetchImpl: fakeFleet(),
      // /dev/null is not a directory: the mkdir fails immediately with
      // ENOTDIR, which is the fast, deterministic version of a bad path.
      metricsPath: '/dev/null/metrics.jsonl',
      onMetricError: (e) => errors.push(e),
    })

    const out = await call(handle, { body: { messages: [] } })
    expect(out.status).toBe(200)
    expect(errors.length).toBe(1)
  })

  it('records nothing at all when no path is configured', async () => {
    // The default must be silence, not a file appearing somewhere unexpected.
    const handle = createRouterHandler({ fetchImpl: fakeFleet() })
    const out = await call(handle, { body: { messages: [] } })
    expect(out.status).toBe(200)
    const metrics = await get(handle, '/metrics')
    expect(metrics.body).toMatchObject({ requests: 0, path: null })
  })
})
