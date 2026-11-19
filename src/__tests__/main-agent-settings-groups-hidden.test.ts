// #2727: the agent detail modal is shared by the main agent and the sub-agents. The security profile and the
// Claude plan are per sub-agent settings: openMarveenDetail never fills their selects, so for the main agent
// they showed the value of the sub-agent opened before (or an empty select on a fresh load), above a Save
// button that returns early for role 'main'. applyMarveenReadonlyMode is the one hook both open paths run, so
// that is where the two groups are hidden. The function is pulled out of web/app.js and run against a small
// stand-in for the document; the markup side is pinned as strings, since no DOM test renders the modal.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

type El = { hidden: boolean; disabled: boolean; attrs: Record<string, string>; setAttribute(k: string, v: string): void; removeAttribute(k: string): void }
const el = (hidden = false): El => ({
  hidden, disabled: false, attrs: {},
  setAttribute(k, v) { this.attrs[k] = v },
  removeAttribute(k) { delete this.attrs[k] },
})

function load() {
  const src = APP.match(/\nfunction applyMarveenReadonlyMode\(readOnly\) \{\n[\s\S]*?\n\}\n/)
  expect(src, 'applyMarveenReadonlyMode not found in web/app.js').toBeTruthy()
  const ids = ['securityProfileGroup', 'claudePlanGroup', 'authModeGroup', 'memoryIsolationGroup', 'codeModeGroup', 'mainAuthGroup',
    'marveenReadonlyNote', 'editClaudeMd', 'editSoulMd', 'editMcpJson', 'editAgentModel',
    'saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn', 'saveModelBtn']
  const els: Record<string, El> = Object.fromEntries(ids.map((id) => [id, el()]))
  const teamTab = el()
  const document = {
    getElementById: (id: string) => els[id] ?? null,
    querySelector: (sel: string) => (sel.includes('data-tab="team"') ? teamTab : null),
  }
  let mainAuthLoads = 0
  const fn = new Function('document', 'loadMainAuthPanel', `${src![0]}\nreturn applyMarveenReadonlyMode`)(
    document, () => { mainAuthLoads++ },
  ) as (readOnly: boolean) => void
  return { fn, els, teamTab, loads: () => mainAuthLoads }
}

describe('main agent: per sub-agent settings groups are hidden (#2727)', () => {
  it('the main agent sees neither the security profile nor the Claude plan group', () => {
    const { fn, els } = load()
    fn(true)
    expect(els.securityProfileGroup.hidden).toBe(true)
    expect(els.claudePlanGroup.hidden).toBe(true)
  })

  it('a sub-agent opened AFTER the main agent gets both groups back', () => {
    const { fn, els } = load()
    fn(true)
    fn(false)
    expect(els.securityProfileGroup.hidden).toBe(false)
    expect(els.claudePlanGroup.hidden).toBe(false)
  })

  it('a sub-agent opened first shows both groups', () => {
    const { fn, els } = load()
    els.securityProfileGroup.hidden = true
    els.claudePlanGroup.hidden = true
    fn(false)
    expect(els.securityProfileGroup.hidden).toBe(false)
    expect(els.claudePlanGroup.hidden).toBe(false)
  })

  it('the rest of the main agent mode is what it was', () => {
    const { fn, els, teamTab, loads } = load()
    fn(true)
    expect(teamTab.hidden).toBe(true)
    expect(els.authModeGroup.hidden).toBe(true)
    expect(els.memoryIsolationGroup.hidden).toBe(true)
    expect(els.mainAuthGroup.hidden).toBe(false)
    expect(els.marveenReadonlyNote.hidden).toBe(false)
    expect(els.editAgentModel.disabled).toBe(true)
    expect(els.saveModelBtn.hidden).toBe(false)
    expect(els.saveModelBtn.disabled).toBe(true)
    expect(els.editClaudeMd.attrs.readonly).toBe('readonly')
    expect(loads()).toBe(1)
  })

  // CODEMODEFLAG1119: the Code Mode switch is a sub-agent setting (the main agent does not start through the launcher
  // that reads it), so it follows the memory-isolation group: hidden on the main agent card, back on a sub-agent.
  it('the Code Mode group: hidden for the main agent, shown again for a sub-agent', () => {
    const { fn, els } = load()
    fn(true)
    expect(els.codeModeGroup.hidden).toBe(true)
    fn(false)
    expect(els.codeModeGroup.hidden).toBe(false)
  })

  it('the Code Mode markup, the checkbox state and the PUT it sends', () => {
    const group = HTML.match(/<div class="form-group" id="codeModeGroup">[\s\S]*?<\/div>/)
    expect(group, 'codeModeGroup not found in web/index.html').toBeTruthy()
    expect(group![0]).toContain('<input type="checkbox" id="codeModeToggle">')
    expect(group![0]).toContain('data-i18n="agents.settings.code_mode_toggle"')
    expect(group![0]).toContain('data-i18n="agents.settings.code_mode_desc"')
    expect(HTML.match(/id="codeModeToggle"/g) ?? []).toHaveLength(1)
    expect(APP).toContain("if (codeModeToggle) codeModeToggle.checked = currentAgent.codeMode === true")
    const handler = APP.slice(APP.indexOf("document.getElementById('codeModeToggle').addEventListener('change'"))
    expect(handler.slice(0, 900)).toContain("if (!currentAgent || currentAgent.role === 'main') return")
    expect(handler.slice(0, 900)).toContain('body: JSON.stringify({ codeMode: enabled }),')
    expect(handler.slice(0, 900)).toContain('currentAgent.codeMode = enabled')
  })

  it('a missing group does not break the mode switch', () => {
    const { fn, els } = load()
    delete (els as Record<string, El | undefined>).securityProfileGroup
    expect(() => fn(true)).not.toThrow()
    expect(els.claudePlanGroup.hidden).toBe(true)
  })

  it('the markup: the group that holds the profile select and its Save button carries the id', () => {
    const group = HTML.match(/<div class="form-group" id="securityProfileGroup">[\s\S]*?<\/div>/)
    expect(group, 'securityProfileGroup not found in web/index.html').toBeTruthy()
    expect(group![0]).toContain('id="editAgentProfile"')
    expect(group![0]).toContain('id="saveProfileBtn"')
    expect(HTML.match(/id="securityProfileGroup"/g) ?? []).toHaveLength(1)
    expect(HTML.match(/id="claudePlanGroup"/g) ?? []).toHaveLength(1)
  })

  it('both open paths run the hook, and nothing else decides the visibility of the two groups', () => {
    expect(APP.match(/applyMarveenReadonlyMode\(true\)/g) ?? []).toHaveLength(1)
    expect(APP.match(/applyMarveenReadonlyMode\(false\)/g) ?? []).toHaveLength(1)
    expect(APP).not.toMatch(/getElementById\('claudePlanGroup'\)/)
    expect(APP).not.toMatch(/getElementById\('securityProfileGroup'\)/)
  })
})
