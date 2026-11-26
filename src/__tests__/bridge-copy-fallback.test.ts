// #3160: the Bridge pairing bundle's Copy button on plain http over a LAN IP. navigator.clipboard exists only in a
// secure context, so writeText threw there and the catch only selected the field: nothing was copied and nothing said
// so. The handler now falls back to execCommand('copy') on the selected field and, if that fails too, shows a message
// below the field; a page outside a secure context also shows a one-line hint. The behaviour itself is measured in a
// real browser on the LAN origin (PR description); this pins the order of the steps and the two text keys.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')

// The click handler of the bundle's Copy button, as written in bridgeEnrollFromUi.
function copyHandler(): string {
  const start = APP.indexOf("document.getElementById('authBridgeCopyBtn').addEventListener('click'")
  expect(start).toBeGreaterThan(-1)
  return APP.slice(start, APP.indexOf('refreshDeviceKeyList()', start))
}

describe('the Bridge bundle Copy button (#3160)', () => {
  it('tries the clipboard API first, then execCommand on the selected field, then shows the message', () => {
    const h = copyHandler()
    const write = h.indexOf('navigator.clipboard.writeText(data.bundle)')
    const select = h.indexOf("getElementById('authBridgeBundleVal').select()")
    const exec = h.indexOf("document.execCommand('copy')")
    const failed = h.indexOf("t('auth.bridge.copy_failed')")
    expect({ write, select, exec, failed }).toEqual({ write: expect.any(Number), select: expect.any(Number), exec: expect.any(Number), failed: expect.any(Number) })
    for (const at of [write, select, exec, failed]) expect(at).toBeGreaterThan(-1)
    expect(write).toBeLessThan(select)
    expect(select).toBeLessThan(exec)
    expect(exec).toBeLessThan(failed)
    // a successful fallback says so on the button, and the message element is shown only on failure
    expect(h.slice(exec, failed)).toContain("copyBtn.textContent = t('auth.devices.copied')")
    expect(h.slice(failed)).toContain('copyMsg.hidden = false')
  })

  it('renders the message element and the non-secure hint with the bundle', () => {
    const at = APP.indexOf('id="authBridgeCopyBtn"')
    const markup = APP.slice(at, APP.indexOf('addEventListener', at))
    expect(markup).toContain("window.isSecureContext ? '' :")
    expect(markup).toContain("t('auth.bridge.copy_insecure_hint')")
    expect(markup).toContain('id="authBridgeCopyMsg"')
  })

  it('both languages carry both keys; the Hungarian text has its accents', () => {
    for (const key of ['auth.bridge.copy_failed', 'auth.bridge.copy_insecure_hint']) {
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    }
    expect(HU).toMatch(/'auth\.bridge\.copy_failed':\s*'A másolás nem sikerült/)
    expect(EN).toMatch(/'auth\.bridge\.copy_failed':\s*'Copying failed/)
  })
})
