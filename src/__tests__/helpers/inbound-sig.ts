// HMACINBOUND1125: test-only signing, the way the server signs a row it writes (src/inbound-sig.ts).
//
// A test that rewrites a signed row (created_at, status) breaks its signature, exactly as a raw UPDATE by anyone else
// would; one that builds a row by hand has none. Those tests are about something else (order, framing), so they sign
// the row again here. The production code has no "sign an existing row" path, on purpose.
import { getDb } from '../../db.js'
import { ensureInboundSigKey, signRow, type SignedRowFields } from '../../inbound-sig.js'

function key(): Buffer {
  const k = ensureInboundSigKey()
  if (!k) throw new Error('test store has no inbound signature key and cannot create one')
  return k
}

/** Re-sign rows in the test database with their current fields (all rows when no ids are given). */
export function signRowsInPlace(ids?: number[]): void {
  const db = getDb()
  const rows = (ids
    ? ids.map((id) => db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id))
    : db.prepare('SELECT * FROM agent_messages').all()) as Array<SignedRowFields | undefined>
  const upd = db.prepare('UPDATE agent_messages SET inbound_sig = ? WHERE id = ?')
  for (const r of rows) if (r) upd.run(signRow(r, key()), r.id)
}

/** An in-memory row with the signature the server would have stored for it. */
export function withSig<T extends SignedRowFields>(r: T): T & { inbound_sig: string } {
  return { ...r, inbound_sig: signRow(r, key()) }
}
