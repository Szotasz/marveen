// GLOBAL SUITE SEAM: no test run may drive the operator's real embedding server.
//
// EMBEDSEAM1123 (2026-11-23). Measured on one run of the 84 memory-touching
// test files: 646 real POST /api/embeddings requests reached the operator's
// live Ollama -- about 610 of them from memories-dedup.test.ts and 23 from
// memory-performance.test.ts. Ollama ran the embedding model on the CPU for
// every one of those requests, on the same machine as the operator's live
// dashboard, and it does so again on every suite run. The cost shows up on
// the box that hosts Ollama, not in the test output, which is why this is a
// setup-file seam: nobody can forget it per file.
//
// Why the seam THROWS instead of answering with a fake vector: src/db.ts
// generateEmbedding() already treats an unreachable backend as "no vector"
// (returns null, warns once), so every caller already has a tested path for
// precisely this failure. The rejection reproduces the shape undici gives for
// a dead port -- TypeError('fetch failed') with cause.code ECONNREFUSED --
// so a test that does not stub fetch exercises the same "no embedding server"
// branch it would exercise with no Ollama running at all. A test never needs
// a real vector unless it stubs fetch itself.
//
// Matched by path, not by host: take the pathname, collapse every run of two
// or more '/' into a single '/', strip any trailing '/', and match when what
// is left ENDS with /api/embeddings or /api/embed on a path-segment boundary
// (the leading '/' of the suffix is part of the match, so /fooapi/embeddings
// does not count) -- under any prefix, on ANY host, port or scheme. Why so
// loose: src/db.ts builds the request as `${EMBED_URL}/api/embeddings` with
// EMBED_URL verbatim from the developer's .env and no normalisation, so
// EMBED_URL "http://h:11434/" yields "//api/embeddings" and a reverse-proxy
// prefix ("http://h/ollama") yields "/ollama/api/embeddings" -- both must
// still be caught, or those requests reach a real server. EMBED_URL is
// configurable, so pinning localhost:11434 here would let a test that points
// it elsewhere slip straight through to a real server. Near-misses
// (/api/embeddings-x, /v1/embeddings, /api/tags) are not matched and reach
// the network untouched, which is what the positive control in the test file
// proves; /v1/embeddings is not matched because this codebase never calls it.
// Also match the raw URL suffix: EMBED_URL ending in a query or fragment puts
// the appended embedding path outside the pathname. A redirecting server could
// otherwise send fetch to the embedding path without re-entering this wrapper.
//
// A test's own stub still wins: vi.stubGlobal('fetch', ...) replaces this
// whole wrapper (vi.unstubAllGlobals() puts it back), so tests that provide
// their own vectors -- embed-model-split.test.ts and friends -- are
// unaffected. MARVEEN_TEST_REAL_EMBED=1 installs nothing, for the rare case
// that genuinely wants to measure against a real server.
//
// Install-once via Symbol.for, not Symbol(): setup files run before every
// test file, and if one of those runs finds a fetch that is already seamed,
// a fresh Symbol() from a fresh module copy would not recognise it and would
// wrap the wrapper. Symbol.for reads the process-wide registry, so every copy
// agrees on the marker and leaves an already seamed fetch alone.
//
// This file imports nothing from src/ on purpose: it runs in every worker
// BEFORE any test module is imported, so importing e.g. src/config.ts here
// would read .env at setup time and pin config state for the whole worker.

export const EMBED_SEAM_MARKER = Symbol.for('marveen.embedEndpointSeam')

export function isEmbeddingEndpoint(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    // Not a parseable absolute URL -- not ours to judge.
    return false
  }
  const normalized = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  const raw = url.replace(/\/+$/, '')
  return (
    normalized === '/api/embeddings' ||
    normalized === '/api/embed' ||
    normalized.endsWith('/api/embeddings') ||
    normalized.endsWith('/api/embed') ||
    raw.endsWith('/api/embeddings') ||
    raw.endsWith('/api/embed')
  )
}

// Opt out with MARVEEN_TEST_REAL_EMBED=1; skip re-installation when a previous
// run of this setup file already seamed fetch in this worker.
if (process.env.MARVEEN_TEST_REAL_EMBED !== '1' && (globalThis.fetch as any)[EMBED_SEAM_MARKER] !== true) {
  const original = globalThis.fetch
  const seamed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.href
    } else if (typeof input === 'object' && input !== null && typeof input.url === 'string') {
      // A Request: its url is the request target.
      url = input.url
    } else {
      url = String(input)
    }
    if (isEmbeddingEndpoint(url)) {
      // Dead-port shape, on purpose (see header). The original fetch is NOT
      // called: the point is that no bytes leave the process.
      throw new TypeError('fetch failed', {
        cause: Object.assign(
          new Error('connect ECONNREFUSED (embed-endpoint-seam: no real embedding server in tests)'),
          { code: 'ECONNREFUSED' },
        ),
      })
    }
    return Reflect.apply(original, globalThis, [input, init])
  }
  Object.defineProperty(seamed, EMBED_SEAM_MARKER, { value: true })
  globalThis.fetch = seamed as typeof fetch
}
