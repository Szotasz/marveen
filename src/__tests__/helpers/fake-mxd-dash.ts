// A fake marveen-mxd dash.sock for tests (GROMZOOWNERQR1030). NEVER the real socket:
// every owner_invite / owner_login_code on the real one issues a live, rate-limited
// secret on the controller.
//
// Speaks what mxd does (src/main.rs serve_conn): one request line in, one reply line
// out. Each verb's answer is scripted: a JSON value, a raw string (sent as given, so
// malformed and oversized replies can be produced), or 'hang' (never answers).
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeAnswer = Record<string, unknown> | { raw: string } | 'hang'

export interface FakeMxdDash {
  path: string
  /** Verbs received, in order. */
  seen: string[]
  script: Map<string, FakeAnswer>
  close(): Promise<void>
}

export async function startFakeMxdDash(): Promise<FakeMxdDash> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-mxd-'))
  const path = join(dir, 'dash.sock')
  const seen: string[] = []
  const script = new Map<string, FakeAnswer>()
  const conns = new Set<net.Socket>()
  const server = net.createServer((c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
    c.on('error', () => {})
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let verb = '?'
      try { verb = String(JSON.parse(line).verb) } catch { /* bad request */ }
      seen.push(verb)
      const a = script.get(verb) ?? { ok: false, error: 'unknown_verb' }
      if (a === 'hang') return
      if ('raw' in a && typeof a.raw === 'string') { c.write(a.raw); return }
      c.write(JSON.stringify(a) + '\n')
    })
  })
  await new Promise<void>((r) => server.listen(path, () => r()))
  return {
    path,
    seen,
    script,
    close: async () => {
      for (const c of conns) c.destroy()
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Shapes exactly as mxd link.rs writes them (owner_invite / owner_login_code). */
export const INVITE_OK = { ok: true, homeserver: 'https://chat.gromzo.com', owner_secret: 'moi_INVITESECRET_x9Q', expires_in: 600 }
export const LOGIN_OK = { ok: true, homeserver: 'https://chat.gromzo.com', login_secret: 'mol_LOGINSECRET_k2Z', expires_in: 120 }
