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

  it('vec_artifacts schema matches production (768-dim FLOAT, INTEGER PK)', () => {
    db = new Database(':memory:')
    loadSqliteVec(db)
    expect(() => {
      db.exec(`CREATE VIRTUAL TABLE vec_artifacts USING vec0(
        artifact_rowid INTEGER PRIMARY KEY,
        embedding FLOAT[768]
      )`)
    }).not.toThrow()
  })

  it('vec_artifacts KNN query returns correct artifact_rowid', () => {
    db = new Database(':memory:')
    loadSqliteVec(db)
    db.exec(`CREATE VIRTUAL TABLE vec_artifacts USING vec0(
      artifact_rowid INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )`)

    const emb1 = Buffer.allocUnsafe(768 * 4)
    const emb2 = Buffer.allocUnsafe(768 * 4)
    for (let i = 0; i < 768; i++) {
      emb1.writeFloatLE(i === 0 ? 1.0 : 0.0, i * 4)
      emb2.writeFloatLE(i === 1 ? 1.0 : 0.0, i * 4)
    }

    db.prepare('INSERT INTO vec_artifacts(artifact_rowid, embedding) VALUES(?, ?)').run(BigInt(10), emb1)
    db.prepare('INSERT INTO vec_artifacts(artifact_rowid, embedding) VALUES(?, ?)').run(BigInt(20), emb2)

    const rows = db.prepare(
      'SELECT artifact_rowid, distance FROM vec_artifacts WHERE embedding MATCH ? AND k = ? ORDER BY distance'
    ).all(emb1, BigInt(1)) as { artifact_rowid: number; distance: number }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].artifact_rowid).toBe(10)
    expect(rows[0].distance).toBeCloseTo(0, 5)
  })
})
