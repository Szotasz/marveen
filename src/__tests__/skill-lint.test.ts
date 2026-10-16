// SKILLRULES1001: scripts/skill-lint.mjs, the checker for Anthropic's "Skill
// authoring best practices". Every rule has a BAD fixture (must be flagged) and
// a GOOD one (must not be), the boundaries are pinned on both sides, and the
// CLI's contract is driven as a real process: human and --json output, exit 0
// on a clean tree, 1 on a finding, 2 on a usage error. The linter only reports:
// a test also pins that a run leaves the files byte-for-byte as they were.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  lintSkill, lintPath, findSkills, hasTableOfContents, skillBody, lineCount,
  SKILL_MD_MAX_BODY_LINES, REFERENCE_TOC_THRESHOLD,
// @ts-expect-error -- plain .mjs script, no types
} from '../../scripts/skill-lint.mjs'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'skill-lint.mjs')
const FM = '---\nname: demo\ndescription: A demo skill.\n---\n'

/** A skill folder from a { relativePath: content } map. */
function skill(files: Record<string, string>, root = mkdtempSync(join(tmpdir(), 'skill-lint-'))) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
const rules = (dir: string) => (lintSkill(dir) as Array<{ rule: string; file: string }>).map((f) => `${f.rule}:${f.file}`).sort()

describe('skill-md-too-long', () => {
  it('a body of 500 lines passes; 501 is flagged', () => {
    expect(rules(skill({ 'SKILL.md': FM + lines(SKILL_MD_MAX_BODY_LINES) }))).toEqual([])
    expect(rules(skill({ 'SKILL.md': FM + lines(SKILL_MD_MAX_BODY_LINES + 1) }))).toEqual(['skill-md-too-long:SKILL.md'])
  })
  it('the frontmatter does not count toward the body', () => {
    const longFm = '---\nname: demo\ndescription: |\n' + lines(30, '  d') + '---\n'
    expect(rules(skill({ 'SKILL.md': longFm + lines(SKILL_MD_MAX_BODY_LINES) }))).toEqual([])
    expect(lineCount(skillBody(FM + 'a\nb\n'))).toBe(2)
    expect(lineCount(skillBody('no frontmatter\n'))).toBe(1)
  })
})

describe('reference-missing-toc', () => {
  const ref = (body: string) => skill({ 'SKILL.md': FM + 'See [ref](references/guide.md).\n', 'references/guide.md': body })
  it('101 lines without a table of contents is flagged; 100 is not', () => {
    expect(rules(ref('# Guide\n' + lines(REFERENCE_TOC_THRESHOLD)))).toEqual(['reference-missing-toc:references/guide.md'])
    expect(rules(ref('# Guide\n' + lines(REFERENCE_TOC_THRESHOLD - 1)))).toEqual([])
  })
  it('a "Contents" heading or three in-file anchor links near the top is a table of contents', () => {
    expect(rules(ref('# Guide\n\n## Contents\n- Setup\n- Usage\n' + lines(120)))).toEqual([])
    expect(rules(ref('# Guide\n\n- [A](#a)\n- [B](#b)\n- [C](#c)\n' + lines(120)))).toEqual([])
    expect(hasTableOfContents('## Tartalomjegyzék\n')).toBe(true)
    expect(hasTableOfContents('# Guide\n- [A](#a)\n- [B](#b)\n')).toBe(false)
  })
  it('a heading past the first 40 lines does not count', () => {
    expect(rules(ref('# Guide\n' + lines(50) + '## Contents\n' + lines(60)))).toEqual(['reference-missing-toc:references/guide.md'])
  })
  it('only references/ markdown is checked (a long script or a root note is not)', () => {
    expect(rules(skill({ 'SKILL.md': FM + 'Run `scripts/a.sh`. See [n](notes.md).\n', 'scripts/a.sh': lines(300), 'notes.md': lines(300) }))).toEqual([])
  })
})

