// Agent package verifier (MIOAGENTINSTALL1114, PR-I1).
//
// Pure: no network, no disk, no environment. The text rules below are copied
// from the contract and from the reference scanner of the publishing side
// (marveen-io PR 371, head ba64679c, package-scan.ts), and the shared text
// vector pins both sides to the same bytes. A rule exists here only if the
// plan names it AND the shared vector has cases for it.

import { frontmatterFindings } from './frontmatter.js'

// ---------------------------------------------------------------------------
// Text rules (S10, S11 with its extension, S17 exec tokens; frontmatter in
// frontmatter.ts)
// ---------------------------------------------------------------------------

export type TextReason =
  | 'bad_text'
  | 'forbidden_import_token'
  | 'forbidden_exec_token'
  | 'forbidden_frontmatter_key'

export interface TextFinding {
  reason: TextReason
  /** The rule's name (never the matched text). */
  rule: string
  /** 1 + the number of LF characters before the match; invalid UTF-8 is line 1. */
  line: number
}

/** The S11 table: [id, first, last], inclusive. Copied from the reference scanner; changes only with the contract. */
export const FORBIDDEN_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['c0a', 0x0000, 0x0008],
  ['c0b', 0x000b, 0x000d],
  ['c0c', 0x000e, 0x001f],
  ['del', 0x007f, 0x009f],
  ['shy', 0x00ad, 0x00ad],
  ['cgj', 0x034f, 0x034f],
  ['arf', 0x0600, 0x0605],
  ['alm', 0x061c, 0x061c],
  ['ar2', 0x06dd, 0x06dd],
  ['syr', 0x070f, 0x070f],
  ['ar3', 0x0890, 0x0891],
  ['ar4', 0x08e2, 0x08e2],
  ['hf1', 0x115f, 0x1160],
  ['khm', 0x17b4, 0x17b5],
  ['mvs', 0x180b, 0x180f],
  ['zw', 0x200b, 0x200f],
  ['bidi', 0x2028, 0x202e],
  ['wj', 0x2060, 0x206f],
  ['brl', 0x2800, 0x2800],
  ['hf2', 0x3164, 0x3164],
  ['nch', 0xfdd0, 0xfdef],
  ['vs', 0xfe00, 0xfe0f],
  ['bom', 0xfeff, 0xfeff],
  // S11 extension (v1.2.6): compatibility forms of the three trigger characters.
  ['sxm', 0xfe57, 0xfe57], // small exclamation mark
  ['sat', 0xfe6b, 0xfe6b], // small commercial at
  ['fex', 0xff01, 0xff01], // full-width exclamation mark
  ['fat', 0xff20, 0xff20], // full-width commercial at
  ['fgr', 0xff40, 0xff40], // full-width grave accent
  ['hf3', 0xffa0, 0xffa0],
  ['spc', 0xfff0, 0xfffb],
  // nc2: the last two code points of EVERY plane are noncharacters.
  ...Array.from({ length: 17 }, (_, p) =>
    [`nc2-${p.toString(16)}`, p * 0x10000 + 0xfffe, p * 0x10000 + 0xffff] as const),
  ['kth1', 0x110bd, 0x110bd],
  ['kth2', 0x110cd, 0x110cd],
  ['egy', 0x13430, 0x1343f],
  ['shf', 0x1bca0, 0x1bca3],
  ['mus', 0x1d173, 0x1d17a],
  ['tag', 0xe0000, 0xe0fff],
]

const SORTED_RANGES = [...FORBIDDEN_RANGES].sort((a, b) => a[1] - b[1])

/** True when the code point is in the S11 table (binary search). */
export function isForbiddenCodePoint(cp: number): boolean {
  let lo = 0
  let hi = SORTED_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [, first, last] = SORTED_RANGES[mid]
    if (cp < first) hi = mid - 1
    else if (cp > last) lo = mid + 1
    else return true
  }
  return false
}

