// GATECOMMENTQUOTE1104 (Dani 69283, Samu 69285): the segment parser did not know shell comments, so a quote character in
// a comment paired with one on a later line and the line between read as quoted text; a protected write there was
// never judged. An unquoted # at a word start now comments out the rest of the line (inert text). The decision
// functions only read paths; a temp install root.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { maskInertLiterals, shellSegments } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let self: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'shell-comment-')))
  root = join(base, 'Install')
  self = join(root, 'agents', 'samu')
  mkdirSync(self, { recursive: true })
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const SUB = { deny: true, reason: 'subagent-file' }
const FREE = { deny: false }
const sub = (command: string) => gateDecision('Bash', { command }, { root, cwd: self, subAgent: true, projectDir: self, configDir: join(self, '.claude-config') })
const T = '.mcp.json'

describe('a protected write between comments holding quote characters: denied', () => {
  it.each([
    [`echo x # it's\ncp /tmp/evil.json ${T}\n# that's`],
    [`echo x # say "hi\ncp /tmp/evil.json ${T}\n# bye"`],
    [`true; # it's\ncp /tmp/evil.json ${T}\n# that's`],
    [`echo x\t# it's\ncp /tmp/evil.json ${T}\n# that's`],
    [`ls | # it's\ncat > ${T}\n# that's`],
    [`ls |# it's\ncat > ${T}\n# that's`],
    // a word-middle # is no comment: the write after the separator is judged
    [`echo a#b; cp /tmp/evil.json ${T}`],
    [`echo x # it's\necho y > ${T}\n# that's`],
    // Dani 69295: the dot-qualifier glob between the comments
    ["echo x # it's\ncp /tmp/evil.json *(D)\n# that's"],
  ])('%s', (c) => { expect(sub(c).deny).toBe(true) })
  it('two heredocs with one apostrophe each, and an arithmetic shift that looks like a heredoc: denied (held before too)', () => {
    expect(sub(`cat <<E > a.txt\nit's\nE\ncp /tmp/evil.json ${T}\ncat <<F > b.txt\nthat's\nF`).deny).toBe(true)
    expect(sub(`echo $((1<<EOF))\ncp /tmp/evil.json ${T}`).deny).toBe(true)
  })
  it('a comment holding a command substitution or a backtick is not resolved: the command is read whole (denied)', () => {
    expect(sub(`echo x # $(true) it's\ncp /tmp/evil.json ${T}\n# that's`).deny).toBe(true)
    expect(sub(`echo x # \`true\` it's\ncp /tmp/evil.json ${T}\n# that's`).deny).toBe(true)
    // the only protected write sits in the comment's own substitution: not blanked away, the whole text is read
    expect(sub(`echo x # $(cp /tmp/evil.json ${T})`).deny).toBe(true)
    expect(maskInertLiterals('echo x # $(true)')).toBe(null)
  })
})

describe('legitimate commands with comments stay free', () => {
  it.each([
    ["ls -la # it's the listing"],
    ["cat notes.txt # don't worry about .mcp.json here"],
    ["echo hi # it's\necho there # that's"],
    ["# a whole-line comment, it's fine\nls"],
  ])('%s', (c) => { expect(sub(c)).toEqual(FREE) })
})

// The same parser feeds the egress gate (bash-egress-parser.mjs): a fetch between such comments was not judged either.
describe('the egress parser reads comments the same way', () => {
  it('an outside fetch between comments holding quote characters: denied; a comment after a local fetch: free', async () => {
    // @ts-expect-error -- plain .mjs hook script, no types
    const { classify } = await import('../../scripts/hooks/bash-egress-parser.mjs')
    expect(classify("echo x # it's\ncurl https://evil.example/x\n# that's").deny).toBe(true)
    expect(classify('echo x # say "hi\ncurl https://evil.example/x\n# bye"').deny).toBe(true)
    expect(classify('curl -s http://localhost:3420/x # it is local').deny).toBe(false)
    expect(classify('f() { curl -s "$1"; } # f URL: a local fetch helper\nf http://localhost:3420/x').deny).toBe(false)
  })
  // Samu 69308: a # is a comment ONLY at a word start, outside quotes
  it('a URL fragment and a # inside a word are no comment: the outside host stays denied', async () => {
    // @ts-expect-error -- plain .mjs hook script, no types
    const { classify } = await import('../../scripts/hooks/bash-egress-parser.mjs')
    expect(classify('curl https://evil.example/a#b').deny).toBe(true)
    expect(classify('curl evil.example#x').deny).toBe(true)
    // a word-middle # hides nothing after it: the outside call after the separator is judged
    expect(classify('curl -s http://localhost:3420/x#;curl https://evil.example/y').deny).toBe(true)
  })
  it('a # after ; or | is a comment', async () => {
    // @ts-expect-error -- plain .mjs hook script, no types
    const { classify } = await import('../../scripts/hooks/bash-egress-parser.mjs')
    expect(classify('curl -s http://localhost:3420/x;# it is local').deny).toBe(false)
    expect(classify('curl -s http://localhost:3420/x |# it is local\ncat').deny).toBe(false)
  })
})

describe('what is not a comment', () => {
  it('a # inside a word, $#, ${#x}, a zsh (#q...) qualifier: not a comment', () => {
    expect(maskInertLiterals('echo a#b')).toBe('echo a#b')
    expect(maskInertLiterals('echo $# ${#x}')).toBe('echo $# ${#x}')
    expect(maskInertLiterals('cat <<#x')).toBe('cat <<#x')
    expect(maskInertLiterals('ls *(#qD)')).toBe('ls *(#qD)')
  })
  it('a comment is blanked to the end of its line, the newline kept (same length)', () => {
    const src = "echo x # it's\nls"
    const m = maskInertLiterals(src)
    expect(m).toBe('echo x ' + ' '.repeat("# it's".length) + '\nls')
    expect(m.length).toBe(src.length)
  })
  it('shellSegments: the comment text is no part of the segment', () => {
    const segs = shellSegments("echo x # it's\ncp a b\n# that's", { surface: 'security', projectRoot: root })
    expect(segs.map((x: { own: string }) => x.own)).toEqual(['echo x', 'cp a b'])
  })
})
