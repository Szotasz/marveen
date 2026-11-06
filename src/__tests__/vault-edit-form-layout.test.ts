import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

const rule = (selector: string) => {
  const i = CSS.indexOf(`${selector} {`)
  return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i))
}

describe('the Vault card edit form fits the card', () => {
  it('wraps, so Save and Cancel go under the inputs instead of past the card edge', () => {
    const form = rule('.vault-card-edit-form')
    expect(form, 'rule not found').not.toBe('')
    expect(form).toContain('flex-wrap: wrap')
    expect(rule('.vault-card-edit-form .input')).toContain('flex: 1 1 100%')
  })

  it('its fields and the Connectors Vault/Paths fields are styled, not the browser default', () => {
    const i = CSS.indexOf('.vault-card-edit-form .input,\n.connector-external-add .input {')
    expect(i, 'shared field rule not found').toBeGreaterThan(-1)
    const shared = CSS.slice(i, CSS.indexOf('}', i))
    for (const decl of ['min-width: 0', 'background: var(--bg-input)', 'border: 1px solid var(--border)', 'color: var(--text)']) {
      expect(shared).toContain(decl)
    }
  })

  it('the fields carry no inline bottom margin that would misalign the row', () => {
    const i = APP.indexOf("form.className = 'vault-card-edit-form'")
    expect(i).toBeGreaterThan(-1)
    const markup = APP.slice(i, APP.indexOf('card.appendChild(form)', i))
    expect(markup).not.toContain('margin-bottom')
  })
})

describe('.input has a base look', () => {
  it('a .input outside a styled container gets the theme colours, not the browser white box', () => {
    const at = CSS.indexOf('\n.input {')
    const base = at < 0 ? '' : CSS.slice(at, CSS.indexOf('}', at))
    expect(base, 'base .input rule not found').not.toBe('')
    for (const decl of ['background: var(--bg-input)', 'border: 1px solid var(--border)', 'color: var(--text)', 'font-family: inherit']) {
      expect(base).toContain(decl)
    }
    expect(base, 'no width: the base rule must not move any layout').not.toMatch(/(^|[\s;{])(width|min-width|max-width)\s*:/)
  })

  it('comes before the .form-group field rule, which stays more specific', () => {
    expect(CSS.indexOf('\n.input {')).toBeGreaterThan(-1)
    expect(CSS.indexOf('\n.input {')).toBeLessThan(CSS.indexOf('\n.form-group input,'))
  })
})
