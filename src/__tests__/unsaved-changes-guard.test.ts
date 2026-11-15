// The modal close guard asks about unsaved CHANGES, not about any text in a field. It used to ask
// "Unsaved text" whenever a visible text field had content, so an edit modal (a card, a memory, a
// schedule), which opens filled, asked on every close even when nothing had been changed; so did the
// main agent's read-only settings. The guard now compares with what the fields held when the modal
// opened, skips read-only fields, and a save that keeps its modal open counts as the new baseline.
// The shipped functions run here against a small fake overlay.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU_SRC = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN_SRC = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

// A top-level function declaration, up to its closing brace at column 0.
function fn(name: string): string {
  const i = APP.indexOf(`\nfunction ${name}(`) >= 0 ? APP.indexOf(`\nfunction ${name}(`) : APP.indexOf(`\nasync function ${name}(`)
  if (i < 0) return ''
  return APP.slice(i + 1, APP.indexOf('\n}\n', i) + 2)
}
const SRC = ['openModal', 'unsavedInputFields', 'overlayHasUnsavedInput', 'markFieldSaved', 'confirmUnsavedInputClose', 'requestOverlayClose']
  .map(fn).join('\n')

type Field = { value: string; offsetParent: object | null; readOnly?: boolean; disabled?: boolean; closest?: (s: string) => unknown }

function setup(fields: Field[]) {
  const overlay: Record<string, unknown> = {
    classList: { add() {}, remove() {} },
    querySelectorAll: () => fields,
  }
  for (const f of fields) f.closest = (sel: string) => (sel === '.modal-overlay' ? overlay : null)
  const asked: string[] = []
  const closed: unknown[] = []
  const api = new Function('document', 'confirmDialog', 'closeModal', 't',
    `${SRC}\nreturn { openModal, markFieldSaved, requestOverlayClose, confirmUnsavedInputClose }`,
  )(
    { body: { style: {} } },
    async (o: { title: string }) => { asked.push(o.title); return false },
    (o: unknown) => { closed.push(o) },
    (k: string) => k,
  ) as {
    openModal: (o: unknown) => void
    markFieldSaved: (f: Field) => void
    requestOverlayClose: (o: unknown) => Promise<void>
    confirmUnsavedInputClose: (o: unknown) => Promise<boolean>
  }
  // As attachOverlayCloseGuard registers it by default; the dialog answers "no".
  overlay._closeCheck = () => api.confirmUnsavedInputClose(overlay)
  const close = async () => {
    asked.length = 0
    closed.length = 0
    await api.requestOverlayClose(overlay)
    return { asked: [...asked], closed: closed.length }
  }
  return { overlay, open: () => api.openModal(overlay), save: api.markFieldSaved, close }
}

const visible = (value: string, extra: Partial<Field> = {}): Field => ({ value, offsetParent: {}, ...extra })
const ASKS = { asked: ['common.confirm.unsaved_title'], closed: 0 }
const CLOSES = { asked: [], closed: 1 }

