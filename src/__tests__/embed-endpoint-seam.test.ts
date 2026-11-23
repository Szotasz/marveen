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
import { EMBED_SEAM_MARKER, isEmbeddingEndpoint } from './setup/embed-endpoint-seam.js'

// Every request the server receives is counted; the answer is deliberately
// boring (200 'ok') so the assertions below only ever read the count.
let requestCount = 0
const server = http.createServer((_req, res) => {
  requestCount++
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
    expect((globalThis.fetch as any)[EMBED_SEAM_MARKER]).toBe(true)
  })

  it('isEmbeddingEndpoint: exactly /api/embeddings or /api/embed, any host', () => {
    expect(isEmbeddingEndpoint('http://localhost:11434/api/embeddings')).toBe(true)
    expect(isEmbeddingEndpoint('http://localhost:9/api/embed')).toBe(true)
    expect(isEmbeddingEndpoint('https://embed.example.com/api/embeddings/')).toBe(true)

    expect(isEmbeddingEndpoint('http://localhost:11434/api/tags')).toBe(false)
    expect(isEmbeddingEndpoint('http://localhost:11434/api/embeddings-x')).toBe(false)
    expect(isEmbeddingEndpoint('http://localhost:11434/v1/embeddings')).toBe(false)
    expect(isEmbeddingEndpoint('not a url')).toBe(false)
    expect(isEmbeddingEndpoint('')).toBe(false)
  })

  it('an embedding POST never reaches the server', async () => {
    await expectDeadPortRejection(
      fetch(`http://localhost:${port}/api/embeddings`, { method: 'POST', body: '{}' }),
    )
    expect(requestCount).toBe(0)
  })

  it('positive control: a non-embedding path on the same server goes through', async () => {
    const res = await fetch(`http://localhost:${port}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(requestCount).toBe(1)
  })

  it('URL-object and Request inputs are blocked too', async () => {
    const before = requestCount
    await expectDeadPortRejection(fetch(new URL(`http://localhost:${port}/api/embed`)))
    await expectDeadPortRejection(
      fetch(new Request(`http://localhost:${port}/api/embeddings`, { method: 'POST', body: '{}' })),
    )
    expect(requestCount).toBe(before)
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
    expect((globalThis.fetch as any)[EMBED_SEAM_MARKER]).toBe(true)
  })
})
