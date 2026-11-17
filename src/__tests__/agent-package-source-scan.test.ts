import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The agent package modules decide from their inputs only: no environment
// switch and no test-run switch may change what they accept. PR-I1 is also
// pure (plan 5): the verifier and the key list touch no network and no disk;
// node:crypto is their only built-in import.

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, '..', 'web', 'agent-package')
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, readFileSync(join(DIR, f), 'utf8')] as const)

describe('src/web/agent-package source scan', () => {
  it('finds the modules', () => {
    expect(sources.map(([f]) => f).sort()).toEqual(expect.arrayContaining(['frontmatter.ts', 'keys.ts', 'verify.ts']))
  })

  it.each(sources)('%s reads no environment variable and no test-run switch', (_f, src) => {
    expect(src).not.toMatch(/process\s*\.\s*env/)
    expect(src).not.toMatch(/process\s*\[/)
    expect(src).not.toMatch(/isTestRun/)
  })

  it.each(sources.filter(([f]) => ['verify.ts', 'keys.ts', 'frontmatter.ts'].includes(f)))(
    '%s imports nothing but node:crypto and its siblings, and calls no fetch',
    (_f, src) => {
      const specifiers = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1])
      for (const s of specifiers) expect(s === 'node:crypto' || /^\.\/[a-z-]+\.js$/.test(s)).toBe(true)
      expect(src).not.toMatch(/\bimport\s*\(/)
      expect(src).not.toMatch(/\brequire\s*\(/)
      expect(src).not.toMatch(/\bfetch\s*\(/)
    },
  )
})
