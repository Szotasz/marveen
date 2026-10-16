import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'
import { projectsDirFor } from '../web/active-model.js'
import { buildContinueProbeCommand } from '../web/ssh-tmux.js'

// UTKODOLODIVERG922. The rule is MEASURED, not derived: Claude Code 2.1.278,
// scratch working dirs with a throwaway CLAUDE_CONFIG_DIR, the directory the
// CLI created read back (2026-09-22). Both probe shapes are pinned verbatim.
describe('encodeClaudeProjectDir: the measured Claude Code rule', () => {
  it('turns underscore, space, +, @, ., ~ into one dash each (probe 1)', () => {
    expect(encodeClaudeProjectDir('/tmp/scratchpad/enc_probe dir+plus@at.v2~x'))
      .toBe('-tmp-scratchpad-enc-probe-dir-plus-at-v2-x')
  })

  it('keeps one dash per code point, no run-collapsing, accented letters included (probe 2)', () => {
    // "enc__two  sp.éÁ-Z9": __ -> --, two spaces -> --, ".éÁ-" -> "----"
    expect(encodeClaudeProjectDir('/tmp/scratchpad/enc__two  sp.éÁ-Z9'))
      .toBe('-tmp-scratchpad-enc--two--sp----Z9')
  })

  it('starts with a dash because the leading "/" is encoded too', () => {
    expect(encodeClaudeProjectDir('/Users/x/ClaudeClaw')).toBe('-Users-x-ClaudeClaw')
  })
})

// The GATE Marveen asked for (msg 27995): on the common subset -- every path
// made only of [a-zA-Z0-9-/.] -- the shared encoder is a NO-OP relative to the
// two rules it replaces. The fleet's own paths and the #1445 author's
// (/Users/a.kobza/marveen) all live there, so nothing changes on any install
// that exists today by so much as one character.
const oldSlashDot = (p: string): string => p.replace(/[/.]/g, '-')
const oldSlashOnly = (p: string): string => p.replace(/\//g, '-')

const FLEET_PATHS = [
  '/Users/marvin/ClaudeClaw',
  '/Users/marvin/ClaudeClaw/agents/samu',
  '/Users/marvin/ClaudeClaw/agents/davinci-ocura',
  '/root/marveen-develop-test',
  '/home/marveen/marveen',
  '/Users/a.kobza/marveen',
  '/private/tmp/claude-501/-Users-marvin-ClaudeClaw-agents-samu/6f27da8f-66fa-4977-92fa-98b9b3b794aa/scratchpad',
]

describe('encodeClaudeProjectDir: no-op on the common subset', () => {
  it('equals the old "/ and ." rule on every fleet path', () => {
    for (const p of FLEET_PATHS) expect(encodeClaudeProjectDir(p)).toBe(oldSlashDot(p))
  })

  it('equals the old "/ only" rule on every fleet path without a dot', () => {
    for (const p of FLEET_PATHS.filter((p) => !p.includes('.'))) {
      expect(encodeClaudeProjectDir(p)).toBe(oldSlashOnly(p))
    }
  })

  it('equals the old "/ and ." rule on every generated [a-zA-Z0-9-/.] path', () => {
    const alphabet = 'abcXYZ019-/.'
    let seed = 42
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let n = 0; n < 2000; n++) {
      let p = '/'
      const len = 1 + (next() % 40)
      for (let i = 0; i < len; i++) p += alphabet[next() % alphabet.length]
      expect(encodeClaudeProjectDir(p)).toBe(oldSlashDot(p))
    }
  })

  it('and DIVERGES from both old rules exactly where Claude Code does', () => {
    const p = '/home/john_doe/my app/marveen'
    expect(encodeClaudeProjectDir(p)).toBe('-home-john-doe-my-app-marveen')
    expect(oldSlashDot(p)).toBe('-home-john_doe-my app-marveen')
    expect(oldSlashOnly(p)).toBe('-home-john_doe-my app-marveen')
  })
})

describe('the call sites go through the shared encoder', () => {
  it('projectsDirFor encodes with the measured rule', () => {
    expect(projectsDirFor('/home/john_doe/my app', '/cfg', '/home/john_doe'))
      .toBe(join('/cfg', 'projects', '-home-john-doe-my-app'))
  })

  it('the remote --continue probe encodes with the measured rule', () => {
    expect(buildContinueProbeCommand('/home/john_doe/my app')).toContain("'-home-john-doe-my-app'")
  })

  it('no hand-rolled project-dir encoder is left in src/ outside the shared module', () => {
    // A second copy is how the two rules drifted apart in the first place.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) { if (entry !== '__tests__') walk(full); continue }
        if (!entry.endsWith('.ts') || full.endsWith('claude-project-dir.ts')) continue
        const src = readFileSync(full, 'utf-8')
        for (const [i, line] of src.split('\n').entries()) {
          if (line.trimStart().startsWith('//')) continue
          if (/replace\(\/\\\/\/g, '-'\)|replace\(\/\[\/\.\]\/g, '-'\)|\[\^a-zA-Z0-9-\]/.test(line)) offenders.push(`${full}:${i + 1}`)
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })
})
