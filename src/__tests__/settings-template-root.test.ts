import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { assertSettingsRootSafe, settingsRootProblem } from '../web/settings-template-root.js'

// templates/settings.json.template wraps the project root in double quotes inside a JSON string (the token
// path of the PreCompact prompt's curl examples). Double quotes carry a space or an apostrophe; they do not carry
// $, a backtick, a double quote, a backslash or a newline. Such a root must fail LOUDLY at render time instead of
// producing a quietly broken command (a double quote or backslash also broke the JSON, silently dropping the hooks).
const SCAFFOLD = readFileSync(fileURLToPath(new URL('../web/agent-scaffold.ts', import.meta.url)), 'utf-8')

describe('settings.json.template: the project root it cannot carry', () => {
  const UNSUPPORTED: Record<string, string> = {
    'a dollar sign': '/home/u/$HOME/marveen',
    'a backtick': '/home/u/`id`/marveen',
    'a double quote': '/home/u/"quoted"/marveen',
    'a backslash': '/home/u/back\\slash/marveen',
    'a newline': '/home/u/line\nbreak/marveen',
  }
  for (const [name, root] of Object.entries(UNSUPPORTED)) {
    it(`refuses a root with ${name}, naming the character`, () => {
      expect(settingsRootProblem(root)).not.toBeNull()
      expect(() => assertSettingsRootSafe(root)).toThrowError(/settings\.json\.template: the project root .* contains /)
    })
  }

  const SUPPORTED: Record<string, string> = {
    'a plain path': '/home/u/marveen',
    'a space': '/home/u/my marveen',
    'an apostrophe': "/home/u/John's marveen",
    'a space and an apostrophe': "/home/u/pro ject's root",
    'non-ASCII letters': '/home/u/árvíztűrő/marveen',
  }
  for (const [name, root] of Object.entries(SUPPORTED)) {
    it(`accepts a root with ${name}`, () => {
      expect(settingsRootProblem(root)).toBeNull()
      expect(() => assertSettingsRootSafe(root)).not.toThrow()
    })
  }

  // The check is only worth anything if every place that renders the settings template goes through it.
  it('both settings.json.template render sites use the checked renderer', () => {
    const rendered = SCAFFOLD.match(/renderSettingsTemplate\(readFileSync\(tplPath/g) ?? []
    expect(rendered.length, 'ensureAgentHooks and the first-settings seed both render through renderSettingsTemplate').toBe(2)
    expect(SCAFFOLD).not.toMatch(/resolveTemplatePlaceholders\(readFileSync\(tplPath/)
  })

  it('the checked renderer asserts the root before substituting', () => {
    const fn = /export function renderSettingsTemplate\(raw: string\): string \{([\s\S]*?)\n\}/.exec(SCAFFOLD)
    expect(fn, 'renderSettingsTemplate is exported').not.toBeNull()
    expect(fn![1].indexOf('assertSettingsRootSafe(PROJECT_ROOT)')).toBeGreaterThanOrEqual(0)
    expect(fn![1].indexOf('assertSettingsRootSafe(PROJECT_ROOT)')).toBeLessThan(fn![1].indexOf('resolveTemplatePlaceholders('))
  })

  it('ensureAgentHooks logs a render failure instead of dropping the hooks silently', () => {
    expect(SCAFFOLD).toMatch(/settings\.json\.template not rendered; hooks NOT registered/)
  })
})
