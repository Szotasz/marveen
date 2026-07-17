// String-contract guard for the standalone autonomy page removal (house idiom:
// reads frontend files as strings and asserts short, formatting-proof fragments).
// Guards that: (a) the sidebar no longer contains data-page="autonomy",
// (b) the settings-tab autonomy panel is intact (settingsAutonomyGrid present,
//     renderAutonomyContent wired, refresh button added), and
// (c) the removed i18n keys are gone while the rest of autonomy.* stays.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP  = readFileSync(join(__dirname, '../../web/app.js'),      'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'),  'utf-8')
const HU   = readFileSync(join(__dirname, '../../web/lang/hu.js'),  'utf-8')
const EN   = readFileSync(join(__dirname, '../../web/lang/en.js'),  'utf-8')

describe('standalone autonomy page removal', () => {
  it('sidebar has NO data-page="autonomy" nav item', () => {
    expect(HTML).not.toContain('data-page="autonomy"')
  })

  it('standalone autonomy page div is removed from HTML', () => {
    expect(HTML).not.toContain('id="autonomyPage"')
    expect(HTML).not.toContain('id="autonomyGrid"')
    expect(HTML).not.toContain('id="autonomyUpdatedAt"')
  })

  it('standalone page router entry and loader are removed from app.js', () => {
    expect(APP).not.toMatch(/pageId === 'autonomy'/)
    expect(APP).not.toMatch(/function loadAutonomy\(/)
    expect(APP).not.toContain("'autonomy: 'nav.autonomy'")
    expect(APP).not.toContain("autonomy: 'nav.autonomy'")
    expect(APP).not.toContain("autonomyPage: {")
    expect(APP).not.toContain("id='refreshAutonomyBtn'")
    expect(APP).not.toContain('id="refreshAutonomyBtn"')
  })

  it('renderAutonomyContent function is preserved in app.js', () => {
    expect(APP).toMatch(/async function renderAutonomyContent\(/)
    expect(APP).toContain('/api/autonomy')
  })

  it('settings tab autonomy panel has settingsAutonomyGrid and settingsAutonomyUpdatedAt', () => {
    expect(APP).toContain("grid.id = 'settingsAutonomyGrid'")
    expect(APP).toContain("footer.id = 'settingsAutonomyUpdatedAt'")
    expect(APP).toMatch(/renderAutonomyContent\(grid,\s*footer\)/)
  })

  it('settings tab autonomy panel has a refresh button wired to renderAutonomyContent', () => {
    expect(APP).toContain("refreshBtn.className = 'btn-secondary btn-compact'")
    expect(APP).toContain("t('common.btn.refresh')")
    expect(APP).toContain("refreshBtn.addEventListener('click', () => renderAutonomyContent(grid, footer))")
  })

  it('removed i18n keys are gone from both language files', () => {
    for (const src of [HU, EN]) {
      expect(src).not.toContain("'nav.autonomy'")
      expect(src).not.toContain("'autonomy.page_title'")
      expect(src).not.toContain("'autonomy.page_subtitle'")
    }
  })

  it('remaining autonomy.* i18n keys are intact in both language files', () => {
    for (const src of [HU, EN]) {
      expect(src).toContain("'autonomy.loading'")
      expect(src).toContain("'autonomy.level.2'")
      expect(src).toContain("'autonomy.level.3'")
    }
  })
})
