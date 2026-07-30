import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { load as loadSqliteVec } from 'sqlite-vec'

// Runtime integration: actually loads the sqlite-vec native extension and
// verifies that the vec0 virtual table can be created and queried.
// This test would have caught the ESM require() incompatibility (the extension
// silently fell back to BLOB cosine because `require` is not defined in ESM
// modules, but the error was swallowed in the catch block).

function floatsToBlob(floats: number[]): Buffer {
  const buf = Buffer.allocUnsafe(floats.length * 4)
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4)
  return buf
}

describe('sqlite-vec extension', () => {
  let db: Database.Database

  afterEach(() => {
    try { db?.close() } catch { /* already closed */ }
  })

  it('loads without throwing', () => {
    db = new Database(':memory:')
    expect(() => loadSqliteVec(db)).not.toThrow()
  })

  it('vec0 virtual table is creatable after load', () => {
    db = new Database(':memory:')
    loadSqliteVec(db)
    expect(() => {
      db.exec(`CREATE VIRTUAL TABLE test_vec USING vec0(embedding FLOAT[4])`)
    }).not.toThrow()
  })

  it('insert and KNN query return correct results', () => {
    db = new Database(':memory:')
    loadSqliteVec(db)
    db.exec(`CREATE VIRTUAL TABLE test_vec USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding FLOAT[4]
    )`)

    // better-sqlite3 binds JS numbers as SQLITE_FLOAT; vec0 INTEGER PRIMARY KEY
    // requires SQLITE_INTEGER. BigInt forces the correct SQLite type.
    const insert = db.prepare('INSERT INTO test_vec(item_id, embedding) VALUES(?, ?)')
    insert.run(BigInt(1), floatsToBlob([1.0, 0.0, 0.0, 0.0]))
    insert.run(BigInt(2), floatsToBlob([0.0, 1.0, 0.0, 0.0]))
    insert.run(BigInt(3), floatsToBlob([0.0, 0.0, 1.0, 0.0]))

    // Query closest to [1, 0, 0, 0] -- should be item_id 1
    const rows = db.prepare(
      'SELECT item_id, distance FROM test_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance'
    ).all(floatsToBlob([1.0, 0.0, 0.0, 0.0]), BigInt(2)) as { item_id: number; distance: number }[]

    expect(rows).toHaveLength(2)
    expect(rows[0].item_id).toBe(1)
    expect(rows[0].distance).toBeCloseTo(0, 5)
  })

  it('vec_memories schema matches production (768-dim FLOAT)', () => {
    db = new Database(':memory:')
    loadSqliteVec(db)
    expect(() => {
      db.exec(`CREATE VIRTUAL TABLE vec_memories USING vec0(
        memory_id INTEGER PRIMARY KEY,
        embedding FLOAT[768]
      )`)
    }).not.toThrow()
  })
})
