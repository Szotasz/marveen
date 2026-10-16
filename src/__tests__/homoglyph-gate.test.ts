import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectHomoglyphs, formatHomoglyphWarning, triggerLikeClause, TRIGGER_CHARS,
} from '../homoglyph.js'

// GATEHOMOGLIFSWEEP816. Design pinned by these tests, in order of importance:
//  1. the gate WARNS and journals -- it never blocks and never rewrites
//     (four measured categories of legitimate Cyrillic/Greek content exist);
//  2. warnings cite CODEPOINTS, not the raw character, so the warning text
//     itself is not the next scan's hit;
//  3. the sqlite trigger path (agents write kanban via sqlite3, bypassing the
//     API) journals the same measured character set the detector knows.
// Strings below build the Cyrillic chars from codepoints on purpose -- a
// literal would make this file a hit for the fleet's artifact sweep.

const CYR_E = String.fromCodePoint(0x0435) // looks like 'e'
const CYR_ER = String.fromCodePoint(0x0440) // looks like 'p', reads 'r'

describe('detectHomoglyphs', () => {
  it('finds a Cyrillic letter inside a Hungarian word and cites its codepoint', () => {
    const findings = detectHomoglyphs(`a fej mer${CYR_E}se kesz`)
    expect(findings).toHaveLength(1)
    expect(findings[0].codepoint).toBe('U+0435')
    expect(findings[0].script).toBe('CYRILLIC')
    expect(findings[0].context).toContain('mer')
  })

  it('returns nothing for clean Hungarian text with real accents', () => {
    expect(detectHomoglyphs('árvíztűrő tükörfúrógép, mérése kész')).toHaveLength(0)
  })

  it('flags Greek letters too -- classification stays with the reader', () => {
    const findings = detectHomoglyphs('a route jele: λ')
    expect(findings).toHaveLength(1)
    expect(findings[0].script).toBe('GREEK')
  })
})

describe('formatHomoglyphWarning', () => {
  it('cites the codepoint and never the raw character', () => {
    const warning = formatHomoglyphWarning(detectHomoglyphs(`me${CYR_ER}es`))
    expect(warning).toContain('U+0440')
    expect(warning).not.toContain(CYR_ER)
    // and it must say the text was saved -- warn, not block
    expect(warning).toContain('Saved unchanged')
  })
})

function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'homoglif-'))
  const db = new Database(join(dir, 'test.db'))
  db.exec(`CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL)`)
  db.exec(`CREATE TABLE kanban_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, author TEXT, content TEXT NOT NULL, created_at INTEGER
  )`)
  db.exec(`CREATE TABLE homoglyph_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, src_table TEXT NOT NULL, src_id TEXT NOT NULL,
    sample TEXT NOT NULL, found_at INTEGER NOT NULL, resolved_at INTEGER
  )`)
  db.exec(`
    CREATE TRIGGER homoglyph_kanban_comments_ai AFTER INSERT ON kanban_comments
    WHEN ${triggerLikeClause('NEW.content')}
    BEGIN
      INSERT INTO homoglyph_findings (src_table, src_id, sample, found_at)
      VALUES ('kanban_comments', NEW.id, substr(NEW.content, 1, 120), unixepoch());
    END
  `)
  return db
}

describe('kanban homoglyph journal trigger (the shipped WHEN clause, on a fixture DB)', () => {
  it('journals a corrupted insert without touching the row itself', () => {
    const db = fixtureDb()
    const dirty = `a kartya mer${CYR_E}se kesz`
    db.prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('C1','t',?,1)").run(dirty)
    const finding = db.prepare('SELECT * FROM homoglyph_findings').all() as { sample: string }[]
    expect(finding).toHaveLength(1)
    expect(finding[0].sample).toContain('kartya')
    // never block, never rewrite: the stored comment is byte-identical
    const stored = db.prepare('SELECT content FROM kanban_comments').get() as { content: string }
    expect(stored.content).toBe(dirty)
  })

  it('mutation control: a clean Hungarian insert journals nothing', () => {
    const db = fixtureDb()
    db.prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('C1','t',?,1)")
      .run('tiszta magyar szoveg, mérése kész, árvíztűrő')
    expect(db.prepare('SELECT COUNT(*) AS n FROM homoglyph_findings').get()).toEqual({ n: 0 })
  })

  it('trigger char set and detector agree on every journaled character', () => {
    for (const ch of TRIGGER_CHARS) {
      const findings = detectHomoglyphs(`x${ch}x`)
      expect(findings, `detector must flag ${findings[0]?.codepoint ?? ch.codePointAt(0)?.toString(16)}`).toHaveLength(1)
      expect(findings[0].script).toBe('CYRILLIC')
    }
  })
})
