// MCPINFOBOX1002. The MCP page's info box told the owner that every sub-agent
// sees the claude.ai connectors "because it runs in the same HOME as the main
// session", and not to add such an MCP locally. Since the sub-agent isolation
// (fleet token + isolated CLAUDE_CONFIG_DIR) that is false, and it pointed a
// buyer away from the fix. Measured 2026-10-02 on this host: the available-tool
// list of the main agent and four team agents held zero mcp__claude_ai_* tools
// (all of them run on the fleet token here, MAIN_AGENT_ISOLATED_CONFIG=1).
//
// What this file guards:
//  1. the false claim does not come back, in either language or the HTML fallback;
//  2. the box names the two controls that ARE the fix, by their CURRENT labels,
//     so a renamed button cannot leave the box pointing at nothing.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
type Dict = Record<string, string>
let hu: Dict
let en: Dict

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = { _i18n: {} }
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: { hu: Dict; en: Dict } } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

const KEY = 'connectors.builtin.dedup_html'

describe('the MCP info box does not promise claude.ai connectors to team agents', () => {
  it('hu and en: no "same HOME" claim, and team agents are said NOT to see them', () => {
    expect(hu[KEY]).not.toMatch(/ugyanabban a HOME-ban|Minden sub-agent automatikusan látja/)
    expect(en[KEY]).not.toMatch(/same HOME|Every sub-agent sees them/)
    expect(hu[KEY]).toContain('ők nem látják a claude.ai connectorokat')
    expect(en[KEY]).toContain('they do not see claude.ai connectors')
  })

  it('the HTML fallback text matches the claim (no stale copy before i18n loads)', () => {
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf-8')
    const start = html.indexOf('id="connectorInfoBox"')
    const box = html.slice(start, html.indexOf('</div>', start))
    expect(start).toBeGreaterThan(0)
    expect(box).not.toMatch(/ugyanabban a HOME-ban/)
    expect(box).toContain('ők nem látják a claude.ai connectorokat')
  })

  it('names the fix by the CURRENT labels of the new-connector button and the assign field', () => {
    for (const [d, lang] of [[hu, 'hu'], [en, 'en']] as const) {
      expect(d['connectors.btn.new'], lang).toBeTruthy()
      expect(d['connectors.field.assign'], lang).toBeTruthy()
      expect(d[KEY], lang).toContain(`"${d['connectors.btn.new']}"`)
      expect(d[KEY], lang).toContain(`"${d['connectors.field.assign']}"`)
    }
  })
})
