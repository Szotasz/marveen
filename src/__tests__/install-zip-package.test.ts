import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8')
const withoutHashComments = (source: string) => source.replace(/#[^\n]*/g, '')

describe('zip packages required by skills export', () => {
  it('A: skills export still runs zip; drop the package pins if this goes away', () => {
    const source = read('src/web/routes/skills.ts')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    expect(source, 'If skills export no longer runs zip, drop these package pins')
      .toContain("runTool('zip'")
  })

  it('B: the Linux MISSING_PKGS loop includes zip and unzip', () => {
    const source = withoutHashComments(read('install-linux.sh'))
    const loops = [...source.matchAll(/^\s*for pkg in (.+); do\s*$([\s\S]*?)^\s*done\s*$/gm)]
      .filter((match) => /^\s*MISSING_PKGS="\$MISSING_PKGS \$pkg"\s*$/m.test(match[2]))
    expect(loops, 'Expected exactly one package loop appending to MISSING_PKGS').toHaveLength(1)
    const packages = loops[0][1].trim().split(/\s+/)
    expect(packages, 'Linux installer must install zip for skills export').toContain('zip')
    expect(packages, 'Linux installer must install unzip for skills import').toContain('unzip')
  })

  it('C: the Docker runtime apt-get instruction includes zip and unzip', () => {
    const source = withoutHashComments(read('Dockerfile'))
    const stage = source.split(/^FROM \$\{NODE_IMAGE\} AS runtime[ \t]*\r?$/m)[1]
      ?.split(/^FROM /m)[0]
    expect(stage, 'Expected the Docker runtime stage').toBeDefined()
    const joined = stage!.replace(/\\[ \t]*\r?\n/g, ' ')
    const install = joined.match(/^RUN apt-get update && apt-get install\b(.*?)&&\s*rm -rf \/var\/lib\/apt\/lists\/\*/m)
    expect(install, 'Expected the runtime apt-get install instruction and apt cleanup').not.toBeNull()
    const packages = install![1].trim().split(/\s+/)
    expect(packages, 'Docker runtime must install zip for skills export').toContain('zip')
    expect(packages, 'Docker runtime must install unzip for skills import').toContain('unzip')
  })
})
