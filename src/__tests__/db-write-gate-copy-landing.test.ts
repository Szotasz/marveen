// CPDESTDIR1104 (Dani 69118, Samu 69122): where a copy, move, link or install LANDS is judged always. A destination
// that is only a directory names no file, so a protected file there (another agent's .mcp.json, a pattern entry) could
// be created or replaced without its name in the command. Also: a pattern directory entry covers what is inside it
// (patternRel). The decision functions only read paths; HOME points at a temp dir, nothing touches the real home.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, patternRel, TARGET_SEGMENT_NAMES } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let home: string
let root: string
let self: string
let other: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'copy-landing-')))
  home = join(base, 'home')
  root = join(base, 'Install')
  self = join(root, 'agents', 'samu')
  other = join(root, 'agents', 'geri')
  for (const d of [join(self, 'work'), join(self, 'src'), other, join(base, 'x'), join(base, 'evil', 'geri'), home]) mkdirSync(d, { recursive: true })
  writeFileSync(join(base, 'x', '.mcp.json'), '{}')
  writeFileSync(join(base, 'evil', 'geri', '.mcp.json'), '{}')
  writeFileSync(join(self, 'notes.txt'), 'x')
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const SUB = { deny: true, reason: 'subagent-file' }
const FREE = { deny: false }
const sub = (command: string, cwd = self) => gateDecision('Bash', { command: command.replaceAll('@X@', join(base, 'x')).replaceAll('@ROOT@', root).replaceAll('@B@', base) },
  { root, cwd, subAgent: true, projectDir: self, configDir: join(self, '.claude-config') })
const main = (command: string) => gateDecision('Bash', { command: command.replaceAll('@X@', join(base, 'x')).replaceAll('@ROOT@', root) },
  { root, cwd: root, subAgent: false, projectDir: root, configDir: null })

describe("a protected file's directory as the destination: denied (Dani's rows)", () => {
  it.each([
    'cp @X@/.mcp.json ../geri/',
    'cp @X@/.mcp.json @ROOT@/agents/geri/',
    'mv @X@/.mcp.json ../geri/',
    'cp @X@/.mcp.json ../geri',
    'install -m 644 @X@/.mcp.json ../geri/',
    'ln @X@/.mcp.json ../geri/',
    'ln -s @X@/.mcp.json ../geri/',
    'rsync @X@/.mcp.json ../geri/',
    'cp -t ../geri/ @X@/.mcp.json',
    'cp --target-directory=../geri @X@/.mcp.json',
    'cp notes.txt @X@/.mcp.json ../geri/',
    'cd .. && cp @X@/.mcp.json geri/',
  ])('%s', (c) => { expect(sub(c)).toEqual(SUB) })
  it('the named form stays denied (control)', () => {
    expect(sub('cp @X@/.mcp.json ../geri/.mcp.json')).toEqual(SUB)
  })
  it('a link made in the cwd under the protected name: ln -s with one operand, from another agent dir', () => {
    expect(sub('cd ../geri && ln -s @X@/.mcp.json')).toEqual(SUB)
  })
})

describe('a directory landing ON a protected path: recursive copy, content copy, extraction', () => {
  it.each([
    'cp -r @B@/evil/geri ../',
    'cp -R @B@/evil/geri @ROOT@/agents/',
    'mv @B@/evil/geri @ROOT@/agents/',
    'rsync -a @B@/evil/geri/ ../geri/',
    'cp -r @B@/evil/geri/. ../geri/',
    'ditto @B@/evil/geri ../geri',
    'tar -xf @B@/a.tar -C ../geri',
    'tar -x -f @B@/a.tar --directory=../geri',
    'unzip @B@/a.zip -d ../geri',
    'cd ../geri && tar -xf @B@/a.tar',
  ])('%s', (c) => {
    // a common-list pattern (agents/*/.claude/settings.json) may be the first one reached: deny, by either list
    expect(sub(c).deny).toBe(true)
  })
})

describe('legitimate work stays free', () => {
  it.each([
    'cp notes.txt ../geri/',
    'cp notes.txt work/',
    'cp a b',
    'cp -r src work/',
    'mv notes.txt work/',
    'mv old new',
    'cp @X@/.mcp.json /tmp/bk-copy.json',
    'cp @X@/.mcp.json @B@/backup/',
    'rsync -a src/ work/',
    'tar -xf @B@/a.tar -C work/',
    'ln -s ../work/x work/link',
  ])('%s', (c) => { expect(sub(c)).toEqual(FREE) })
  it('the main agent is not on the sub-agent list', () => {
    expect(main('cp @X@/.mcp.json agents/geri/')).toEqual(FREE)
  })
})

describe('the own directory, by design', () => {
  it("an extraction or a content copy into the agent's OWN directory is denied (it could lay its own .mcp.json)", () => {
    expect(sub('tar -xf @B@/a.tar').deny).toBe(true)
    expect(sub('rsync -a @B@/evil/geri/ .').deny).toBe(true)
  })
  it('a plain copy into its own directory under a free name stays free', () => {
    expect(sub('cp @B@/x/.mcp.json ./backup.json')).toEqual(FREE)
  })
})

// Dani B2 / Samu 69132: a bare tree name from its parent directory is a candidate word.
describe('a bare start-loaded tree name from its parent: denied', () => {
  beforeEach(() => { for (const d of ['skills', 'agents', 'hooks']) mkdirSync(join(home, '.claude', d), { recursive: true }) })
  it.each([
    'cd ~/.claude && rm -rf skills',
    'cd ~/.claude && mv @B@/x agents',
    'cd ~/.claude && cp -r @B@/x skills',
    'cd ~/.claude && rm -rf hooks',
  ])('%s', (c) => { expect(sub(c).deny).toBe(true) })
  it('reads from there stay free', () => {
    expect(sub('cd ~/.claude && ls skills')).toEqual(FREE)
  })
  it('the five names are candidates (rules, commands, output-styles have no entry yet: INSTRFILES1104)', () => {
    for (const n of ['rules', 'skills', 'agents', 'commands', 'output-styles']) expect(TARGET_SEGMENT_NAMES.has(n)).toBe(true)
  })
})

describe('patternRel: a pattern entry against a key', () => {
  const t = (rel: string, dir = false) => ({ key: [rel, rel.toLowerCase()], dir, pattern: true })
  const k = (p: string) => [p, p.toLowerCase()]
  it('exact, under (dir entries only), ancestor, none', () => {
    expect(patternRel(k('/r/agents/geri/.mcp.json'), t('/r/agents/*/.mcp.json'))).toBe('exact')
    expect(patternRel(k('/r/agents/geri/.claude/rules/x.md'), t('/r/agents/*/.claude/rules', true))).toBe('under')
    expect(patternRel(k('/r/agents/geri/.claude/rules/x.md'), t('/r/agents/*/.claude/rules'))).toBe(null)
    expect(patternRel(k('/r/agents/geri'), t('/r/agents/*/.mcp.json'))).toBe('ancestor')
    expect(patternRel(k('/r/agents'), t('/r/agents/*/.mcp.json'))).toBe('ancestor')
    expect(patternRel(k('/r/other/geri'), t('/r/agents/*/.mcp.json'))).toBe(null)
    expect(patternRel(k('/r/agents/geri/x.json'), t('/r/agents/*/.mcp.json'))).toBe(null)
  })
  it('the case-folded form matches too', () => {
    expect(patternRel(['/R/Agents/Geri/.MCP.json', '/r/agents/geri/.mcp.json'], t('/r/agents/*/.mcp.json'))).toBe('exact')
  })
})
