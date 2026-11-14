// Frontmatter scan of a package text file (plan S17 points 2-7, MIOAGENTINSTALL1114).
//
// ISOLATED ON PURPOSE. The other side is replacing this rule set with an
// allowlist, and the frontmatter cases of the shared text vector will change
// with it. Until then this module mirrors `frontmatterFindings` of the
// reference scanner (marveen-io PR 371, head ba64679c, package-scan.ts) line
// for line, so every install-stage case of that vector passes. When the next
// vector arrives, this file is rewritten in one place; nothing else in the
// verifier depends on how a frontmatter is read. Its only tests are the
// vector-driven ones.
//
// A finding carries the rule and the line, never the matched text.

export interface FrontmatterFinding {
  rule:
    | 'frontmatter-fence'
    | 'frontmatter-unterminated'
    | 'frontmatter-marker'
    | 'frontmatter-tab'
    | 'frontmatter-indent'
    | 'frontmatter-key'
  line: number
}

/** S17: the only top-level frontmatter keys a package file may carry. */
const ALLOWED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['name', 'description'])
const FRONTMATTER_FENCE_RE = /^---[ \t]*$/
/** The region ends at the first exact three-hyphen line from the third line on. */
const FRONTMATTER_CLOSE_RE = /^---$/
const YAML_MARKER_RE = /^(?:---|\.\.\.)/
/** The CLI's own opening-fence test: three hyphens, then JS whitespace to the end of the line. */
const CLI_FENCE_RE = /^---\s*$/u
/** Whitespace (blank lines included) before a line that starts with three hyphens. */
const LEADING_WS_FENCE_RE = /^\s+---/u
/** An indented line shaped like a key: `name:` then a space, a tab or the line end. */
const INDENTED_KEY_RE = /^[ \t]+[^ \t#][^:]*:(?:[ \t]|$)/
const KEY_RE = /^([^:]*):(?:[ \t]|$)/

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
  let sawKey = false
  for (let i = 1; i < end; i++) {
    const l = lines[i]
    if (l === '' || l[0] === '#') continue
    if (YAML_MARKER_RE.test(l)) {
      out.push({ rule: 'frontmatter-marker', line: i + 1 })
      continue
    }
    if (l[0] === '\t') {
      out.push({ rule: 'frontmatter-tab', line: i + 1 })
      continue
    }
    if (l[0] === ' ') {
      if (l.trim() !== '' && (!sawKey || INDENTED_KEY_RE.test(l))) {
        out.push({ rule: 'frontmatter-indent', line: i + 1 })
      }
      continue
    }
    sawKey = true
    const key = KEY_RE.exec(l)?.[1]
    if (key !== undefined && ALLOWED_FRONTMATTER_KEYS.has(key)) continue
    out.push({ rule: 'frontmatter-key', line: i + 1 })
  }
  return out
}
