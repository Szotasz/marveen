// The new-idea form answered an empty title with "Cím Hiba" (two keys glued together) and never looked at the save's
// answer: a failed save closed the modal and the typed idea was gone. Now the title field gets the focus and its own
// toast, and a failed save keeps the modal open with a toast.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const SAVE = (() => {
  const i = APP.indexOf('async function saveIdea(')
  const j = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || j < 0 ? '' : APP.slice(i, j)
})()

describe('the idea form', () => {
  it('the save handler was found', () => {
    expect(SAVE).not.toBe('')
  })

  it('an empty title gets the focus and its own toast, before any request', () => {
    const stop = SAVE.indexOf("if (!title) { document.getElementById('ideaTitleInput').focus(); showToast(t('ideas.form.title_required'), 'error'); return }")
    expect(stop).toBeGreaterThan(-1)
    expect(SAVE.slice(0, stop)).not.toMatch(/\bfetch\(/)
    expect(SAVE).not.toContain("t('common.title') + ' ' + t('common.error')")
  })

  it('a failed save shows the server\'s reason or a translated toast, and the modal stays open', () => {
    expect(SAVE).toContain("showToast(err.error || t('ideas.toast.save_error'), 'error')")
    expect(SAVE).toContain("catch { showToast(t('ideas.toast.save_error'), 'error'); return }")
    // the failed branch returns before the modal is closed
    expect(SAVE).toContain("showToast(err.error || t('ideas.toast.save_error'), 'error')\n      return\n    }")
    expect(SAVE.indexOf("closeModal(document.getElementById('ideaModalOverlay'))")).toBeGreaterThan(SAVE.indexOf('if (!res.ok) {'))
  })

  it('the keys are in both languages', () => {
    for (const key of ['ideas.form.title_required', 'ideas.toast.save_error']) {
      expect(HU, key).toContain(`'${key}':`)
      expect(EN, key).toContain(`'${key}':`)
    }
  })
})
