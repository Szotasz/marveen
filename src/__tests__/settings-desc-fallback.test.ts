// #2228: the Settings page showed the raw `settings.desc.<KEY>` for every
// registry key without a translation, because t() answers a missing key with
// the key itself and `t(...) || def.description` therefore never fell back.
// The helper is pulled out of web/app.js and run against a t() with the same
// miss semantics; the call site and the registry side are pinned as strings
// and data, since no DOM test renders the Settings page.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

type Def = { key: string; description?: string }

function loadHelper(dict: Record<string, string>): (def: Def) => string {
  const src = APP.match(/\nfunction settingDescription\(def\) \{\n[\s\S]*?\n\}\n/)
  expect(src, 'settingDescription not found in web/app.js').toBeTruthy()
  // Same miss semantics as window.t: an unknown key comes back unchanged.
  const t = (key: string) => dict[key] ?? key
  return new Function('t', `${src![0]}\nreturn settingDescription`)(t) as (def: Def) => string
}

describe('settings description fallback (#2228)', () => {
  it('uses the registry description when the key has no translation', () => {
    const describe_ = loadHelper({})
    expect(describe_({ key: 'CLAUDE_PLAN_USAGE_REFRESH', description: 'Registry text' })).toBe('Registry text')
  })

  it('uses the translation when there is one', () => {
    const describe_ = loadHelper({ 'settings.desc.KANBAN_WIP_PLANNED': 'Translated' })
    expect(describe_({ key: 'KANBAN_WIP_PLANNED', description: 'Registry text' })).toBe('Translated')
  })

  it('never shows the raw key, even without a registry description', () => {
    const describe_ = loadHelper({})
    expect(describe_({ key: 'X' })).toBe('')
  })

  it('the settings row renders through the helper, and nothing else builds the key', () => {
    expect(APP).toMatch(/desc\.textContent = settingDescription\(def\)/)
    expect(APP.match(/'settings\.desc\.' \+/g) ?? []).toHaveLength(1)
  })

  it('every registry setting has a description to fall back to', () => {
    const empty = SETTINGS_REGISTRY.filter((s) => !s.description || !s.description.trim()).map((s) => s.key)
    expect(empty).toEqual([])
  })
})
