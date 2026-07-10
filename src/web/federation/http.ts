// Bounded reading of peer HTTP responses. A federated peer is an OUTSIDE
// system: an unbounded res.json()/res.text() would buffer whatever it sends
// (undici has no default cap), so a hostile or broken peer could OOM the
// dashboard process -- which also hosts the router and every monitor. Every
// byte read from a peer goes through this reader.

export class PeerResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Peer response exceeded ${limit} bytes`)
    this.name = 'PeerResponseTooLargeError'
  }
}

/** Read a fetch Response body up to maxBytes; throws PeerResponseTooLargeError
 *  beyond that (and cancels the stream). Checks the declared Content-Length
 *  first so an honestly-huge response is refused without reading. */
export async function readBoundedBody(res: Response, maxBytes: number): Promise<string> {
  const declared = parseInt(res.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel() } catch { /* best effort */ }
    throw new PeerResponseTooLargeError(maxBytes)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* best effort */ }
        throw new PeerResponseTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString('utf-8')
}
