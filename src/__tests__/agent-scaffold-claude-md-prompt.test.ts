// Regression test for the 2026-06-01 Pap Csaba / Tanfield install incident.
//
// The "Új ismeretlen sender első üzenete (ARANYSZABÁLY)" block inside
// generateClaudeMd() prompt previously hardcoded "Marveennek" / "to":"marveen",
// even though the prompt itself is parameterised by MAIN_AGENT_ID and BOT_NAME
// elsewhere. A non-marveen-named installation (e.g. Csaba's bot named "Tanfield")
// generated CLAUDE.md files for sub-agents that told them to ping a non-existent
// 'marveen' on first-stranger-message - so the sub-agent froze waiting for an
// approval from no-one.
//
// This test reads agent-scaffold.ts as source and asserts that the prompt body
// uses the BOT_NAME / MAIN_AGENT_ID template variables. We do not invoke the LLM -
// the regression is in the prompt string, which is what we need to lock down.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

describe('generateClaudeMd: stranger-sender ARANYSZABÁLY block is bot-name agnostic', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  // Locate the prompt body that becomes the CLAUDE.md (the section we care
  // about lives inside the `generateClaudeMd` template string).
  const promptStart = src.indexOf('export async function generateClaudeMd')
  expect(promptStart, 'generateClaudeMd entry not found').toBeGreaterThan(0)
  const promptEnd = src.indexOf('export async function generateSoulMd')
  expect(promptEnd, 'generateSoulMd terminator not found').toBeGreaterThan(promptStart)
  const promptBody = src.slice(promptStart, promptEnd)

  // Find the stranger-sender block specifically; rest of the prompt may
  // legitimately mention Marveen as a proper noun in other contexts.
  const blockStart = promptBody.indexOf('## Új ismeretlen sender első üzenete')
  expect(blockStart, 'ARANYSZABÁLY block not found').toBeGreaterThan(0)
  // The block runs to the next ## header (or end of prompt).
  const restAfterBlock = promptBody.slice(blockStart + 5)
  const nextHeader = restAfterBlock.indexOf('\n## ')
  const block = promptBody.slice(blockStart, blockStart + 5 + (nextHeader > 0 ? nextHeader : restAfterBlock.length))

  it('substitutes BOT_NAME for the display name (no literal "Marveennek")', () => {
    // The proper-noun cases ("Marveennek", "Marveen visszajelzi") were the
    // first bug surface. Block must not contain the literal display name.
    expect(block).not.toMatch(/\bMarveennek\b/)
    expect(block).not.toMatch(/\bMarveen visszajelzi\b/)
    // Must use the template variable instead.
    expect(block).toContain('${BOT_NAME}')
  })

  it('substitutes MAIN_AGENT_ID for the inter-agent routing target (no literal "to":"marveen")', () => {
    // The routing case was the second surface and the load-bearing one:
    // a literal "marveen" routing target made the sub-agent ping a
    // non-existent recipient on Csaba's box.
    expect(block).not.toMatch(/"to"\s*:\s*"marveen"/i)
    // Must use the template variable.
    expect(block).toContain('${MAIN_AGENT_ID}')
  })

  it('imports BOT_NAME from config so the substitution actually resolves', () => {
    // Cheap guard: a future refactor that removes the BOT_NAME symbol from
    // the import list would leave `${BOT_NAME}` as a TS reference error,
    // but the test surfaces it explicitly.
    expect(src).toMatch(/import\s*{[^}]*\bBOT_NAME\b[^}]*}\s*from\s*'\.\.\/config\.js'/)
  })
})
