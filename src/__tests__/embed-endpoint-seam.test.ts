// EMBEDSEAM1123: proves the embed-endpoint-seam setup file does its job.
//   a) it IS installed (setupFiles ran before this module),
//   b) it matches exactly the two embedding paths on any host,
//   c) an embedding request to a REAL local server never leaves the process
//      and rejects with the dead-port shape,
//   d) a non-embedding request to the SAME server still goes through
//      (positive control: the seam blocks by path, not by blunderbuss),
//   e) URL-object and Request inputs are blocked too,
//   f) a test's own fetch stub wins, and unstubbing restores the seam.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// Read at module load, before any test body runs. This file must NOT
// statically import './setup/embed-endpoint-seam.js': static imports are
// hoisted, so the import itself would install the seam and the "is installed
// by setupFiles" test below could never fail. The marker is read from the
// same process-wide registry the seam writes to; tests that need
// isEmbeddingEndpoint dynamic-import it inside the test body.
const SEAM_MARKER = Symbol.for('marveen.embedEndpointSeam')
const seamedAtLoad = (globalThis.fetch as any)[SEAM_MARKER] === true

// Every request the server receives is counted; /redirect leads to the embedding
// path, and other requests get 200 'ok'. The assertions below read the count.
let requestCount = 0
const server = http.createServer((req, res) => {
  requestCount++
  if (req.url?.startsWith('/redirect')) {
    res.writeHead(307, { Location: '/api/embeddings' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
let port = 0

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    // listen(0) with no host argument: an ephemeral port, so these tests can
    // never collide with a real Ollama sitting on 11434.
    server.listen(0, () => resolve())
  })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    // fetch() keeps its connection alive, which would otherwise hold the close
    // callback hostage until the server's own keep-alive timeout.
    server.closeAllConnections()
  })
})

afterEach(() => vi.unstubAllGlobals())

// The rejection shape undici gives for a dead port, which is what the seam
// throws so generateEmbedding() takes its existing "backend unreachable"
// branch.
async function expectDeadPortRejection(promise: Promise<Response>): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected the seamed fetch to reject')
    },
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(TypeError)
  const cause = (error as TypeError).cause
  expect(cause).toBeInstanceOf(Error)
  expect((cause as Error & { code?: string }).code).toBe('ECONNREFUSED')
}

describe('embed-endpoint-seam (EMBEDSEAM1123)', () => {
  it('is installed by setupFiles: fetch carries the seam marker', () => {
    expect(seamedAtLoad).toBe(true)
    expect((globalThis.fetch as any)[SEAM_MARKER]).toBe(true)
  })

  it('isEmbeddingEndpoint: path ends with /api/embeddings or /api/embed, any host or prefix', async () => {
    const { isEmbeddingEndpoint } = await import('./setup/embed-endpoint-seam.js')
    expect(isEmbeddingEndpoint('http://localhost:11434/api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://localhost:9/api/embed')).toBe(true)
    expect(isEmbeddingEndpoint('https://embed.example.com/api/embeddings/')).toBe(true)

    expect(isEmbeddingEndpoint('http://h:1/api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1/api/embed')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1//api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1/api/embeddings/')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1/ollama/api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1/a/b/api/embed/')).toBe(true)
    expect(isEmbeddingEndpoint('http://h:1/api//embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://h/redirect?next=/api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://h/x#/api/embed')).toBe(true)

    expect(isEmbeddingEndpoint('http://localhost:11434/api/tags')).toBe(false)
    expect(isEmbeddingEndpoint('http://localhost:11434/api/embeddings-x')).toBe(false)
    expect(isEmbeddingEndpoint('http://localhost:11434/v1/embeddings')).toBe(false)
    expect(isEmbeddingEndpoint('not a url')).toBe(false)
    expect(isEmbeddingEndpoint('')).toBe(false)

    expect(isEmbeddingEndpoint('http://h:1/api/embeddings-x')).toBe(false)
    expect(isEmbeddingEndpoint('http://h:1/fooapi/embeddings')).toBe(false)
    expect(isEmbeddingEndpoint('http://h:1/api/embeddings/x')).toBe(false)
    expect(isEmbeddingEndpoint('http://h:1/v1/embeddings')).toBe(false)
    expect(isEmbeddingEndpoint('http://h:1/api/tags')).toBe(false)
    expect(isEmbeddingEndpoint('http://h:1/')).toBe(false)
    expect(isEmbeddingEndpoint('http://h/search?q=/api/embeddings-x')).toBe(false)
    expect(isEmbeddingEndpoint('not a url')).toBe(false)
  })

  it('an embedding POST never reaches the server', async () => {
    const before = requestCount
    await expectDeadPortRejection(
      fetch(`http://localhost:${port}/api/embeddings`, { method: 'POST', body: '{}' }),
    )
    expect(requestCount - before).toBe(0)
  })

  it('positive control: a non-embedding path on the same server goes through', async () => {
    const before = requestCount
    const res = await fetch(`http://localhost:${port}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(requestCount - before).toBe(1)
  })

  it('URL-object and Request inputs are blocked too', async () => {
    const before = requestCount
    await expectDeadPortRejection(fetch(new URL(`http://localhost:${port}/api/embed`)))
    await expectDeadPortRejection(
      fetch(new Request(`http://localhost:${port}/api/embeddings`, { method: 'POST', body: '{}' })),
    )
    expect(requestCount).toBe(before)
  })

  it('a doubled slash or a reverse-proxy prefix on the embedding path is blocked too', async () => {
    const before = requestCount
    await expectDeadPortRejection(
      fetch(`http://127.0.0.1:${port}//api/embeddings`, { method: 'POST', body: '{}' }),
    )
    await expectDeadPortRejection(
      fetch(`http://127.0.0.1:${port}/ollama/api/embeddings`, { method: 'POST', body: '{}' }),
    )
    expect(requestCount - before).toBe(0)
  })

  it('an EMBED_URL ending in a query or fragment cannot reach the embedding path through a redirect', async () => {
    const before = requestCount
    await expectDeadPortRejection(
      fetch(`http://127.0.0.1:${port}/redirect?next=/api/embeddings`, { method: 'POST', body: '{}' }),
    )
    await expectDeadPortRejection(
      fetch(`http://127.0.0.1:${port}/redirect#/api/embeddings`, { method: 'POST', body: '{}' }),
    )
    expect(requestCount - before).toBe(0)
  })

  it('a test that stubs fetch wins over the seam', async () => {
    const stub = vi.fn(async () => new Response('{"embedding":[1,2]}'))
    vi.stubGlobal('fetch', stub)
    const res = await fetch('http://localhost:11434/api/embeddings')
    expect(stub).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"embedding":[1,2]}')
    // Unstubbing must land back on the seam, not on the raw fetch.
    vi.unstubAllGlobals()
    expect((globalThis.fetch as any)[SEAM_MARKER]).toBe(true)
  })
})
