import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'skill-index.sh')

function makeSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

function runScript(args: string[], env: Record<string, string>): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`bash "${SCRIPT}" ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    })
    return { stdout, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number }
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 }
  }
}

describe('skill-index.sh -- no-arg mode (backward compat)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-alpha'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-alpha', 'SKILL.md'),
      makeSkillMd('skill-alpha', 'Global skill alpha description'),
    )
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes the index to ~/.claude/skills/.skill-index.md', () => {
    runScript([], { HOME: tmpHome })
    const indexPath = join(tmpHome, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(indexPath)).toBe(true)
  })

  it('includes global skill in the index', () => {
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-alpha')
    expect(content).toContain('Global skill alpha description')
  })

  it('uses the two-column table format (no Scope column)', () => {
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('| Skill | Leírás |')
    expect(content).not.toContain('| Scope |')
  })

  it('does NOT create an index in any other directory', () => {
    const agentDir = join(tmpHome, 'agents', 'agent-a')
    mkdirSync(join(agentDir, '.claude', 'skills', 'skill-beta'), { recursive: true })
    writeFileSync(
      join(agentDir, '.claude', 'skills', 'skill-beta', 'SKILL.md'),
      makeSkillMd('skill-beta', 'Agent-specific skill beta'),
    )
    runScript([], { HOME: tmpHome })
    const agentIndex = join(agentDir, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(agentIndex)).toBe(false)
  })
})

describe('skill-index.sh -- description truncation', () => {
  let tmpHome: string

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  // `cut -c` in GNU coreutils counts bytes, not characters, even under a UTF-8
  // locale. A description of accented text long enough to hit the 120 cut then
  // loses its last character mid-encoding, and the index every agent reads
  // carries a broken byte.
  it('truncates a long accented description without splitting a character', () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-accents'), { recursive: true })
    // 'é' is two bytes, so a byte-cut at 120 lands inside a character.
    const longAccented = 'é'.repeat(200)
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-accents', 'SKILL.md'),
      makeSkillMd('skill-accents', longAccented),
    )

    runScript([], { HOME: tmpHome })

    const raw = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'))
    // A replacement char means the bytes did not decode: the cut split a char.
    expect(raw.toString('utf-8')).not.toContain('\uFFFD')
    expect(raw.toString('utf-8')).toContain('é'.repeat(120))
  })
})

// IDXBLOCK1118: the description was read with `grep -m1 "^description:"`, so a
// YAML block scalar (`description: >` / `|` with the text on the next lines)
// went into the Level 0 index as a lone ">" or "|" and the skill could not be
// found by keyword. Measured on the live install: 10+ project skills
// (blog-writer, fact-checker, keyword-clusterer, ...).
describe('skill-index.sh -- description forms (IDXBLOCK1118)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  // Writes one skill whose frontmatter lines are given verbatim (after `name:`),
  // runs the script and returns the description cell of that skill's index row.
  // The body carries a second `description:` line on purpose: it must never win.
  function descOf(frontmatter: string): string {
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-x'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-x', 'SKILL.md'),
      `---\nname: skill-x\n${frontmatter}---\n\n# skill-x\n\ndescription: body line, not frontmatter\n`,
    )
    runScript([], { HOME: tmpHome })
    const content = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    const row = content.split('\n').find((l) => l.startsWith('| `skill-x` |'))
    expect(row).toBeDefined()
    return row!.slice('| `skill-x` | '.length, -' |'.length)
  }

  it('keeps a plain one-line description as it was', () => {
    expect(descOf('description: Plain one-line description\n')).toBe('Plain one-line description')
  })

  it('drops the quotes of a quoted description, as before', () => {
    expect(descOf('description: "Quoted: with a colon"\n')).toBe('Quoted: with a colon')
    expect(descOf("description: 'Single quoted'\n")).toBe('Single quoted')
  })

  it('keeps an accented one-line description intact', () => {
    expect(descOf('description: Árvíztűrő tükörfúrógép, ékezetes leírás\n')).toBe('Árvíztűrő tükörfúrógép, ékezetes leírás')
  })

  it('folds a `>` block scalar into one line instead of ">"', () => {
    expect(descOf('description: >\n  Folded block\n  on two lines.\nlicense: MIT\n')).toBe('Folded block on two lines.')
  })

  it('reads a `>-` block scalar', () => {
    expect(descOf('description: >-\n  Strip-chomped folded\n  text, ékezettel.\n')).toBe('Strip-chomped folded text, ékezettel.')
  })

  it('joins a `|` literal block scalar onto one table line', () => {
    const d = descOf('description: |\n  First line.\n\n  Second paragraph.\nallowed-tools: Bash\n')
    expect(d).toBe('First line. Second paragraph.')
    expect(d).not.toContain('|')
  })

  it('cuts a long block scalar at 120 characters without splitting an accented one', () => {
    const d = descOf(`description: >\n  ${'é'.repeat(70)}\n  ${'ő'.repeat(70)}\n`)
    expect(d).toBe('é'.repeat(70) + ' ' + 'ő'.repeat(49))
    expect(d).not.toContain('�')
  })

  it('writes the placeholder when the frontmatter has no description', () => {
    expect(descOf('license: MIT\n')).toBe('(nincs leírás)')
  })
})

