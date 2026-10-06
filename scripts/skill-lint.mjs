#!/usr/bin/env node
// skill-lint (SKILLRULES1001): checks a skill folder, or every skill under a
// root, against Anthropic's "Skill authoring best practices"
// (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
// It ONLY reports: nothing is rewritten, moved or deleted.
//
// The four rules, each tied to the page's own words:
//   skill-md-too-long     "Keep SKILL.md body under 500 lines for optimal
//                         performance" -> the SKILL.md body (the text after the
//                         YAML frontmatter) may have at most 500 lines.
//   reference-missing-toc "For reference files longer than 100 lines, include a
//                         table of contents at the top" -> a references/**.md
//                         file over 100 lines needs a table of contents near its
//                         top: a heading named "Contents" / "Table of contents"
//                         / "Tartalom" / "Tartalomjegyzék" / "TOC", or at least
//                         three in-file anchor links ([..](#..)), within its
//                         first 40 lines.
//   nested-reference      "Keep references one level deep from SKILL.md" -> a
//                         file reached only THROUGH a supporting file that
//                         SKILL.md refers to (SKILL.md -> a.md -> b.md, and
//                         SKILL.md does not refer to b.md) is flagged. Files
//                         that only refer to each other off the SKILL.md path
//                         (README -> LICENSE) are not on the reading path, so
//                         they are not.
//   missing-reference     a relative markdown link in SKILL.md ([text](path),
//                         outside fenced code blocks and inline code) must point to a file or
//                         folder that exists in the skill. Only links count: a
//                         path in backticks is ambiguous (in many skills
//                         `scripts/x.sh` names the install's own scripts/, not
//                         the skill's), and a fenced block is usually an example.
//
// Usage:
//   node scripts/skill-lint.mjs <skill-dir | root-dir> [--json]
// A folder with a SKILL.md is one skill; any other folder is a root, and every
// folder under it that holds a SKILL.md is checked (node_modules and dot-folders
// are skipped). Symlinks are followed safely: every folder is visited once by
// its real path, a symlinked folder under a root is followed only when it IS a
// skill, and inside a skill only a symlink that stays inside the skill is
// entered, so a loop or a link to a big outside tree cannot multiply or stall
// the run. Exit code: 0 no finding, 1 at least one finding, 2 usage or
// read error.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_MD_MAX_BODY_LINES = 500
export const REFERENCE_TOC_THRESHOLD = 100
export const TOC_SEARCH_LINES = 40
const SKIP_DIRS = new Set(['node_modules'])

