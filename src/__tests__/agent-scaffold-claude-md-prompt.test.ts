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

describe('deferred MCP tool hint (FLEETDEFER809)', () => {
  const SRC = readFileSync(SCAFFOLD_PATH, 'utf-8')
  // The load-bearing rule: a deferred tool's failed direct call must not be
  // read as absence. Without this section an agent whose scaffold predates
  // deferred loading reports "not available" while the tool sits in its own
  // deferred list (measured: HBCALMCP808, a full day of empty calendar rounds).
  it('the shared scaffold teaches select-then-keyword ToolSearch before claiming absence', () => {
    expect(SRC).toContain('deferred betöltése (FLEETDEFER809)')
    expect(SRC).toContain('select:<tool_nev>')
    // keyword fallback is part of the contract: server names differ per install
    expect(SRC).toMatch(/KULCSSZÓVAL/)
    // absence may only be claimed after the keyword search also failed
    expect(SRC).toMatch(/Csak akkor mondd ki a hiányt/)
  })
})

describe('a sablon nem allit autonomia-szintet, odakuld a confighoz', () => {
  const SRC = readFileSync(SCAFFOLD_PATH, 'utf-8')
  // A scaffold minden uj agens CLAUDE.md-jebe beirta, hogy
  // `memory_maintenance = level 3, AUTONOM`, mikozben a szintet a
  // store/autonomy-config.json dönti el. Minden uj kollega tehat egy
  // MEGENGEDOBB szaballyal szuletett, mint ami ervenyben volt, es 2026-09-30-an
  // emiatt tortent egy atsorolas olyan felhatalmazassal, ami nem allt fenn.
  // A harom meglevo agens CLAUDE.md-jet 2026-10-06-an kezzel javitottak, a
  // GENERATOR viszont tovabb irta a regi mondatot.
  //
  // A szabaly, amit ez a teszt orzi: egy autonomia-szint EGY helyen el (a config),
  // a sablon szovege nem masolja, csak odakuld.
  it('nem eget be szamot egyetlen autonomia-kategoriahoz sem', () => {
    const kategoriak = [
      'memory_maintenance', 'kanban_archive_done', 'kanban_stuck_nudge',
      'routine_trivial_fix', 'deploy_retry', 'kanban_restructure', 'skill_patch',
      'email_send', 'publish_content', 'payment', 'data_delete',
      'permission_change', 'external_message',
    ]
    for (const k of kategoriak) {
      // "<kategoria> = level 3" es tarsai: a szint allitasa a szovegben.
      const beegetve = new RegExp(`${k}\\s*=\\s*level\\s*\\d`, 'i')
      expect(SRC, `a sablon beegeti a(z) ${k} szintjet`).not.toMatch(beegetve)
    }
  })

  it('a memoria-atsorolasnal a configra kuld, nem sajat allitast tesz', () => {
    expect(SRC).toContain('A SZINTET NE INNEN VEDD, HANEM A store/autonomy-config.json fájlból')
  })
})