describe('skill-index.sh -- AGENT_DIR mode (merged index)', () => {
  let tmpHome: string
  let agentDir: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    // Global skill
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-global'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-global', 'SKILL.md'),
      makeSkillMd('skill-global', 'A global skill visible to all agents'),
    )
    // Agent-specific skill
    agentDir = join(tmpHome, 'agents', 'agent-a')
    mkdirSync(join(agentDir, '.claude', 'skills', 'skill-local'), { recursive: true })
    writeFileSync(
      join(agentDir, '.claude', 'skills', 'skill-local', 'SKILL.md'),
      makeSkillMd('skill-local', 'An agent-local skill for agent-a only'),
    )
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes the merged index to <AGENT_DIR>/.claude/skills/.skill-index.md', () => {
    runScript([agentDir], { HOME: tmpHome })
    const indexPath = join(agentDir, '.claude', 'skills', '.skill-index.md')
    expect(existsSync(indexPath)).toBe(true)
  })

  it('includes global skill in the merged index', () => {
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-global')
    expect(content).toContain('A global skill visible to all agents')
  })

  it('includes agent-specific skill in the merged index', () => {
    // This is the core regression test: fails when AGENT_DIR handling is removed
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('skill-local')
    expect(content).toContain('An agent-local skill for agent-a only')
  })

  it('labels global and agent-specific skills with scope', () => {
    runScript([agentDir], { HOME: tmpHome })
    const content = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    expect(content).toContain('| global |')
    expect(content).toContain('| agent |')
  })

  it('does NOT modify the global index when running in agent mode', () => {
    const globalIndexPath = join(tmpHome, '.claude', 'skills', '.skill-index.md')
    // Ensure there is no stale global index before the run
    expect(existsSync(globalIndexPath)).toBe(false)
    runScript([agentDir], { HOME: tmpHome })
    expect(existsSync(globalIndexPath)).toBe(false)
  })

  it('creates agent .claude/skills/ directory if it does not exist yet', () => {
    const freshAgentDir = join(tmpHome, 'agents', 'agent-b')
    // Only the agent dir exists, no .claude/skills/ inside
    mkdirSync(freshAgentDir, { recursive: true })
    runScript([freshAgentDir], { HOME: tmpHome })
    expect(existsSync(join(freshAgentDir, '.claude', 'skills', '.skill-index.md'))).toBe(true)
  })

  it('two different agents get independent indexes with their own agent-local skills', () => {
    // agent-b has a different local skill
    const agentBDir = join(tmpHome, 'agents', 'agent-b')
    mkdirSync(join(agentBDir, '.claude', 'skills', 'skill-b-only'), { recursive: true })
    writeFileSync(
      join(agentBDir, '.claude', 'skills', 'skill-b-only', 'SKILL.md'),
      makeSkillMd('skill-b-only', 'Only for agent-b'),
    )

    runScript([agentDir], { HOME: tmpHome })
    runScript([agentBDir], { HOME: tmpHome })

    const indexA = readFileSync(join(agentDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')
    const indexB = readFileSync(join(agentBDir, '.claude', 'skills', '.skill-index.md'), 'utf-8')

    // agent-a sees skill-local but not skill-b-only
    expect(indexA).toContain('skill-local')
    expect(indexA).not.toContain('skill-b-only')

    // agent-b sees skill-b-only but not skill-local
    expect(indexB).toContain('skill-b-only')
    expect(indexB).not.toContain('skill-local')

    // both see the global skill
    expect(indexA).toContain('skill-global')
    expect(indexB).toContain('skill-global')
  })
})

describe('skill-index.sh -- graceful handling of missing global dir', () => {
  it('exits cleanly when ~/.claude/skills does not exist', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    try {
      const { exitCode } = runScript([], { HOME: emptyHome })
      expect(exitCode).toBe(0)
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })
})
