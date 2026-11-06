// The SSH keygen modal kept showing Generate after the key was made: its footer was hidden with
// the attribute, which .modal-footer's display:flex overrode. A second click sent the same label
// again. Now the footer can be hidden, and after a key is made it offers Close instead.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}
const OPEN = between(APP, 'function openSshKeygenModal(', ';(function wireSshKeygenModal()')
const WIRE = between(APP, ';(function wireSshKeygenModal()', '// --- SSH Info modal ---')
const SUCCESS = between(WIRE, "document.getElementById('sshKeygenResult').hidden = false", 'await loadSshKeys()')
const RESET = between(WIRE, 'function resetKeygenForm()', '})()')

describe('the SSH keygen modal offers Close after the key is made', () => {
  it('the parts were found', () => {
    for (const part of [OPEN, WIRE, SUCCESS, RESET]) expect(part).not.toBe('')
  })

  it('the footer has a hidden Close button with a lang key', () => {
    const footer = between(HTML, 'id="sshKeygenFooter"', '</div>')
    expect(footer).toContain('id="sshKeygenDoneBtn" hidden data-i18n="common.btn.close"')
  })

  it('after the key is made, Generate goes, Close shows and gets the focus', () => {
    expect(SUCCESS).toContain('submitBtn.hidden = true')
    expect(SUCCESS).toContain('doneBtn.hidden = false')
    expect(SUCCESS).toContain("document.getElementById('sshKeygenFooter').hidden = false")
    expect(SUCCESS).toContain('doneBtn.focus()')
  })

  it('Close closes the modal', () => {
    expect(WIRE).toContain("doneBtn.addEventListener('click', () => closeModal(overlay))")
  })

  it('opening the modal and a failed request bring Generate back', () => {
    expect(OPEN).toContain("document.getElementById('sshKeygenSubmitBtn').hidden = false")
    expect(OPEN).toContain("document.getElementById('sshKeygenDoneBtn').hidden = true")
    expect(RESET).toContain('submitBtn.hidden = false')
    expect(RESET).toContain('doneBtn.hidden = true')
  })
})