describe('nested-reference', () => {
  it('SKILL.md -> a.md -> b.md, with no link from SKILL.md to b.md, is flagged', () => {
    const dir = skill({
      'SKILL.md': FM + 'Read [advanced](references/advanced.md).\n',
      'references/advanced.md': 'For more, see [details](details.md).\n',
      'references/details.md': 'Details.\n',
    })
    expect(rules(dir)).toEqual(['nested-reference:references/details.md'])
  })
  it('the same files, with SKILL.md linking both, pass', () => {
    const dir = skill({
      'SKILL.md': FM + 'Read [advanced](references/advanced.md) and [details](references/details.md).\n',
      'references/advanced.md': 'For more, see [details](details.md).\n',
      'references/details.md': 'Details.\n',
    })
    expect(rules(dir)).toEqual([])
  })
  it('a backticked path in a reached file is a reference too', () => {
    const dir = skill({
      'SKILL.md': FM + 'Read [guide](references/guide.md).\n',
      'references/guide.md': 'Then run `scripts/fill.py`.\n',
      'scripts/fill.py': 'print(1)\n',
    })
    expect(rules(dir)).toEqual(['nested-reference:scripts/fill.py'])
  })
  it('files that refer to each other off the SKILL.md path are not flagged (README -> LICENSE)', () => {
    const dir = skill({ 'SKILL.md': FM + 'Body.\n', 'README.md': 'See [LICENSE](LICENSE).\n', LICENSE: 'MIT\n' })
    expect(rules(dir)).toEqual([])
  })
})

describe('missing-reference', () => {
  it('a relative link to a file that is not there is flagged', () => {
    expect(rules(skill({ 'SKILL.md': FM + 'See [forms](FORMS.md).\n' }))).toEqual(['missing-reference:SKILL.md'])
  })
  it('a link to an existing file or folder passes', () => {
    expect(rules(skill({ 'SKILL.md': FM + 'See [forms](FORMS.md) and [refs](references/).\n', 'FORMS.md': 'x\n', 'references/a.md': 'y\n' }))).toEqual([])
  })
  it('links in code (fenced or inline), URLs, anchors and absolute paths are not skill references', () => {
    const md = FM + '```\n[x](missing-in-fence.md)\n```\nInline `[t](url)`. Web [doc](https://example.com/a.md), [top](#top), [abs](/etc/hosts), [home](~/x.md).\n'
    expect(rules(skill({ 'SKILL.md': md }))).toEqual([])
  })
  it('a backticked path is NOT required to exist (in many skills `scripts/x.sh` names the install\'s own scripts)', () => {
    expect(rules(skill({ 'SKILL.md': FM + 'Run `scripts/kartya-es-ertesites.py`.\n' }))).toEqual([])
  })
})

describe('finding skills', () => {
  it('a folder with a SKILL.md is one skill; a root yields every skill under it, skipping node_modules and dot-folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-lint-root-'))
    skill({ 'SKILL.md': FM }, join(root, 'a'))
    skill({ 'SKILL.md': FM }, join(root, 'group', 'b'))
    skill({ 'SKILL.md': FM }, join(root, 'node_modules', 'c'))
    skill({ 'SKILL.md': FM }, join(root, '.hidden', 'd'))
    expect((findSkills(root) as string[]).map((p) => p.slice(root.length + 1)).sort()).toEqual(['a', join('group', 'b')])
    expect(findSkills(join(root, 'a'))).toEqual([join(root, 'a')])
    expect(lintPath(root)).toMatchObject({ skills_checked: 2, ok: true, findings: [] })
  })
})

