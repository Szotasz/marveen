import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DREAM = readFileSync(join(ROOT, 'scheduled-tasks', 'dream-engine', 'SKILL.md'), 'utf-8')
const DOCS = readFileSync(join(ROOT, 'docs', 'dream-engine.md'), 'utf-8')
const AUTONOMY = JSON.parse(
  readFileSync(join(ROOT, 'seed-config', 'autonomy-config.json'), 'utf-8'),
) as {
  categories: Array<{
    key: string
    label: string
    level: number
    locked: boolean
    maxLevel: number
  }>
}

describe('Dream Engine external skill adoption autonomy contract', () => {
  it('ships fail-closed and caps external skill adoption at level 2', () => {
    const category = AUTONOMY.categories.find((c) => c.key === 'external_skill_adoption')
    expect(category).toEqual({
      key: 'external_skill_adoption',
      label: 'Kulso lehetosegbol alacsony kockazatu helyi skill-adaptacio',
      level: 1,
      locked: false,
      maxLevel: 2,
    })
  })

  it('makes the Dream Engine read the dedicated category and fail closed when it is absent', () => {
    expect(DREAM).toContain('external_skill_adoption')
    expect(DREAM).toContain('Ha a config vagy a kategória hiányzik, kezeld `level 1`-ként (fail closed).')
  })

  it('keeps level 1 report-only and level 2 owner-decided', () => {
    expect(DREAM).toContain('Level 1: csak jelez')
    expect(DREAM).toContain('NE módosíts skillt')
    expect(DREAM).toContain('Level 2: javasol + jóváhagyás')
    expect(DREAM).toContain('csak későbbi tulajdonosi döntés után hajtható végre')
    expect(DREAM).toContain('mode=report|propose')
  })

  it('never autonomously mutates a global skill from an external opportunity', () => {
    expect(DREAM).not.toContain('Level 3')
    expect(DREAM).not.toContain('mode=adopted')
    expect(DREAM).not.toContain('scripts/skill-index.sh')
    expect(DREAM).not.toContain('hozz létre vagy patch-elj EGY skillt')
  })

  it('documents the same owner-gated ceiling', () => {
    expect(DOCS).toContain('`external_skill_adoption`')
    expect(DOCS).toContain('alapérték `level: 1`')
    expect(DOCS).toContain('a döntés a tulajdonosé')
    expect(DOCS).toContain('legmagasabb engedélyezett szintje 2')
    expect(DOCS).toContain('nem hoz létre és nem módosít skill-fájlt önállóan')
    expect(DOCS).toContain('tulajdonosi döntés szükséges')
    expect(DOCS).not.toContain('Level 3')
  })
})
