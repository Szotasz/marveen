/**
 * The skill detail modal's inline editor (web/app.js). Cancel only hid the editor and kept the typed
 * text in it, and the close button closed the modal without a word, so an edit was dropped silently
 * (reported 2026-10-28). Now an edit that differs from the last loaded or saved content is unsaved:
 * Cancel and the close button ask first (confirmDialog, danger), a confirmed Cancel puts the saved
 * content back, and an unchanged editor closes without a question.
 *
 * The SHIPPED helpers run against a fake editor with confirmDialog injected; the wiring is pinned as
 * short source fragments (house idiom).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const helpersStart = APP.indexOf('let _skillDetailSavedContent')
const HELPERS = APP.slice(helpersStart, APP.indexOf('function _skillDetailExitEdit(', helpersStart))

function load(answer: boolean) {
  const editor = { hidden: true, value: '' }
  const confirmDialog = vi.fn(async () => answer)
  const document = { getElementById: (id: string) => (id === 'skillDetailEditor' ? editor : null) }
  const api = new Function('document', 'confirmDialog', 't', `${HELPERS}
    return { setSaved: (v) => { _skillDetailSavedContent = v }, has: _skillDetailHasUnsavedEdit, discard: _skillDetailConfirmDiscard }`,
  )(document, confirmDialog, (k: string) => k) as {
    setSaved: (v: string) => void; has: () => boolean; discard: () => Promise<boolean>
  }
  return { editor, confirmDialog, ...api }
}

describe('skill detail: an unsaved edit is not dropped silently', () => {
  it('the helpers are found', () => {
    expect(helpersStart).toBeGreaterThan(-1)
    expect(HELPERS).toContain('function _skillDetailHasUnsavedEdit(')
    expect(HELPERS).toContain('async function _skillDetailConfirmDiscard(')
  })

  it('not editing, or editing without a change: nothing is unsaved, no question', async () => {
    const d = load(false)
    d.setSaved('# Skill')
    d.editor.value = 'changed but not in edit mode'
    expect(d.has()).toBe(false)
    d.editor.hidden = false
    d.editor.value = '# Skill'
    expect(d.has()).toBe(false)
    await expect(d.discard()).resolves.toBe(true)
    expect(d.confirmDialog).not.toHaveBeenCalled()
  })

  it.each([[true], [false]])('a changed edit asks in a danger dialog, and its answer (%s) decides', async (answer) => {
    const d = load(answer)
    d.setSaved('# Skill')
    d.editor.hidden = false
    d.editor.value = '# Skill\nmore'
    expect(d.has()).toBe(true)
    await expect(d.discard()).resolves.toBe(answer)
    expect(d.confirmDialog).toHaveBeenCalledTimes(1)
    expect(d.confirmDialog).toHaveBeenCalledWith({
      title: 'skills.confirm.discard_edit_title',
      message: 'skills.confirm.discard_edit',
      okLabel: 'skills.confirm.discard_edit_ok',
      danger: true,
    })
  })

  it('Cancel asks first, and a confirmed Cancel puts the saved content back before leaving edit mode', () => {
    const i = APP.indexOf("cancelBtn.addEventListener('click', async () => {")
    expect(i).toBeGreaterThan(-1)
    const body = APP.slice(i, APP.indexOf('_skillDetailExitEdit()', i) + 1)
    const ask = body.indexOf('if (!(await _skillDetailConfirmDiscard())) return')
    const reset = body.indexOf('editor.value = _skillDetailSavedContent')
    expect(ask).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(ask)
  })

  it('the close button, the backdrop and Escape ask the skill editor\'s own question', () => {
    // They all close through requestOverlayClose, which asks the question the modal registered.
    expect(APP).toContain("document.getElementById('skillDetailClose').addEventListener('click', () => requestOverlayClose(skillDetailOverlay))")
    expect(APP).toContain('attachOverlayCloseGuard(skillDetailOverlay, _skillDetailConfirmDiscard)')
  })

  it('the saved content follows the loaded and the saved text', () => {
    expect(APP).toMatch(/if \(editor\) editor\.value = rawContent\s*\n\s*_skillDetailSavedContent = rawContent/)
    expect(APP).toMatch(/_skillDetailSavedContent = newContent\s*\n\s*_skillDetailExitEdit\(\)/)
  })

  it.each(['skills.confirm.discard_edit_title', 'skills.confirm.discard_edit', 'skills.confirm.discard_edit_ok'])(
    '%s is in both languages',
    (key) => {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    },
  )
})

// The global Escape handler, run against fake overlays. Before: it closed every active modal at once,
// so the skill editor's Escape dropped an edit without a question, and an Escape meant as the "no" of a
// confirmDialog also closed the modal under it (losing the input that dialog was protecting). Now it
// leaves Escape to an open dialog, and closes each modal through requestOverlayClose, which asks the
// modal's own question (for the skill editor, _skillDetailConfirmDiscard).
describe('Escape', () => {
  const start = APP.indexOf("document.addEventListener('keydown', async (e) => {\n  if (e.key !== 'Escape') return")
  const HANDLER = start < 0 ? '' : APP.slice(start, APP.indexOf('\n})\n', start) + 3)

  function run(opts: { dialogOpen: boolean; skillAnswer: boolean }) {
    const skill = { id: 'skillDetailOverlay', _closeCheck: vi.fn(async () => opts.skillAnswer) }
    const other = { id: 'cardModalOverlay', _closeCheck: vi.fn(async () => true) }
    let listener: ((e: { key: string }) => Promise<void>) | null = null
    const document = {
      addEventListener: (_ev: string, fn: (e: { key: string }) => Promise<void>) => { listener = fn },
      querySelector: (sel: string) => (sel === '.confirm-dialog' && opts.dialogOpen ? {} : null),
      querySelectorAll: () => [other, skill],
    }
    const closed: string[] = []
    // The SHIPPED requestOverlayClose, with closeModal recording.
    const rStart = APP.indexOf('async function requestOverlayClose(')
    const REQUEST = APP.slice(rStart, APP.indexOf('\n}\n', rStart) + 3)
    const closeModal = (o: { id: string }) => closed.push(o.id)
    const requestOverlayClose = new Function('closeModal', `${REQUEST}\nreturn requestOverlayClose`)(closeModal)
    new Function('document', 'closeModal', 'requestOverlayClose', HANDLER)(document, closeModal, requestOverlayClose)
    return { press: (key: string) => listener!({ key }), closed, skill }
  }

  it('the handler is found', () => {
    expect(HANDLER).toContain('requestOverlayClose(o)')
  })

  it('a confirmDialog on top: nothing under it is closed, nothing is asked', async () => {
    const r = run({ dialogOpen: true, skillAnswer: true })
    await r.press('Escape')
    expect(r.closed).toEqual([])
    expect(r.skill._closeCheck).not.toHaveBeenCalled()
  })

  it('the skill editor asks; a "no" keeps it open, other modals still close', async () => {
    const r = run({ dialogOpen: false, skillAnswer: false })
    await r.press('Escape')
    expect(r.skill._closeCheck).toHaveBeenCalledTimes(1)
    expect(r.closed).toEqual(['cardModalOverlay'])
  })

  it('a "yes" (or nothing unsaved) closes the skill modal too', async () => {
    const r = run({ dialogOpen: false, skillAnswer: true })
    await r.press('Escape')
    expect(r.closed).toEqual(['cardModalOverlay', 'skillDetailOverlay'])
  })

  it('another key does nothing', async () => {
    const r = run({ dialogOpen: false, skillAnswer: true })
    await r.press('Enter')
    expect(r.closed).toEqual([])
  })
})
