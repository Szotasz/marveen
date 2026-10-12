/**
 * Homoglyph detection for durable Hungarian text (GATEHOMOGLIFSWEEP816).
 *
 * Generated Hungarian text occasionally carries Cyrillic (rarely Greek)
 * look-alike letters. They are invisible to a reader but every later grep,
 * filter or FTS query misses them -- the rule you wrote becomes
 * unfindable. A one-time sweep does not hold: the same artifact set
 * re-accumulated 3 files + 25 kanban comments in 19 days (measured
 * 2026-08-16 -> 2026-09-04).
 *
 * Design constraints (owner-approved, msg 18802):
 *  - WARN, never block. Four measured categories are legitimate content:
 *    vendored localizations/encoding tables, files documenting this very
 *    phenomenon, Greek letters as technical notation, and real
 *    foreign-language records (e.g. a Russian customer error message in a
 *    card title). A blocking gate would lose customer data there.
 *  - NO automatic replacement. The look-alike maps by SHAPE, but the word
 *    often needs a different letter (Cyrillic ER looks like `p`, the word
 *    needs `r`); the fix is written by someone who read the word, then
 *    read it back. This module therefore only reports: character,
 *    codepoint, and context.
 */

export interface HomoglyphFinding {
  /** The offending character itself. */
  char: string
  /** e.g. "U+0435" -- reports must cite this, never paste the raw char. */
  codepoint: string
  /** "CYRILLIC" | "GREEK" */
  script: string
  /** Index in the scanned string. */
  index: number
  /** Short surrounding snippet so the word is findable without re-scanning. */
  context: string
}

// Letter ranges only -- punctuation lookalikes are a different problem.
const CYRILLIC = /[Ѐ-ӿ]/
const GREEK = /[Ͱ-Ͽ]/

/**
 * The Cyrillic letters actually measured in our corrupted Hungarian text
 * (2026-08-16 and 2026-09-04 sweeps). Drives the SQLite trigger journal for
 * writes that bypass the API (agents write kanban via sqlite3 directly), so
 * it is deliberately the measured set, not the whole block: a LIKE per
 * character is cheap, a full-range scan in a trigger is not.
 */
export const TRIGGER_CHARS = [
  'а', 'б', 'е', 'и', 'ј', 'к', 'л', 'м', 'н', 'о', 'п', 'р', 'с', 'т', 'у', 'х',
] as const

/** WHEN clause for the kanban homoglyph journal triggers. */
export function triggerLikeClause(column: string): string {
  return TRIGGER_CHARS.map((c) => `${column} LIKE '%${c}%'`).join(' OR ')
}

export function detectHomoglyphs(text: string, contextRadius = 20): HomoglyphFinding[] {
  const findings: HomoglyphFinding[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const script = CYRILLIC.test(ch) ? 'CYRILLIC' : GREEK.test(ch) ? 'GREEK' : null
    if (!script) continue
    const cp = ch.codePointAt(0) ?? 0
    // The context snippet masks every homoglyph (its own and neighbours):
    // a report that carries the corrupted form becomes the next scan's hit,
    // and whoever "fixes" the report deletes the evidence.
    const raw = text.slice(Math.max(0, i - contextRadius), i + contextRadius).replace(/\n/g, ' ')
    findings.push({
      char: ch,
      codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      script,
      index: i,
      context: raw.replace(/[Ѐ-ӿͰ-Ͽ]/g, '?'),
    })
  }
  return findings
}

/**
 * One-line warning for API responses and logs. Cites codepoints, not raw
 * characters, so the warning itself never becomes the next scan's hit.
 */
export function formatHomoglyphWarning(findings: HomoglyphFinding[]): string {
  const parts = findings
    .slice(0, 5)
    .map((f) => `${f.codepoint} (${f.script}) at "${f.context.trim()}"`)
  const more = findings.length > 5 ? ` (+${findings.length - 5} more)` : ''
  return (
    `possible homoglyph(s) in durable text: ${parts.join('; ')}${more}. ` +
    'Saved unchanged. If this is your own Hungarian text, re-type the marked ' +
    'word with the intended letter and read it back; if it is vendored code, ' +
    'documentation of this phenomenon, technical Greek notation, or a real ' +
    'foreign-language record, leave it as is.'
  )
}
