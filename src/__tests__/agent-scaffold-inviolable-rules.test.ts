// Guard for the two inviolable rules that a refactor can silently drop.
//
// Context (2026-08-27). The fleet rules baked into every generated colleague
// CLAUDE.md were split: install-agnostic hygiene moved to the global
// `fleet-hygiene` skill, owner-specific policy stayed in the generator. The
// split lost two rules on the way -- they were in neither place:
//
//   - send-approval: a colleague assistant drafts, and only the principal's
//     explicit, per-message approval may actually send anything;
//   - flag-and-wait: work that missed its window is reported to the principal,
//     not silently voided or silently made up later.
//
// Both are owner policy, not hygiene, so the skill is the wrong home for them.
// Losing the first is the expensive one: every colleague assistant handles mail,
// so an agent generated without it can mail on its principal's behalf believing
// that is the job.
//
// Nothing guarded this, which is why it survived review. The test reads the
// generator as SOURCE and asserts the prompt body still carries both rules --
// the same technique as agent-scaffold-claude-md-prompt.ts, and for the same
// reason: the regression lives in a prompt string, not in behaviour we can
// exercise without calling the LLM.
//
// If a later refactor moves these rules somewhere better, update the test to
// look there. Do not delete it: the point is that SOME place must own them.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

describe('generateClaudeMd: the inviolable rules survive refactors', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  it('keeps the send-approval rule (draft by default, principal approves each message)', () => {
    expect(src).toContain('DRAFT-ONLY')
    // The teeth of the rule, not just its title: an instruction to "tell X"
    // must not be read as permission to send.
    expect(src).toMatch(/DRAFTOT jelent, NEM küldést/)
  })

  it('keeps the flag-and-wait rule (report the miss, do not decide alone)', () => {
    expect(src).toContain('Flag-and-wait')
    expect(src).toMatch(/VÁRD meg a döntését/)
  })

  it('states that the system source code stays off limits to colleague agents', () => {
    // The 2026-07-08 wording: colleagues MAY build their own tooling, but the
    // running system's source is the owner's call. Both halves matter -- an
    // agent told only "do not develop" stops solving its own problems.
    expect(src).toContain('FEJLESZTHETSZ a saját munkádhoz')
    expect(src).toMatch(/RENDSZER forráskódját viszont NEM fejleszted/)
  })

  it('points at the fleet-hygiene skill for the rules that moved out', () => {
    // The split is only safe if the generated file SAYS where the rest lives;
    // otherwise an agent reads three rules and assumes that is all of them.
    expect(src).toContain('fleet-hygiene')
  })
})
