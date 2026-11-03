// Several processes run initDatabase() on the same, already-migrated file at the
// same instant (the dashboard, a script and a hook starting together). Every
// "drop the trigger, create it again" step at startup must be atomic across
// processes: as two separate statements, two startups interleave
// DROP, DROP, CREATE, CREATE and the second CREATE dies with
// `SQLITE_ERROR: trigger ... already exists`, taking that process's startup down.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { initDatabase } from '../db.js'

const ROOT = join(__dirname, '..', '..')
const CHILDREN = 6
// Each child re-runs initDatabase this many times after the barrier, so the
// children overlap through many startups instead of hoping one pair lines up.
const INITS_PER_CHILD = 15

// Every trigger the startup path drops and re-creates.
const RECREATED = [
  'kanban_cards_claim_clears_on_status',
  'kanban_cards_claim_clears_on_reassign',
  'kanban_cards_version_bump',
  'memories_touch',
  'homoglyph_kanban_comments_ai',
  'homoglyph_kanban_cards_ai',
]

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'db-init-concurrent-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function runChild(script: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'silent' } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}

describe('initDatabase: concurrent startups on one migrated file', () => {
  it(`${CHILDREN} processes x ${INITS_PER_CHILD} inits at the same instant: none fails, every trigger is there once`, async () => {
    const dbPath = join(dir, 'race.db')
    initDatabase(dbPath) // migrate once, so the children only run the re-create steps
    const script = join(dir, 'child.ts')
    writeFileSync(script, [
      `import { initDatabase } from ${JSON.stringify(join(ROOT, 'src', 'db.ts'))}`,
      `const [dbPath, startAt, n] = process.argv.slice(2)`,
      `const late = Date.now() > Number(startAt)`,
      `while (Date.now() < Number(startAt)) { /* barrier */ }`,
      `const errors: string[] = []`,
      `for (let i = 0; i < Number(n); i++) {`,
      `  try { initDatabase(dbPath) } catch (e) { errors.push(String((e as Error).message)) }`,
      `}`,
      `console.log(JSON.stringify({ late, errors }))`,
    ].join('\n'))
    // The tsx import of db.ts takes a few seconds per child; the barrier releases
    // them together after every child has loaded.
    const startAt = Date.now() + 8000
    const results = await Promise.all(Array.from({ length: CHILDREN }, () => runChild(script, [dbPath, String(startAt), String(INITS_PER_CHILD)])))
    const parsed = results.map((r) => {
      // stderr goes in JSON-escaped: raw "    at ..." lines would be read as frames of this error.
      if (r.code !== 0) throw new Error(`child failed (${r.code}): ${JSON.stringify(r.err.slice(-500))}`)
      return JSON.parse(r.out.trim().split('\n').pop()!) as { late: boolean; errors: string[] }
    })
    expect(parsed.map((p) => p.late)).toEqual(Array(CHILDREN).fill(false))
    expect(parsed.flatMap((p) => p.errors)).toEqual([])

    const d = new Database(dbPath, { readonly: true })
    try {
      const names = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name)
      for (const t of RECREATED) expect(names.filter((n) => n === t), t).toHaveLength(1)
    } finally {
      d.close()
    }
  }, 90_000)

  it('a card written while other processes start up is still journaled by the homoglyph trigger', async () => {
    // Between a separate DROP and CREATE another connection can write a row that
    // no trigger sees. The writer is the app's own connection (getDb) inserting
    // cards with a Cyrillic letter in the title; every one of them must land in
    // homoglyph_findings.
    const dbPath = join(dir, 'window.db')
    initDatabase(dbPath)
    const initScript = join(dir, 'init-child.ts')
    writeFileSync(initScript, [
      `import { initDatabase } from ${JSON.stringify(join(ROOT, 'src', 'db.ts'))}`,
      `const [dbPath, startAt, n] = process.argv.slice(2)`,
      `const late = Date.now() > Number(startAt)`,
      `while (Date.now() < Number(startAt)) { /* barrier */ }`,
      `const errors: string[] = []`,
      `for (let i = 0; i < Number(n); i++) {`,
      `  try { initDatabase(dbPath) } catch (e) { errors.push(String((e as Error).message)) }`,
      `}`,
      `console.log(JSON.stringify({ late, errors, written: 0 }))`,
    ].join('\n'))
    const writerScript = join(dir, 'writer-child.ts')
    writeFileSync(writerScript, [
      `import { initDatabase, getDb } from ${JSON.stringify(join(ROOT, 'src', 'db.ts'))}`,
      `const [dbPath, startAt, ms] = process.argv.slice(2)`,
      `initDatabase(dbPath)`,
      `const ins = getDb().prepare("INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES (?, ?, 'planned', 1, 1)")`,
      `const late = Date.now() > Number(startAt)`,
      `while (Date.now() < Number(startAt)) { /* barrier */ }`,
      `const stopAt = Number(startAt) + Number(ms)`,
      `const errors: string[] = []`,
      `let written = 0`,
      `while (Date.now() < stopAt) {`,
      `  try { ins.run('w-' + written, 'Cyrillic \u0430 card ' + written); written++ } catch (e) { errors.push(String((e as Error).message)) }`,
      `}`,
      `console.log(JSON.stringify({ late, errors, written }))`,
    ].join('\n'))
    const startAt = Date.now() + 8000
    const results = await Promise.all([
      ...Array.from({ length: CHILDREN - 1 }, () => runChild(initScript, [dbPath, String(startAt), String(INITS_PER_CHILD)])),
      runChild(writerScript, [dbPath, String(startAt), '3000']),
    ])
    const parsed = results.map((r) => {
      if (r.code !== 0) throw new Error(`child failed (${r.code}): ${JSON.stringify(r.err.slice(-500))}`)
      return JSON.parse(r.out.trim().split('\n').pop()!) as { late: boolean; errors: string[]; written: number }
    })
    expect(parsed.map((p) => p.late)).toEqual(Array(CHILDREN).fill(false))
    const written = parsed[CHILDREN - 1].written
    expect(written).toBeGreaterThan(0)

    const d = new Database(dbPath, { readonly: true })
    try {
      const journaled = (d.prepare("SELECT count(*) AS n FROM homoglyph_findings WHERE src_table = 'kanban_cards' AND src_id LIKE 'w-%'").get() as { n: number }).n
      expect({ written, journaled }).toEqual({ written, journaled: written })
    } finally {
      d.close()
    }
  }, 90_000)

  it('a comment written after a restart on the migrated file is journaled by the homoglyph trigger', () => {
    // The first initDatabase migrates the file, the second takes the restart path
    // that drops and re-creates the trigger.
    const dbPath = join(dir, 'comment.db')
    initDatabase(dbPath)
    initDatabase(dbPath)
    const d = new Database(dbPath)
    try {
      const ins = d.prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, 1)")
      const flagged = Number(ins.run('c-1', 'test', 'Cyrillic \u0430 comment').lastInsertRowid)
      ins.run('c-1', 'test', 'plain ascii comment')
      const rows = d.prepare("SELECT src_id, sample FROM homoglyph_findings WHERE src_table = 'kanban_comments'").all()
      expect(rows).toEqual([{ src_id: String(flagged), sample: 'Cyrillic \u0430 comment' }])
    } finally {
      d.close()
    }
  })
})
