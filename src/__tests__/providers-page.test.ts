// Settings > Providers (custom Anthropic-compatible endpoints) answered a missing field and a failed save with
// alert(), in hard-coded Hungarian. These tests pin that the form points at the field and says what is missing,
// and that a failed save shows a translated toast.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}
const SECTION = between(APP, 'async function renderProvidersContent(', '\n// The app\'s own confirmation dialog')
const SAVE = between(SECTION, "overlay.querySelector('#addProviderSaveBtn').addEventListener('click'", '\n}\n')
const hasKey = (lang: string, key: string) => lang.includes(`'${key}':`)

describe('the provider form says which field is missing', () => {
  it('the section and the save handler were found', () => {
    expect(SECTION).not.toBe('')
    expect(SAVE).not.toBe('')
  })

  it('no alert() is left in the section', () => {
    expect(SECTION).not.toMatch(/(^|[^.\w])alert\(/)
  })

  it('the first empty required field, in the form\'s order, gets the focus and its own toast, before any request', () => {
    const order = ["['#cpLabel', 'providers.form.label_required']", "['#cpId', 'providers.form.id_required']",
      "['#cpBaseUrl', 'providers.form.base_url_required']", "['#cpVaultKey', 'providers.form.vault_key_required']"]
    let last = -1
    for (const step of order) {
      const at = SAVE.indexOf(step)
      expect(at, step).toBeGreaterThan(last)
      last = at
    }
    expect(SAVE).toContain("(authHeader !== 'none' && !vaultKey) ? ['#cpVaultKey'")
    const stop = SAVE.indexOf('if (missing) { overlay.querySelector(missing[0]).focus(); showToast(t(missing[1])); return }')
    expect(stop).toBeGreaterThan(last)
    expect(SAVE.slice(0, stop)).not.toMatch(/\bfetch\(/)
  })

  it('a failed save shows the server\'s reason or a translated toast', () => {
    expect(SAVE).toContain("showToast(err.error || t('providers.toast.save_error'))")
    expect(SAVE).toContain("catch { showToast(t('providers.toast.save_error')) }")
  })

  it('the keys are in both languages', () => {
    for (const key of ['providers.form.label_required', 'providers.form.id_required', 'providers.form.base_url_required',
      'providers.form.vault_key_required', 'providers.toast.save_error']) {
      expect(hasKey(HU, key), key).toBe(true)
      expect(hasKey(EN, key), key).toBe(true)
    }
  })
})