describe('the modal close guard asks about unsaved changes only', () => {
  it('the functions were found', () => {
    for (const name of ['openModal', 'unsavedInputFields', 'overlayHasUnsavedInput', 'markFieldSaved', 'confirmUnsavedInputClose', 'requestOverlayClose']) {
      expect(fn(name), name).not.toBe('')
    }
  })

  it('a new, empty form: closes at once; typed text asks', async () => {
    const title = visible('')
    const g = setup([title])
    g.open()
    expect(await g.close()).toEqual(CLOSES)
    title.value = 'half a card'
    expect(await g.close()).toEqual(ASKS)
  })

  it('an edit modal opened filled: closing it unchanged does not ask; a change does', async () => {
    const title = visible('Fix the login')
    const desc = visible('Steps to reproduce...')
    const g = setup([title, desc])
    g.open()
    expect(await g.close()).toEqual(CLOSES)
    desc.value = 'Steps to reproduce... and one more'
    expect(await g.close()).toEqual(ASKS)
    desc.value = 'Steps to reproduce...'
    expect(await g.close()).toEqual(CLOSES)
  })

  it('a read-only or disabled field never asks, even if it was filled after the modal opened', async () => {
    const claudeMd = visible('', { readOnly: true })
    const locked = visible('', { disabled: true })
    const g = setup([claudeMd, locked])
    g.open()
    claudeMd.value = '# Main agent instructions'
    locked.value = 'something'
    expect(await g.close()).toEqual(CLOSES)
  })

  it('a hidden field does not ask', async () => {
    const hidden = { value: '', offsetParent: null }
    const g = setup([hidden])
    g.open()
    hidden.value = 'typed on another tab'
    expect(await g.close()).toEqual(CLOSES)
  })

  it('after a save that keeps the modal open, the saved text no longer asks; a new change does', async () => {
    const soul = visible('old soul')
    const g = setup([soul])
    g.open()
    soul.value = 'new soul'
    expect(await g.close()).toEqual(ASKS)
    g.save(soul)
    expect(await g.close()).toEqual(CLOSES)
    soul.value = 'newer soul'
    expect(await g.close()).toEqual(ASKS)
  })

  it('a field that was not there at opening (added later) asks when it holds text, as before', async () => {
    const fields = [visible('')]
    const g = setup(fields)
    g.open()
    fields.push(visible('a subtask title'))
    expect(await g.close()).toEqual(ASKS)
  })

  it('without an opening snapshot (a modal never opened through openModal) it asks on any text, as before', async () => {
    const g = setup([visible('text')])
    expect(await g.close()).toEqual(ASKS)
  })

  it('every save in the agent settings that keeps the modal open marks its field saved', () => {
    for (const [anchor, field] of [
      ["document.getElementById('saveClaudeMdBtn').addEventListener('click'", "markFieldSaved(document.getElementById('editClaudeMd'))"],
      ["document.getElementById('saveSoulMdBtn').addEventListener('click'", "markFieldSaved(document.getElementById('editSoulMd'))"],
      ["document.getElementById('saveMcpJsonBtn').addEventListener('click'", "markFieldSaved(document.getElementById('editMcpJson'))"],
      ["document.getElementById('saveTeamBtn').addEventListener('click'", "markFieldSaved(document.getElementById('editTeamTagline'))"],
    ]) {
      const i = APP.indexOf(anchor)
      expect(i, anchor).toBeGreaterThan(-1)
      const body = APP.slice(i, APP.indexOf('\n})\n', i))
      const okAt = body.indexOf('if (!res.ok) throw new Error()')
      expect(okAt, anchor).toBeGreaterThan(-1)
      // Only after the server accepted it.
      expect(body.indexOf(field), anchor).toBeGreaterThan(okAt)
    }
    const m = APP.indexOf("const customModelInput = document.getElementById('editAgentModelCustomModelId')")
    const modelSave = APP.slice(m, APP.indexOf('} catch', m))
    expect(modelSave.indexOf('markFieldSaved(customModelInput)')).toBeGreaterThan(modelSave.indexOf('if (!res.ok) throw new Error()'))
  })

  it('the dialog says "unsaved changes" in both languages', () => {
    const window: { _i18n?: Record<string, Record<string, string>> } = {}
    new Function('window', `${HU_SRC}\n${EN_SRC}`)(window)
    const { hu, en } = window._i18n!
    expect(hu['common.confirm.unsaved_title']).toBe('Mentetlen módosítás')
    expect(hu['common.confirm.unsaved']).toBe('A módosításaid nincsenek elmentve. Biztosan bezárod mentés nélkül?')
    expect(en['common.confirm.unsaved_title']).toBe('Unsaved changes')
    expect(en['common.confirm.unsaved']).toBe('Your changes are not saved. Close without saving?')
    // The same title the skill editor's own question uses.
    expect(hu['common.confirm.unsaved_title']).toBe(hu['skills.confirm.discard_edit_title'])
    expect(en['common.confirm.unsaved_title']).toBe(en['skills.confirm.discard_edit_title'])
  })
})
