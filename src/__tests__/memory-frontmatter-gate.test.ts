import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MEMFMGATE918: nine memory files in the fleet store had a frontmatter that
// did not parse, so the harness could not read their `description` and the
// memories were RECALL-BLIND while looking "remembered" on disk. The gate
// parses the frontmatter of the file AS IT WILL STAND AFTER the Write/Edit,
// in the same step, and blocks (exit 2) when it does not parse. These tests
// pin both directions: the two measured failure shapes are caught, and
// anything outside `<...>/projects/<slug>/memory/*.md` (and MEMORY.md itself)
// passes untouched -- a gate that fired on ordinary files would be muted
// within a day.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'memory-frontmatter-gate.py')
const SCRATCH = mkdtempSync(join(tmpdir(), 'memfm-gate-'))
const MEMDIR = join(SCRATCH, '.claude', 'projects', '-Users-x-app', 'memory')
mkdirSync(MEMDIR, { recursive: true })

function run(payload: unknown): { code: number; stderr: string } {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
  try {
    execFileSync('python3', [GATE], { input, timeout: 15_000, stdio: ['pipe', 'ignore', 'pipe'] })
    return { code: 0, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer }
    return { code: typeof e.status === 'number' ? e.status : -1, stderr: e.stderr?.toString() ?? '' }
  }
}

const GOOD = '---\nname: reference_x\ndescription: "Mert allitas: ket dolog, egy mondatban"\nmetadata:\n  type: reference\n---\n\nbody\n'
// The two measured shapes from the 2026-09-18 audit (9 files):
const UNQUOTED_COLON = '---\nname: reference_x\ndescription: Ket route-meresi csapda: a literal grep vak\nmetadata:\n  type: reference\n---\n\nbody\n'
const BROKEN_QUOTE = '---\nname: reference_x\ndescription: "a "b" c"\nmetadata:\n  type: reference\n---\n\nbody\n'
const NO_DESCRIPTION = '---\nname: reference_x\nmetadata:\n  type: reference\n---\n\nbody\n'

const memPath = join(MEMDIR, 'reference_x.md')
const write = (file_path: string, content: string) => ({ tool_name: 'Write', tool_input: { file_path, content } })

describe('memory-frontmatter-gate: the measured failure shapes are blocked (exit 2, reason on stderr)', () => {
  it('unquoted description with ": " inside', () => {
    const r = run(write(memPath, UNQUOTED_COLON))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/RECALL-VAK/)
    expect(r.stderr).toMatch(/dupla idezojel/)
  })
  it('broken double-quoted description', () => {
    expect(run(write(memPath, BROKEN_QUOTE)).code).toBe(2)
  })
  it('missing description', () => {
    const r = run(write(memPath, NO_DESCRIPTION))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/description/)
  })
  it('no frontmatter at all', () => {
    expect(run(write(memPath, '# just a body\n')).code).toBe(2)
  })
})

describe('memory-frontmatter-gate: positive control and scope', () => {
  it('a well-formed memory file passes', () => {
    expect(run(write(memPath, GOOD)).code).toBe(0)
  })
  it('the same broken content OUTSIDE a memory dir passes (scope, not a doc linter)', () => {
    expect(run(write(join(SCRATCH, 'docs', 'note.md'), UNQUOTED_COLON)).code).toBe(0)
    expect(run(write(join(SCRATCH, 'memory', 'note.md'), UNQUOTED_COLON)).code).toBe(0) // no /projects/
  })
  it('MEMORY.md (the index, no frontmatter by design) passes', () => {
    expect(run(write(join(MEMDIR, 'MEMORY.md'), '- [x](reference_x.md)\n')).code).toBe(0)
  })
  it('non-markdown files in the memory dir pass', () => {
    expect(run(write(join(MEMDIR, 'notes.txt'), UNQUOTED_COLON)).code).toBe(0)
  })
})

describe('memory-frontmatter-gate: Edit is judged on the RESULTING file', () => {
  it('an Edit that breaks a good file is blocked', () => {
    const p = join(MEMDIR, 'reference_edit_break.md')
    writeFileSync(p, GOOD)
    const r = run({ tool_name: 'Edit', tool_input: { file_path: p, old_string: '"Mert allitas: ket dolog, egy mondatban"', new_string: 'Mert allitas: ket dolog' } })
    expect(r.code).toBe(2)
  })
  it('an Edit that repairs a broken file passes', () => {
    const p = join(MEMDIR, 'reference_edit_fix.md')
    writeFileSync(p, UNQUOTED_COLON)
    const r = run({ tool_name: 'Edit', tool_input: { file_path: p, old_string: 'description: Ket route-meresi csapda: a literal grep vak', new_string: 'description: "Ket route-meresi csapda: a literal grep vak"' } })
    expect(r.code).toBe(0)
  })
  it('an Edit whose old_string is absent is left to the Edit tool (exit 0)', () => {
    const p = join(MEMDIR, 'reference_edit_absent.md')
    writeFileSync(p, UNQUOTED_COLON)
    expect(run({ tool_name: 'Edit', tool_input: { file_path: p, old_string: 'nem letezik', new_string: 'x' } }).code).toBe(0)
  })
  it('a MultiEdit is applied in order before judging', () => {
    const p = join(MEMDIR, 'reference_multi.md')
    writeFileSync(p, GOOD)
    const r = run({ tool_name: 'MultiEdit', tool_input: { file_path: p, edits: [
      { old_string: 'description: "Mert allitas: ket dolog, egy mondatban"', new_string: 'description: Mert allitas: ket dolog' },
    ] } })
    expect(r.code).toBe(2)
  })
})

describe('memory-frontmatter-gate: never exit 1 (fail-open is a verdict of "not judged", not a crash)', () => {
  it('unparseable stdin -> 0', () => {
    expect(run('this is not json').code).toBe(0)
  })
  it('non-dict tool_input -> 0', () => {
    expect(run({ tool_name: 'Write', tool_input: ['x'] }).code).toBe(0)
  })
  it('Write without content -> 0', () => {
    expect(run({ tool_name: 'Write', tool_input: { file_path: memPath } }).code).toBe(0)
  })
  it('a tool the gate does not judge -> 0', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }).code).toBe(0)
  })
})
