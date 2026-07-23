// Tests for the shared formatting contract of the agent-scaffold generators.
// Background: generateClaudeMd() instructs the model to write Hungarian with
// proper accents and to never use an em dash. generateSoulMd() and
// generateSkillMd() used to omit that block, so the same wizard produced a
// CLAUDE.md with zero em dashes next to a SOUL.md full of them -- a file that
// violates the rule its sibling file declares.
//
// These are source-level assertions on each prompt body (the same technique as
// agent-scaffold-dashboard-origin.test.ts): the prompts are template literals
// built inside the generator, so the source is the only surface testable
// without invoking a model.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_SRC = join(__dirname, '..', 'web', 'agent-scaffold.ts')
const src = readFileSync(SCAFFOLD_SRC, 'utf-8')

function promptBodyOf(fnName: string, terminator: string): string {
  const start = src.indexOf(`export async function ${fnName}`)
  expect(start, `${fnName} not found in source`).toBeGreaterThan(0)
  const end = terminator ? src.indexOf(terminator, start) : src.length
  expect(end, `terminator for ${fnName} not found`).toBeGreaterThan(start)
  return src.slice(start, end)
}

const GENERATORS: Array<{ name: string; terminator: string }> = [
  { name: 'generateClaudeMd', terminator: 'export async function generateSoulMd' },
  { name: 'generateSoulMd', terminator: 'export async function generateSkillMd' },
  { name: 'generateSkillMd', terminator: '' },
]

describe.each(GENERATORS)('$name prompt: formatting rules', ({ name, terminator }) => {
  const body = promptBodyOf(name, terminator)

  it('declares the IMPORTANT FORMATTING RULES block', () => {
    expect(body).toContain('IMPORTANT FORMATTING RULES:')
  })

  it('requires proper Hungarian accents', () => {
    expect(body).toMatch(/proper accents \(á, é, í, ó, ö, ő, ú, ü, ű\)/)
  })

  it('forbids the em dash and names the simple hyphen as the replacement', () => {
    expect(body).toMatch(/Never use em dash \(—\), only simple hyphen \(-\)\./)
  })
})
