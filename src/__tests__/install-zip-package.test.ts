import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8')
const unquote = (token: string) => token.replace(/^(['"])(.*)\1$/, '$2')

describe('zip packages required by skills export', () => {
  it('A: skills export still runs zip; drop the package pins if this goes away', () => {
    const path = 'src/web/routes/skills.ts'
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
    let count = 0
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'runTool' && node.arguments[0]
        && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'zip') {
        count++
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(count,
      'If skills export no longer runs zip, drop these package pins').toBeGreaterThanOrEqual(1)
  })

  it('B: the Linux MISSING_PKGS loop includes zip and unzip', () => {
    const lines = read('install-linux.sh').split('\n')
    const loops = lines.flatMap((line, index) => {
      const match = line.match(/^[ \t]*for pkg in (.+); do[ \t]*\r?$/)
      if (!match) return []
      const following = lines.slice(index + 1)
      const end = following.findIndex((bodyLine) => /^[ \t]*done\b/.test(bodyLine))
      const body = end === -1 ? following : following.slice(0, end)
      return body.some((bodyLine) => !bodyLine.trim().startsWith('#')
        && bodyLine.includes('MISSING_PKGS="$MISSING_PKGS $pkg"'))
        ? [match[1]] : []
    })
    expect(loops, 'Expected exactly one package loop appending to MISSING_PKGS').toHaveLength(1)
    const packages = loops[0].trim().split(/\s+/).map(unquote)
    expect(packages, 'Linux installer must install zip for skills export').toContain('zip')
    expect(packages, 'Linux installer must install unzip for skills import').toContain('unzip')
  })

  it('C: the Docker runtime apt-get instruction includes zip and unzip', () => {
    const lines = read('Dockerfile').split('\n')
      .filter((line) => !line.trim().startsWith('#'))
    const start = lines.findIndex((line) => /^[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*\S+[ \t]+AS[ \t]+runtime[ \t]*\r?$/i.test(line))
    const following = lines.slice(start + 1)
    const end = following.findIndex((line) => /^[ \t]*FROM[ \t]/i.test(line))
    const stage = start === -1 ? undefined : (end === -1 ? following : following.slice(0, end)).join('\n')
    expect(stage, 'Expected the Docker runtime stage').toBeDefined()
    const joined = stage!.replace(/\\[ \t]*\r?\n/g, ' ')
    const installs = joined.split('\n')
      .filter((line) => /^[ \t]*RUN\b.*\bapt-get\b.*\binstall\b/i.test(line))
    expect(installs, 'Expected the runtime apt-get install instruction and apt cleanup').toHaveLength(1)
    const packageList = installs[0].match(/\bapt-get\b(?:[ \t]+-\S+)*[ \t]+install\b(.*)/i)![1].split(/&&|\|\||;|\|/)[0]
    const packages = packageList.trim().split(/\s+/)
      .filter((token) => !token.startsWith('-')).map(unquote).map((token) => token.split(/[=:]/)[0])
    expect(packages, 'Docker runtime must install zip for skills export').toContain('zip')
    expect(packages, 'Docker runtime must install unzip for skills import').toContain('unzip')
  })
})
