// Frontmatter scan of a package text file (plan S17, MIOAGENTINSTALL1114).
//
// ISOLATED ON PURPOSE: nothing else in the verifier depends on how a
// frontmatter is read. This module mirrors `frontmatterFindings` of the
// reference scanner (marveen-io PR 371, head 4d9b9e99, package-scan.ts) line
// for line, so every install-stage case of that head's shared text vector
// passes. Its only tests are the vector-driven ones: a rule the vector does
// not pin is not a rule here.
//
// The block is an ALLOWLIST GRAMMAR, not a list of refused shapes. Inside it
// a line may only be:
//   1. empty, or spaces only;
//   2. a column-0 comment;
//   3. a column-0 `name:` or `description:`, each at most once, followed by
//      spaces and exactly one of
//        - a one-line plain value that starts with a letter, holds no tab, no
//          colon-and-space, no trailing colon, no blank-and-hash, and is not a
//          YAML non-string word,
//        - a quoted value closed on its line (a double-quoted one without a
//          backslash), then at most a comment,
//        - a block header (`|` or `>`, an optional `+` or `-`) whose next line
//          is an indented, non-blank line;
//   4. an indented line, only under an open block header, never less indented
//      than the block's first line.
// Three hyphens anywhere in a line, three dots at column 0 and a tab-started
// line are refused everywhere in the block. Everything else is refused.
//
// A finding carries the rule and the line, never the matched text or the key.

export interface FrontmatterFinding {
  rule:
    | 'frontmatter-fence'
    | 'frontmatter-unterminated'
    | 'frontmatter-marker'
    | 'frontmatter-tab'
    | 'frontmatter-indent'
    | 'frontmatter-block-indent'
    | 'frontmatter-key'
    | 'frontmatter-duplicate-key'
    | 'frontmatter-value'
    | 'frontmatter-quoted-value'
  line: number
}

/** S17: the only top-level frontmatter keys a package file may carry. */
const ALLOWED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['name', 'description'])
const FRONTMATTER_FENCE_RE = /^---[ \t]*$/
/** The region ends at the first exact three-hyphen line from the third line on. */
const FRONTMATTER_CLOSE_RE = /^---$/
/** The CLI's own opening-fence test: three hyphens, then JS whitespace to the end of the line. */
const CLI_FENCE_RE = /^---\s*$/u
/** Whitespace (blank lines included) before a line that starts with three hyphens. */
const LEADING_WS_FENCE_RE = /^\s+---/u
/** A plain value may not hold a colon and a space, end in a colon, or hold a blank and a hash. */
const PLAIN_VALUE_BREAK_RE = /: |:$|[ \t]#/
/** Nor be a YAML core-schema non-string: the value must stay a string. */
const NON_STRING_PLAIN_RE =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/
const BLOCK_HEADER_RE = /^[|>][+-]? *$/
/** A plain value starts with a letter, so no YAML indicator and no number can open it. */
const PLAIN_VALUE_START_RE = /^\p{L}/u

function plainValueOk(v: string): boolean {
  const t = v.trimEnd()
  return (
    t !== '' &&
    PLAIN_VALUE_START_RE.test(t) &&
    !t.includes('\t') &&
    !PLAIN_VALUE_BREAK_RE.test(t) &&
    !NON_STRING_PLAIN_RE.test(t)
  )
}

/**
 * A value that opens with a quote must close with its pair on that line, and
 * only blanks, or blanks and a comment, may follow. A double-quoted value is an
 * escape language, so a backslash anywhere in it refuses it.
 */
function quotedValueClosed(rest: string): boolean {
  const v = rest.replace(/^[ \t]+/, '')
  const q = v[0]
  if (q !== '"' && q !== "'") return true
  if (q === '"' && v.includes('\\')) return false
  let i = 1
  while (i < v.length) {
    if (q === "'" && v[i] === "'" && v[i + 1] === "'") i += 2
    else if (v[i] === q) break
    else i++
  }
  if (i >= v.length) return false
  return /^(?:[ \t]*|[ \t]+#.*)$/.test(v.slice(i + 1))
}

/**
 * Every frontmatter finding of one decoded text, in line order. Empty when the
 * text has no frontmatter, or one that passes.
 */
export function frontmatterFindings(text: string): FrontmatterFinding[] {
  const lines = text.split('\n')
  const leading = LEADING_WS_FENCE_RE.exec(text)
  if (leading) return [{ rule: 'frontmatter-fence', line: leading[0].split('\n').length }]
  if (CLI_FENCE_RE.test(lines[0]) && !FRONTMATTER_FENCE_RE.test(lines[0])) {
    return [{ rule: 'frontmatter-fence', line: 1 }]
  }
  if (!FRONTMATTER_FENCE_RE.test(lines[0])) return []
  const end = lines.findIndex((l, i) => i > 1 && FRONTMATTER_CLOSE_RE.test(l))
  if (end === -1) return [{ rule: 'frontmatter-unterminated', line: 1 }]
  const out: FrontmatterFinding[] = []
  const refuse = (rule: FrontmatterFinding['rule'], i: number): void => {
    out.push({ rule, line: i + 1 })
  }
  const seen = new Set<string>()
  let block = false
  let blockIndent = 0 // the indent of the open block body's first line; 0 = not set yet
  for (let i = 1; i < end; i++) {
    const l = lines[i]
    // One of the CLI's readers closes at the first three hyphens anywhere, even
    // mid-line; refusing them here makes every reader end at the same line.
    if (l.includes('---') || l.startsWith('...')) {
      refuse('frontmatter-marker', i)
      continue
    }
    if (l[0] === '\t') {
      refuse('frontmatter-tab', i)
      continue
    }
    if (/^ *$/.test(l)) continue
    if (l[0] === ' ') {
      if (!block) {
        refuse('frontmatter-indent', i)
        continue
      }
      // YAML ends a block at a less indented line, which is then read as a key
      // or an error; so the body never dedents.
      const indent = l.length - l.replace(/^ +/, '').length
      if (blockIndent === 0) blockIndent = indent
      else if (indent < blockIndent) refuse('frontmatter-block-indent', i)
      continue
    }
    block = false // a column-0 line ends an open block
    if (l[0] === '#') continue
    const m = /^([^:]*):(.*)$/.exec(l)
    const key = m?.[1]
    if (m === null || key === undefined || !ALLOWED_FRONTMATTER_KEYS.has(key)) {
      refuse('frontmatter-key', i)
      continue
    }
    if (seen.has(key)) refuse('frontmatter-duplicate-key', i)
    seen.add(key)
    const rest = m[2]
    // Only spaces after the colon, and the value's first character is not a tab.
    if (!/^ +[^ \t]/.test(rest)) {
      refuse('frontmatter-value', i) // an empty value, no blank after the colon, or a tab
      continue
    }
    const v = rest.replace(/^ +/, '')
    if (v[0] === '"' || v[0] === "'") {
      if (!quotedValueClosed(rest)) refuse('frontmatter-quoted-value', i)
      continue
    }
    if (BLOCK_HEADER_RE.test(v)) {
      // The next line must be the block's first, indented, non-blank line.
      const next = lines[i + 1] ?? ''
      if (i + 1 >= end || !/^ +[^ ]/.test(next)) refuse('frontmatter-value', i)
      block = true
      blockIndent = 0
      continue
    }
    if (!plainValueOk(v)) refuse('frontmatter-value', i)
  }
  return out
}