describe('symlinks (Samu, #1666 review): every folder once, by its real path', () => {
  // The cases that HUNG before the fix run the CLI in a child process with a
  // timeout: the linter is synchronous, so an in-process regression would hold
  // the whole job until its own timeout instead of failing here (Samu, #1667).
  const lintCli = (dir: string) => {
    const r = spawnSync('node', [SCRIPT, dir, '--json'], { encoding: 'utf-8', timeout: 20_000 })
    expect(r.error, 'the linter did not finish within 20 s (a symlink loop is being walked)').toBeUndefined()
    return { status: r.status, report: JSON.parse(r.stdout) as { skills_checked: number; findings: Array<{ rule: string; file: string }>; ok: boolean } }
  }
  it('a loop back to the root and a skill reachable twice are counted once each; a link OUT of the root is not walked', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-lint-links-'))
    skill({ 'SKILL.md': FM }, join(root, 'a'))
    skill({ 'SKILL.md': FM }, join(root, 'real', 'b'))
    symlinkSync(root, join(root, 'a', 'loop-up'))
    symlinkSync(join(root, 'real', 'b'), join(root, 'b-link'))
    const outside = mkdtempSync(join(tmpdir(), 'skill-lint-outside-'))
    skill({ 'SKILL.md': FM }, join(outside, 'not-mine'))
    symlinkSync(outside, join(root, 'group-link'))
    const { status, report } = lintCli(root)
    expect(status).toBe(0)
    expect(report).toMatchObject({ skills_checked: 2, ok: true, findings: [] })
  })
  it('a symlinked skill folder under a root is still checked', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-lint-linked-skill-'))
    const real = skill({ 'SKILL.md': FM + 'See [x](x.md).\n' })
    symlinkSync(real, join(root, 'linked'))
    expect((lintPath(root).findings as Array<{ rule: string }>).map((f) => f.rule)).toEqual(['missing-reference'])
  })
  it('cycles and a self-link inside a skill: no crash, the real files counted once', () => {
    const dir = skill({ 'SKILL.md': FM + 'See [r](references/r.md).\n', 'references/r.md': 'hi\n' })
    symlinkSync('../..', join(dir, 'references', 'kor'))
    symlinkSync('.', join(dir, 'references', 'here'))
    symlinkSync('self', join(dir, 'self'))
    const { status, report } = lintCli(dir)
    expect(status).toBe(0)
    expect(report).toMatchObject({ skills_checked: 1, ok: true, findings: [] })
  })
  it('a symlink that stays inside the skill is followed (its files count)', () => {
    const dir = skill({ 'SKILL.md': FM + 'Read [a](references/a.md).\n', 'references/a.md': 'See [b](more/b.md).\n', 'docs/b.md': 'B\n' })
    symlinkSync(join(dir, 'docs'), join(dir, 'references', 'more'))
    // reported under the file's real name (docs/b.md), reached through the link
    expect(rules(dir)).toEqual(['nested-reference:docs/b.md'])
  })
})

describe('the CLI', () => {
  const run = (...args: string[]) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf-8' })
  it('a clean skill: exit 0 and a summary line', () => {
    const r = run(skill({ 'SKILL.md': FM + 'Body.\n' }))
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/skill-lint: 1 skill\(s\) checked, 0 finding\(s\)/)
  })
  it('a finding: exit 1, the human line names file and rule; --json carries the same', () => {
    const dir = skill({ 'SKILL.md': FM + 'See [forms](FORMS.md).\n' })
    const h = run(dir)
    expect(h.status).toBe(1)
    expect(h.stdout).toMatch(/SKILL\.md: \[missing-reference\] links to "FORMS\.md"/)
    const j = run(dir, '--json')
    expect(j.status).toBe(1)
    const rep = JSON.parse(j.stdout)
    expect(rep).toMatchObject({ skills_checked: 1, ok: false })
    expect(rep.findings).toEqual([expect.objectContaining({ rule: 'missing-reference', file: 'SKILL.md' })])
  })
  it('usage errors: exit 2 (no argument, not a directory)', () => {
    expect(run().status).toBe(2)
    expect(run('/nincs/ilyen/konyvtar').status).toBe(2)
  })
  it('it only reports: the files are byte-for-byte unchanged after a run with findings', () => {
    const dir = skill({ 'SKILL.md': FM + lines(600) + 'See [x](x.md).\n', 'references/long.md': lines(200) })
    const before = readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, (() => { try { return readFileSync(join(dir, f), 'utf-8') } catch { return 'DIR' } })()])
    expect(run(dir).status).toBe(1)
    const after = readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, (() => { try { return readFileSync(join(dir, f), 'utf-8') } catch { return 'DIR' } })()])
    expect(after).toEqual(before)
  })
})

describe('the shipped skills pass their own rules', () => {
  it('skills/ and scheduled-tasks/ in this repo: no finding', () => {
    const root = join(__dirname, '..', '..')
    expect(lintPath(join(root, 'skills')).findings).toEqual([])
    expect(lintPath(join(root, 'scheduled-tasks')).findings).toEqual([])
  })
})