/** S10: an at sign not IMMEDIATELY preceded by an ASCII letter or digit. No code-block exception. */
const IMPORT_TOKEN_RE = /(?<![A-Za-z0-9])@/gu
/** S17 (1): the inline pre-run shape, a bang right before a backtick. */
const EXEC_TOKEN_RE = /!`/gu
/** S17 (1): the fenced pre-run shape, three backticks and a bang, anywhere. */
const FENCE_BANG_RE = /```!/gu
/**
 * S11 extension (v1.2.6): the HTML-entity forms of the at sign, the bang and
 * the backtick: decimal and hex (either x, any leading zeros, with or without
 * the closing semicolon, no digit after), and named.
 */
const TRIGGER_ENTITY_RE =
  /&#0*(?:64|33|96)(?![0-9])|&#[xX]0*(?:40|21|60)(?![0-9A-Fa-f])|&(?:commat|excl|grave|DiacriticalGrave);/gu

/** Which reason wins when one text breaks more than one rule (the reference scanner's order). */
const PRECEDENCE: Record<TextReason, number> = {
  bad_text: 0,
  forbidden_import_token: 1,
  forbidden_exec_token: 2,
  forbidden_frontmatter_key: 3,
}

function lineIndexer(text: string): (index: number) => number {
  const lfs: number[] = []
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) lfs.push(i)
  return (index) => {
    let lo = 0
    let hi = lfs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lfs[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/** S11 and S10 over one text: forbidden code points, trigger entities, word-initial at signs. */
function charAndImportFindings(text: string, lineOf: (i: number) => number): TextFinding[] {
  const out: TextFinding[] = []
  let i = 0
  for (const ch of text) {
    if (isForbiddenCodePoint(ch.codePointAt(0)!)) {
      out.push({ reason: 'bad_text', rule: 'forbidden-char', line: lineOf(i) })
    }
    i += ch.length
  }
  for (const m of text.matchAll(TRIGGER_ENTITY_RE)) {
    out.push({ reason: 'bad_text', rule: 'trigger-entity', line: lineOf(m.index!) })
  }
  for (const m of text.matchAll(IMPORT_TOKEN_RE)) {
    out.push({ reason: 'forbidden_import_token', rule: 'at-sign', line: lineOf(m.index!) })
  }
  return out
}

/** The first finding: the winning reason by precedence, then the lowest line, then the rule name. */
function firstFinding(findings: TextFinding[]): TextFinding | null {
  let best: TextFinding | null = null
  for (const f of findings) {
    if (
      best === null ||
      PRECEDENCE[f.reason] < PRECEDENCE[best.reason] ||
      (PRECEDENCE[f.reason] === PRECEDENCE[best.reason] &&
        (f.line < best.line || (f.line === best.line && f.rule < best.rule)))
    ) {
      best = f
    }
  }
  return best
}

const strictUtf8 = (): TextDecoder =>
  // ignoreBOM: the default decoder silently drops a leading BOM, and the
  // forbidden-char rule would never see it (measured by the publishing side).
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Every text rule over one package text file, given as its bytes. Returns the
 * first finding (see `firstFinding`), or null when the file passes.
 */
export function scanPackageText(bytes: Uint8Array): TextFinding | null {
  let text: string
  try {
    text = strictUtf8().decode(bytes)
  } catch {
    return { reason: 'bad_text', rule: 'invalid-utf8', line: 1 }
  }
  const lineOf = lineIndexer(text)
  const findings = charAndImportFindings(text, lineOf)
  for (const m of text.matchAll(EXEC_TOKEN_RE)) {
    findings.push({ reason: 'forbidden_exec_token', rule: 'bang-backtick', line: lineOf(m.index!) })
  }
  for (const m of text.matchAll(FENCE_BANG_RE)) {
    findings.push({ reason: 'forbidden_exec_token', rule: 'fence-bang', line: lineOf(m.index!) })
  }
  for (const f of frontmatterFindings(text)) {
    findings.push({ reason: 'forbidden_frontmatter_key', rule: f.rule, line: f.line })
  }
  return firstFinding(findings)
}
