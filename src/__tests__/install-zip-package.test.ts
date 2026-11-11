import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8')
const unquote = (token: string) => token.replace(/^(['"])(.*)\1$/, '$2')

describe('zip packages required by skills export', () => {
  it('A: skills export still runs zip; drop the package pins if this goes away', () => {
    const lines = read('src/web/routes/skills.ts').split('\n')
      .filter((line) => !['//', '/*', '*'].some((prefix) => line.trim().startsWith(prefix)))
    expect(lines.some((line) => line.includes("runTool('zip'") || line.includes('runTool("zip"')),
      'If skills export no longer runs zip, drop these package pins').toBe(true)
  })

  it('B: the Linux MISSING_PKGS loop includes zip and unzip', () => {
    const lines = read('install-linux.sh').split('\n')
    const loops = lines.flatMap((line, index) => {
      const match = line.match(/^[ \t]*for pkg in (.+); do[ \t]*\r?$/)
      if (!match) return []
      const following = lines.slice(index + 1)
      const end = following.findIndex((bodyLine) => /^[ \t]*done\b/.test(bodyLine))
      const body = end === -1 ? following : following.slice(0, end)
      return body.some((bodyLine) => bodyLine.includes('MISSING_PKGS="$MISSING_PKGS $pkg"'))
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
    const packageList = installs[0].match(/\binstall\b(.*)/i)![1].split('&&')[0]
    const packages = packageList.trim().split(/\s+/)
      .filter((token) => !token.startsWith('-')).map(unquote)
    expect(packages, 'Docker runtime must install zip for skills export').toContain('zip')
    expect(packages, 'Docker runtime must install unzip for skills import').toContain('unzip')
  })
})
