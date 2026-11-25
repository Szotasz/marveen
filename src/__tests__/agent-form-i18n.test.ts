// HOSTINGERI18NFU2: Hungarian text on the new-agent form of an English install, measured on a throwaway English
// instance after #3133. Each block pins one fix.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const HTML = read('../../web/index.html')

const loadDict = (lang: 'hu' | 'en'): Record<string, string> => {
  const sandbox = { window: {} as { _i18n?: Record<string, Record<string, string>> } }
  vm.runInNewContext(read(`../../web/lang/${lang}.js`), sandbox)
  return sandbox.window._i18n![lang]
}
const HU = loadDict('hu')
const EN = loadDict('en')

describe('the "or" divider between the avatar grid and the upload box', () => {
  it('both dividers (create form, edit panel) carry the key, none is raw text', () => {
    const dividers = [...HTML.matchAll(/<div class="avatar-upload-divider">(.*?)<\/div>/g)].map(m => m[1])
    expect(dividers).toHaveLength(2)
    for (const d of dividers) expect(d).toBe('<span data-i18n="agents.wizard.avatar_or">vagy</span>')
  })

  it('reads "or" in English and stays "vagy" in Hungarian', () => {
    expect(EN['agents.wizard.avatar_or']).toBe('or')
    expect(HU['agents.wizard.avatar_or']).toBe('vagy')
  })
})
