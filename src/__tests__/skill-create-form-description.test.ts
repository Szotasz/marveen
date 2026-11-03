/**
 * The dashboard's "new skill" form (web/app.js, saveSkillBtn). The server requires a description and
 * answers a missing one with an English 400 ("Skill description is required"), which the form showed
 * as a toast after a hard-coded "Hiba: " prefix; a missing name only moved the focus, so the button
 * seemed to do nothing. Now both are checked in the form the same way: the empty field gets the focus,
 * a translated toast says what is missing, and nothing is sent. Server errors that still reach the
 * toast carry the translated prefix.
 *
 * House idiom: read the frontend file as a string and assert short, formatting-proof fragments.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')
const start = APP.indexOf("document.getElementById('saveSkillBtn').addEventListener('click'")
const HANDLER = start < 0 ? '' : APP.slice(start, APP.indexOf('\n})\n', start))

describe('the new-skill form', () => {
  it('the handler is found', () => {
    expect(HANDLER.length).toBeGreaterThan(200)
  })

  it.each([
    ['name', 'skillName', 'skills.toast.name_required'],
    ['description', 'skillDescription', 'skills.toast.desc_required'],
  ])('an empty %s focuses its field, says so, and returns before the request', (field, id, key) => {
    const check = HANDLER.indexOf(`if (!${field}) {`)
    expect(check).toBeGreaterThan(-1)
    const block = HANDLER.slice(check, HANDLER.indexOf('return', check))
    expect(block).toContain(`document.getElementById('${id}').focus()`)
    expect(block).toContain(`showToast(t('${key}'))`)
    expect(HANDLER.slice(0, check)).not.toMatch(/\bfetch\(/)
    expect(HANDLER.indexOf('fetch(')).toBeGreaterThan(check)
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })

  it('the request sends the description that was checked', () => {
    expect(HANDLER).toMatch(/body: JSON\.stringify\(\{\s*name,\s*description,\s*\}\)/)
  })

  it('the error toast is translated, not a hard-coded "Hiba"', () => {
    expect(HANDLER).toContain("showToast(`${t('common.error')}: ${err.message}`)")
    expect(HANDLER).not.toContain('Hiba')
  })
})