/** The line count of a text the way an editor shows it (a trailing newline does not open a new line). */
export function lineCount(text) {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** The SKILL.md body: the text after a leading `---` ... `---` frontmatter block (or all of it without one). */
export function skillBody(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return m ? text.slice(m[0].length) : text
}

/** True when the first TOC_SEARCH_LINES lines carry a table of contents. */
export function hasTableOfContents(text) {
  const head = text.split('\n').slice(0, TOC_SEARCH_LINES)
  if (head.some((l) => /^#{1,6}\s*(table of contents|contents|tartalomjegyz[eé]k|tartalom|toc)\s*:?\s*$/i.test(l.trim()))) return true
  const anchors = head.join('\n').match(/\]\(#[^)\s]+\)/g) || []
  return anchors.length >= 3
}

/**
 * Every path-like reference in a markdown text: markdown link targets, and
 * tokens inside backticks or bare in the text that look like relative paths.
 * Returned raw; resolve them against the referring file's folder.
 */
export function extractReferences(text) {
  const out = new Set()
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.add(m[1])
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    for (const tok of m[1].split(/\s+/)) out.add(tok)
  }
  for (const m of text.matchAll(/(?:^|[\s(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+)/gm)) out.add(m[1])
  const clean = new Set()
  for (let r of out) {
    r = r.replace(/^['"(]+|['"),.;:]+$/g, '').split('#')[0].split('?')[0]
    if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('/') || r.startsWith('~') || r.startsWith('$') || r.includes('{') || r.includes('*')) continue
    clean.add(r)
  }
  return [...clean]
}

/** The text without its fenced code blocks (``` or ~~~) and inline code spans, line count kept. */
export function withoutCode(text) {
  const out = []
  let fence = null
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (m && m[1] === fence) fence = null
      out.push('')
    } else if (m) {
      fence = m[1]
      out.push('')
    } else out.push(line.replace(/`[^`\n]*`/g, ''))
  }
  return out.join('\n')
}

/** A path's real path, or null when it cannot be resolved (a dangling link, or a loop: ELOOP). */
function realOrNull(p) {
  try { return realpathSync(p) } catch { return null }
}

function listFiles(dir, base = dir, baseReal = realOrNull(base), seen = new Set([realOrNull(dir)])) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const real = realOrNull(p)
    if (real === null) continue
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      // Enter a folder once, and a symlinked one only when it stays inside the skill.
      const inside = real === baseReal || real.startsWith(baseReal + sep)
      if (seen.has(real) || (lstatSync(p).isSymbolicLink() && !inside)) continue
      seen.add(real)
      out.push(...listFiles(p, base, baseReal, seen))
    } else if (st.isFile()) out.push(relative(base, p).split(sep).join('/'))
  }
  return out
}

/** The relative markdown link targets of a text outside code (the references that must exist). */
export function linkTargets(text) {
  const out = new Set()
  for (const m of withoutCode(text).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const t = m[1].split('#')[0].split('?')[0]
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('~') || t.startsWith('$')) continue
    out.add(t)
  }
  return out
}

/** Resolve a raw reference from a file inside the skill to a skill-relative path, or null when it leaves the skill. */
function resolveRef(skillDir, fromRel, raw) {
  const abs = normalize(resolve(skillDir, dirname(fromRel), raw))
  const rel = relative(skillDir, abs)
  if (!rel || rel.startsWith('..') || resolve(skillDir, rel) !== abs) return null
  return rel.split(sep).join('/')
}

/** All findings for one skill folder (one that holds a SKILL.md). */
export function lintSkill(skillDir) {
  const findings = []
  const add = (rule, file, message) => findings.push({ skill: skillDir, rule, file, message })
  const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')

  const bodyLines = lineCount(skillBody(skillMd))
  if (bodyLines > SKILL_MD_MAX_BODY_LINES) {
    add('skill-md-too-long', 'SKILL.md', `SKILL.md body is ${bodyLines} lines (max ${SKILL_MD_MAX_BODY_LINES}); move detail into reference files linked from SKILL.md`)
  }

  const files = listFiles(skillDir).filter((f) => f !== 'SKILL.md')
  // A file is identified by its real path: a reference through a symlink that
  // stays inside the skill reaches the same file as its real name.
  const byReal = new Map(files.map((f) => [realOrNull(join(skillDir, f)), f]))
  const canon = (fromRel, raw) => {
    const rel = resolveRef(skillDir, fromRel, raw)
    if (rel === null) return null
    return byReal.get(realOrNull(join(skillDir, rel))) ?? null
  }

  for (const f of files) {
    if (!f.startsWith('references/') || !f.endsWith('.md')) continue
    const text = readFileSync(join(skillDir, f), 'utf8')
    const n = lineCount(text)
    if (n > REFERENCE_TOC_THRESHOLD && !hasTableOfContents(text)) {
      add('reference-missing-toc', f, `${n} lines and no table of contents in its first ${TOC_SEARCH_LINES} lines`)
    }
  }

  // References from SKILL.md: the files it reaches (any path-like mention of an
  // existing file), and the links that point to nothing.
  const fromSkill = new Set()
  for (const raw of extractReferences(skillMd)) {
    const rel = canon('SKILL.md', raw)
    if (rel !== null) fromSkill.add(rel)
  }
  for (const raw of linkTargets(skillMd)) {
    const rel = resolveRef(skillDir, 'SKILL.md', raw)
    if (rel === null) continue
    if (rel === 'SKILL.md' || existsSync(join(skillDir, rel))) continue
    add('missing-reference', 'SKILL.md', `links to "${raw}", which does not exist in the skill`)
  }

  // References made BY the supporting files SKILL.md refers to: a file reached
  // only that way sits two levels deep.
  const fromHelpers = new Map()
  for (const f of fromSkill) {
    if (!/\.(md|txt)$/i.test(f)) continue
    const text = readFileSync(join(skillDir, f), 'utf8')
    for (const raw of extractReferences(text)) {
      // Relative to the referring file first, then to the skill root: authors
      // write both (`details.md` next to it, `scripts/x.py` from the root).
      const rel = canon(f, raw) ?? canon('SKILL.md', raw)
      if (rel === null || rel === f) continue
      if (!fromHelpers.has(rel)) fromHelpers.set(rel, new Set())
      fromHelpers.get(rel).add(f)
    }
  }
  for (const [target, sources] of fromHelpers) {
    if (fromSkill.has(target)) continue
    add('nested-reference', target, `referred to only from ${[...sources].sort().join(', ')}, not from SKILL.md (keep references one level deep)`)
  }
  return findings
}

/** The skill folders a path names: itself when it holds a SKILL.md, else every folder under it that does. */
export function findSkills(path) {
  if (existsSync(join(path, 'SKILL.md'))) return [path]
  const out = []
  const seen = new Set([realOrNull(path)])
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
      const p = join(dir, name)
      const real = realOrNull(p)
      if (real === null || seen.has(real)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isDirectory()) continue
      seen.add(real)
      if (existsSync(join(p, 'SKILL.md'))) out.push(p)
      // A symlinked folder is followed only when it is itself a skill: a link
      // to a group or to an outside tree is not walked.
      else if (!lstatSync(p).isSymbolicLink()) walk(p)
    }
  }
  walk(path)
  return out
}

/** Lint a path; the report the CLI prints. */
export function lintPath(path) {
  const skills = findSkills(path)
  const findings = skills.flatMap((s) => lintSkill(s))
  return { path, skills_checked: skills.length, findings, ok: findings.length === 0 }
}

export function formatHuman(report) {
  const lines = report.findings.map((f) => `${relative(process.cwd(), join(f.skill, f.file)) || f.file}: [${f.rule}] ${f.message}`)
  lines.push(`skill-lint: ${report.skills_checked} skill(s) checked, ${report.findings.length} finding(s)`)
  return lines.join('\n')
}

export function main(argv) {
  const args = argv.filter((a) => a !== '--json')
  const asJson = argv.includes('--json')
  if (args.length !== 1 || args[0] === '-h' || args[0] === '--help') {
    process.stderr.write('usage: node scripts/skill-lint.mjs <skill-dir | root-dir> [--json]\n')
    return 2
  }
  const target = resolve(args[0])
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    process.stderr.write(`skill-lint: not a directory: ${args[0]}\n`)
    return 2
  }
  let report
  try {
    report = lintPath(target)
  } catch (e) {
    process.stderr.write(`skill-lint: could not read ${args[0]}: ${e instanceof Error ? e.message : e}\n`)
    return 2
  }
  process.stdout.write((asJson ? JSON.stringify(report, null, 2) : formatHuman(report)) + '\n')
  return report.ok ? 0 : 1
}

const self = realpathSync(fileURLToPath(import.meta.url))
const entry = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]) } catch { return '' } })() : ''
if (self === entry) process.exitCode = main(process.argv.slice(2))
