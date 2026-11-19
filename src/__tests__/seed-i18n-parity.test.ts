// DOCKERI18N1119 (Geri's v1.50.1 run): every seeded Markdown file ships in both languages. The base path is the
// Hungarian text, i18n/en/<path> the English one (scripts/lib/seed-lang.sh seed_en_rel); an install gets the version
// of its language, and a file with only one of them reaches the other language's installs untranslated (an en install
// got Hungarian skills and tasks, a hu install got English ones). This fails in CI when a seed misses its pair.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
// What the installers and the container's first boot seed from the tree (docker/first-boot.sh: templates/ and
// seed- tasks, skills/skill-factory and seed-skills; the dashboard seeds the top-level task dir).
const SEEDED = ['seed-skills', 'seed-' + 'scheduled-tasks', 'scheduled-tasks', 'templates/' + 'scheduled-tasks', 'skills/skill-factory']
// A seed that is deliberately in one language only, with the reason. Keep it empty unless there is one.
const ONE_LANGUAGE_ONLY: Record<string, string> = {}

function markdown(dir: string): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...markdown(rel))
    else if (name.endsWith('.md')) out.push(rel)
  }
  return out
}

describe('seeded Markdown files ship in both languages (DOCKERI18N1119)', () => {
  const bases = SEEDED.flatMap(markdown)
  const english = SEEDED.flatMap((d) => markdown(`i18n/en/${d}`))

  it('there are seeds to check (the scan reads the tree)', () => {
    expect(bases.length).toBeGreaterThan(20)
  })

  it('every seeded file has its English version under i18n/en/', () => {
    const missing = bases.filter((f) => !(f in ONE_LANGUAGE_ONLY) && !existsSync(join(ROOT, 'i18n', 'en', f)))
    expect(missing, 'seeds with no i18n/en/ version: translate them, or list one in ONE_LANGUAGE_ONLY with the reason').toEqual([])
  })

  it('the two versions are not the same text (a copy is not a translation)', () => {
    const same = bases.filter((f) => existsSync(join(ROOT, 'i18n', 'en', f)) && readFileSync(join(ROOT, f)).equals(readFileSync(join(ROOT, 'i18n', 'en', f))))
    expect(same).toEqual([])
  })

  it('every English version belongs to a seeded file (none is left behind after a rename)', () => {
    const orphans = english.filter((f) => !existsSync(join(ROOT, f.slice('i18n/en/'.length))))
    expect(orphans).toEqual([])
  })

  it('the exception list names only real seeds, each with a reason', () => {
    for (const [f, why] of Object.entries(ONE_LANGUAGE_ONLY)) {
      expect(bases, f).toContain(f)
      expect(why.trim().length, f).toBeGreaterThan(10)
    }
  })
})
