// MARVEENGAPS1020 (d): a missing autonomy config or key must not switch a task
// to its MOST permissive level. The seed-config ships every category at level 1,
// the email approval gate falls back to level 2, and the doc plus the shipped
// kanban-audit prompt used to say "missing -> level 3 (the old behaviour)": a
// deleted or broken config armed auto-archiving and auto-nudging. Pinned on the
// two texts that state the rule, and on the seed it is meant to match.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('missing autonomy config or key: the fallback is level 1', () => {
  it('the seed-config still ships every category at level 1 (the level the fallback matches)', () => {
    const seed = JSON.parse(read('seed-config/autonomy-config.json')) as { categories: { key: string; level: number }[] }
    expect(seed.categories.length).toBeGreaterThan(0)
    expect(seed.categories.filter((c) => c.level !== 1).map((c) => c.key)).toEqual([])
  })

  it('docs/heartbeat-autonomy.md states level 1, not level 3', () => {
    const doc = read('docs/heartbeat-autonomy.md')
    expect(doc).toMatch(/Hiányzó, olvashatatlan config vagy hiányzó kulcs esetén a default az 1\. szint/)
    expect(doc).not.toMatch(/Hiányzó config vagy kulcs esetén a default a 3\. szint/)
  })

  it('the shipped kanban-audit prompt falls back to level 1 and marks no level as the default', () => {
    const skill = read('seed-scheduled-tasks/kanban-audit/SKILL.md')
    expect(skill).toMatch(/a kulcs nincs benne \(a fenti parancs semmit nem ír ki\) → level 1/)
    expect(skill).not.toMatch(/default level 3/)
    expect(skill).not.toMatch(/\(alapért\)/)
  })
})
